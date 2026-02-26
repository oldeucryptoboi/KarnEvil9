import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { ExtensionDriver } from "./extension.js";

// ── Helper: connect a fake extension to the bridge ────────────────

interface FakeExtension {
  ws: WebSocket;
  /** CDP messages received from driver (via CDPClient) */
  received: Array<{ id: number; method: string; params?: unknown }>;
  /** Send a bridge:hello to activate the driver */
  sendHello(tabId?: number, tabUrl?: string, tabTitle?: string): void;
  /** Auto-respond to CDP commands with success */
  autoRespond(handler: (msg: { id: number; method: string; params?: unknown }) => unknown): void;
  close(): void;
}

async function connectFakeExtension(port: number): Promise<FakeExtension> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  const received: FakeExtension["received"] = [];
  let responder: ((msg: { id: number; method: string; params?: unknown }) => unknown) | null = null;

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    // Only track CDP requests (have id + method)
    if (msg.id != null && msg.method) {
      received.push(msg);
      if (responder) {
        const result = responder(msg);
        if (result !== undefined) {
          ws.send(JSON.stringify({ id: msg.id, result }));
        }
      }
    }
  });

  return {
    ws,
    received,
    sendHello(tabId = 1, tabUrl = "https://example.com", tabTitle = "Example") {
      ws.send(JSON.stringify({ type: "bridge:hello", tabId, tabUrl, tabTitle }));
    },
    autoRespond(handler) {
      responder = handler;
    },
    close() {
      ws.close();
    },
  };
}

/** Default CDP responder that handles domain enables and standard queries */
function defaultCDPResponder(msg: { id: number; method: string; params?: unknown }): unknown {
  if (msg.method.endsWith(".enable")) return {};
  if (msg.method === "Runtime.evaluate") {
    const params = msg.params as Record<string, unknown> | undefined;
    if (params?.expression && String(params.expression).includes("JSON.stringify")) {
      return { result: { type: "string", value: '{"url":"https://example.com","title":"Example"}' } };
    }
    if (params?.expression && String(params.expression).includes("document.body.innerText")) {
      return { result: { type: "string", value: "Body text content" } };
    }
    return { result: { type: "string", value: "eval-result" } };
  }
  if (msg.method === "Page.navigate") return { frameId: "frame-1" };
  if (msg.method === "Page.captureScreenshot") return { data: "base64-png-data" };
  if (msg.method === "Input.dispatchMouseEvent") return {};
  if (msg.method === "Input.dispatchKeyEvent") return {};
  if (msg.method === "Input.insertText") return {};
  if (msg.method === "Runtime.callFunctionOn") return { result: { type: "undefined", value: undefined } };
  return {};
}

// ── Track drivers for cleanup ──────────────────────────────────────

let drivers: ExtensionDriver[] = [];

afterEach(async () => {
  for (const d of drivers) {
    await d.close().catch(() => {});
  }
  drivers = [];
});

async function createDriver(): Promise<ExtensionDriver> {
  const driver = new ExtensionDriver({ bridgePort: 0 });
  drivers.push(driver);
  await driver.startBridge();
  return driver;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("ExtensionDriver (bridge protocol)", () => {
  describe("lifecycle", () => {
    it("reports inactive before any extension connects", async () => {
      const driver = await createDriver();
      expect(driver.isActive()).toBe(false);
    });

    it("returns error when executing before extension connects", async () => {
      const driver = await createDriver();
      const result = await driver.execute({ action: "snapshot" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("No extension connected");
    });

    it("becomes active after bridge:hello", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();

      // Wait for the hello handshake to complete
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(true);

      ext.close();
    });

    it("becomes inactive when extension disconnects", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(true);

      ext.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(false);
    });

    it("becomes inactive on bridge:detached", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(true);

      ext.ws.send(JSON.stringify({ type: "bridge:detached", reason: "user" }));
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(false);

      ext.close();
    });

    it("closes cleanly", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      await driver.close();
      expect(driver.isActive()).toBe(false);
    });
  });

  describe("navigate", () => {
    it("navigates and returns url + title", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond((msg) => {
        const result = defaultCDPResponder(msg);
        // Simulate Page.domContentEventFired event after Page.navigate
        if (msg.method === "Page.navigate") {
          setTimeout(() => {
            ext.ws.send(JSON.stringify({ method: "Page.domContentEventFired", params: { timestamp: 1 } }));
          }, 10);
        }
        return result;
      });
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const result = await driver.execute({ action: "navigate", url: "https://example.com" });
      expect(result.success).toBe(true);
      expect(result.url).toBe("https://example.com");
      expect(result.title).toBe("Example");

      ext.close();
    });
  });

  describe("snapshot", () => {
    it("returns error when no extension (snapshot depends on cdp)", async () => {
      const driver = await createDriver();
      const result = await driver.execute({ action: "snapshot" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("No extension connected");
    });
  });

  describe("screenshot", () => {
    it("captures screenshot as base64 PNG", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const result = await driver.execute({ action: "screenshot" });
      expect(result.success).toBe(true);
      expect(result.screenshot_base64).toBe("base64-png-data");

      ext.close();
    });
  });

  describe("keyboard", () => {
    it("dispatches keyDown + keyUp", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const result = await driver.execute({ action: "keyboard", key: "Enter" });
      expect(result.success).toBe(true);

      // Verify keyDown and keyUp were sent (after domain enables)
      const keyMsgs = ext.received.filter((m) => m.method === "Input.dispatchKeyEvent");
      expect(keyMsgs).toHaveLength(2);
      expect(keyMsgs[0].params).toEqual({ type: "keyDown", key: "Enter" });
      expect(keyMsgs[1].params).toEqual({ type: "keyUp", key: "Enter" });

      ext.close();
    });
  });

  describe("evaluate", () => {
    it("evaluates JavaScript and returns result", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond((msg) => {
        if (msg.method === "Runtime.evaluate") {
          const params = msg.params as Record<string, unknown>;
          if (params?.expression === "2 + 40") {
            return { result: { type: "number", value: 42 } };
          }
        }
        return defaultCDPResponder(msg);
      });
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const result = await driver.execute({ action: "evaluate", script: "2 + 40" });
      expect(result.success).toBe(true);
      expect(result.result).toBe(42);

      ext.close();
    });

    it("returns error on evaluation exception", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond((msg) => {
        if (msg.method === "Runtime.evaluate") {
          const params = msg.params as Record<string, unknown>;
          if (params?.expression === "x.foo") {
            return {
              result: { type: "undefined" },
              exceptionDetails: { exceptionId: 1, text: "ReferenceError: x is not defined", lineNumber: 0, columnNumber: 0 },
            };
          }
        }
        return defaultCDPResponder(msg);
      });
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const result = await driver.execute({ action: "evaluate", script: "x.foo" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("ReferenceError");

      ext.close();
    });
  });

  describe("get_text", () => {
    it("gets full body text when no target", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const result = await driver.execute({ action: "get_text" });
      expect(result.success).toBe(true);
      expect(result.text).toBe("Body text content");

      ext.close();
    });
  });

  describe("unknown action", () => {
    it("returns error for unknown action", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const result = await driver.execute({ action: "fly" });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action: "fly"');

      ext.close();
    });
  });

  describe("wait", () => {
    it("returns error when no target provided", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const result = await driver.execute({ action: "wait" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("wait action requires a target");

      ext.close();
    });
  });

  describe("malformed WS messages", () => {
    it("ignores non-JSON messages without crashing", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);

      // Send garbage data before hello
      ext.ws.send("this is not json{{{");
      ext.ws.send(Buffer.from([0xff, 0xfe, 0x00]));

      // Now send a valid hello — driver should still work
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(true);

      ext.close();
    });
  });

  describe("connection replacement", () => {
    it("replaces an existing extension connection when a new one connects", async () => {
      const driver = await createDriver();

      // First extension connects
      const ext1 = await connectFakeExtension(driver.getBridgePort());
      ext1.autoRespond(defaultCDPResponder);
      ext1.sendHello();
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(true);

      // Second extension connects — should replace first
      const ext2 = await connectFakeExtension(driver.getBridgePort());
      ext2.autoRespond(defaultCDPResponder);
      ext2.sendHello();
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(true);

      // Close second — driver should go inactive
      ext2.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.isActive()).toBe(false);

      ext1.close();
    });
  });

  describe("getBridgePort", () => {
    it("returns the actual port when started with port 0", async () => {
      const driver = await createDriver();
      const port = driver.getBridgePort();
      expect(port).toBeGreaterThan(0);
    });

    it("throws when bridge not started", () => {
      const driver = new ExtensionDriver({ bridgePort: 0 });
      drivers.push(driver);
      expect(() => driver.getBridgePort()).toThrow("Bridge not started");
    });
  });

  describe("domain enables on hello", () => {
    it("sends Page, Runtime, DOM, Accessibility enable after bridge:hello", async () => {
      const driver = await createDriver();
      const ext = await connectFakeExtension(driver.getBridgePort());
      ext.autoRespond(defaultCDPResponder);
      ext.sendHello();
      await new Promise((r) => setTimeout(r, 100));

      const enableMethods = ext.received
        .filter((m) => m.method.endsWith(".enable"))
        .map((m) => m.method);

      expect(enableMethods).toContain("Page.enable");
      expect(enableMethods).toContain("Runtime.enable");
      expect(enableMethods).toContain("DOM.enable");
      expect(enableMethods).toContain("Accessibility.enable");

      ext.close();
    });
  });
});
