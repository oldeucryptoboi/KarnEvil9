/**
 * ExtensionDriver — CDP bridge-backed browser driver.
 * The Chrome extension connects outbound to this driver's bridge WS server,
 * proxying CDP commands via chrome.debugger API. No --remote-debugging-port needed.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { BrowserDriver, ActionRequest, ActionResult, Target } from "./types.js";
import { CDPClient } from "./cdp/client.js";
import { resolveTarget, callOnElement, getBoundingRect } from "./cdp/target-resolver.js";
import { buildAriaSnapshot } from "./cdp/aria-snapshot.js";

export interface ExtensionDriverOptions {
  bridgePort?: number;
  snapshotMaxChars?: number;
}

interface BridgeHello {
  type: "bridge:hello";
  tabId: number;
  tabUrl: string;
  tabTitle: string;
}

interface BridgeDetached {
  type: "bridge:detached";
  reason: string;
}


export class ExtensionDriver implements BrowserDriver {
  private cdp: CDPClient | null = null;
  private readonly bridgePort: number;
  private readonly snapshotMaxChars: number;
  private wss: WebSocketServer | null = null;
  private extensionWs: WebSocket | null = null;
  private _active = false;

  constructor(options?: ExtensionDriverOptions) {
    this.bridgePort = options?.bridgePort ?? 9225;
    this.snapshotMaxChars = options?.snapshotMaxChars ?? 8000;
  }

  isActive(): boolean {
    return this._active && this.cdp !== null && this.cdp.connected;
  }

  /** Start the bridge WebSocket server. Must be called before execute(). */
  async startBridge(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.bridgePort }, () => {
        resolve();
      });

      this.wss.on("error", (err) => {
        reject(err);
      });

      this.wss.on("connection", (ws) => {
        this.handleExtensionConnection(ws);
      });
    });
  }

  /** Get the actual bridge port (useful when started with port 0). */
  getBridgePort(): number {
    if (!this.wss) {
      throw new Error("Bridge not started");
    }
    const addr = this.wss.address();
    if (typeof addr === "object" && addr) {
      return addr.port;
    }
    return this.bridgePort;
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const { action, ...params } = request;

    if (!this._active || !this.cdp || !this.cdp.connected) {
      return { success: false, error: "No extension connected" };
    }

    try {
      switch (action) {
        case "navigate": {
          const url = params.url as string;

          await this.cdp.send("Page.enable");
          const navPromise = this.cdp.send("Page.navigate", { url });
          const loadPromise = this.cdp.waitForEvent("Page.domContentEventFired", 30000);
          await navPromise;
          await loadPromise;

          const { title, currentUrl } = await this.getPageInfo();
          return { success: true, url: currentUrl, title };
        }

        case "snapshot": {
          const snapshot = await buildAriaSnapshot(this.cdp, this.snapshotMaxChars);
          const { title, currentUrl } = await this.getPageInfo();
          return { success: true, url: currentUrl, title, snapshot };
        }

        case "click": {
          const element = await resolveTarget(this.cdp, params.target as Target);
          await callOnElement(this.cdp, element, "function() { this.click(); }", false);
          const { title, currentUrl } = await this.getPageInfo();
          return { success: true, element_found: true, url: currentUrl, title };
        }

        case "fill": {
          const element = await resolveTarget(this.cdp, params.target as Target);
          const value = params.value as string;

          await callOnElement(this.cdp, element, "function() { this.focus(); this.value = ''; }", false);
          await this.cdp.send("Input.insertText", { text: value });
          await callOnElement(
            this.cdp,
            element,
            `function() {
              this.dispatchEvent(new Event('input', { bubbles: true }));
              this.dispatchEvent(new Event('change', { bubbles: true }));
            }`,
            false,
          );
          return { success: true, element_found: true };
        }

        case "select": {
          const element = await resolveTarget(this.cdp, params.target as Target);
          const value = params.value as string;
          await callOnElement(
            this.cdp,
            element,
            `function() {
              this.value = ${JSON.stringify(value)};
              this.dispatchEvent(new Event('change', { bubbles: true }));
            }`,
            false,
          );
          return { success: true, element_found: true };
        }

        case "hover": {
          const element = await resolveTarget(this.cdp, params.target as Target);
          const rect = await getBoundingRect(this.cdp, element);
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          await this.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x,
            y,
          });
          return { success: true, element_found: true };
        }

        case "keyboard": {
          const key = params.key as string;
          await this.cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
          });
          await this.cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
          });
          return { success: true };
        }

        case "screenshot": {
          const result = await this.cdp.send("Page.captureScreenshot", {
            format: "png",
          });
          return { success: true, screenshot_base64: result.data };
        }

        case "get_text": {
          const target = params.target as Target | undefined;
          if (target) {
            const element = await resolveTarget(this.cdp, target);
            const text = await callOnElement<string | null>(
              this.cdp,
              element,
              "function() { return this.textContent; }",
            );
            return { success: true, element_found: true, text: text ?? "" };
          }
          const result = await this.cdp.send("Runtime.evaluate", {
            expression: "document.body.innerText",
            returnByValue: true,
          });
          return { success: true, text: (result.result?.value as string) ?? "" };
        }

        case "evaluate": {
          const script = params.script as string;
          const result = await this.cdp.send("Runtime.evaluate", {
            expression: script,
            returnByValue: true,
            awaitPromise: true,
          });
          if (result.exceptionDetails) {
            return { success: false, error: result.exceptionDetails.text };
          }
          return { success: true, result: result.result?.value };
        }

        case "wait": {
          const target = params.target as Target | undefined;
          if (!target) {
            return { success: false, error: "wait action requires a target" };
          }
          const timeout = (params.timeout_ms as number) ?? 5000;
          const start = Date.now();
          const pollInterval = 200;

          while (Date.now() - start < timeout) {
            try {
              await resolveTarget(this.cdp, target);
              return { success: true, element_found: true };
            } catch {
              await new Promise((r) => setTimeout(r, pollInterval));
            }
          }
          return {
            success: false,
            element_found: false,
            error: `Timeout waiting for element: ${JSON.stringify(target)}`,
          };
        }

        default:
          return { success: false, error: `Unknown action: "${action}"` };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const elementNotFound =
        message.includes("Element not found") ||
        message.includes("resolved to") ||
        message.includes("not found for target");
      return {
        success: false,
        ...(elementNotFound ? { element_found: false } : {}),
        error: message,
      };
    }
  }

  async close(): Promise<void> {
    this._active = false;
    if (this.cdp) {
      await this.cdp.disconnect();
      this.cdp = null;
    }
    if (this.extensionWs) {
      this.extensionWs.close();
      this.extensionWs = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private handleExtensionConnection(ws: WebSocket): void {
    // If there's an existing extension connection, close it
    if (this.extensionWs) {
      this.extensionWs.close();
      this.extensionWs = null;
      if (this.cdp) {
        this.cdp.disconnect().catch(() => {});
        this.cdp = null;
      }
      this._active = false;
    }

    this.extensionWs = ws;

    ws.on("message", (data) => {
      // Guard: ignore messages from a stale WebSocket
      if (this.extensionWs !== ws) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // Ignore malformed messages
      }
      if (msg.type === "bridge:hello") {
        this.handleBridgeHello(ws, msg as unknown as BridgeHello);
      } else if (msg.type === "bridge:detached") {
        this.handleBridgeDetached(msg as unknown as BridgeDetached);
      }
      // Other messages are CDP responses/events handled by CDPClient
    });

    ws.on("close", () => {
      // Guard: only clean up if this is still the active WebSocket
      if (this.extensionWs !== ws) return;
      this._active = false;
      this.extensionWs = null;
      if (this.cdp) {
        this.cdp.disconnect().catch(() => {});
        this.cdp = null;
      }
    });
  }

  private async handleBridgeHello(ws: WebSocket, _msg: BridgeHello): Promise<void> {
    // Clean up previous CDPClient (e.g. from duplicate hello on same WS)
    if (this.cdp) {
      this._active = false;
      await this.cdp.disconnect();
      this.cdp = null;
    }

    // Create CDPClient in bridge mode using this WebSocket
    this.cdp = new CDPClient({ ws: ws as unknown as import("ws").default });
    await this.cdp.connect();

    // Enable required domains
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("DOM.enable");
    await this.cdp.send("Accessibility.enable");

    this._active = true;
  }

  private handleBridgeDetached(_msg: BridgeDetached): void {
    this._active = false;
    if (this.cdp) {
      this.cdp.disconnect().catch(() => {});
      this.cdp = null;
    }
  }

  private async getPageInfo(): Promise<{ currentUrl: string; title: string }> {
    if (!this.cdp) throw new Error("No extension connected");
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: "JSON.stringify({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    let info: { url: string; title: string };
    try {
      info = JSON.parse((result.result?.value ?? "{}") as string);
    } catch {
      throw new Error("Failed to parse page info from extension");
    }
    return { currentUrl: info.url, title: info.title };
  }
}
