/**
 * Extension driver bridge protocol smoke test.
 * Exercises the full HTTP relay path:
 *   POST /actions → ExtensionDriver → bridge WS → fake extension → responses
 *
 * No real browser needed — a fake extension WS client responds to CDP commands.
 *
 * Run with:  pnpm --filter @openvger/browser-relay test -- relay.extension-smoke
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import WebSocket from "ws";
import { ExtensionDriver } from "./drivers/extension.js";
import { RelayServer } from "./server.js";

// ── Fake extension helper ────────────────────────────────────────

function defaultCDPResponder(msg: { id: number; method: string; params?: any }): unknown {
  if (msg.method.endsWith(".enable")) return {};
  if (msg.method === "Runtime.evaluate") {
    const expr = msg.params?.expression as string | undefined;
    if (expr?.includes("JSON.stringify")) {
      return { result: { type: "string", value: '{"url":"https://example.com/page","title":"Test Page"}' } };
    }
    if (expr?.includes("document.body.innerText")) {
      return { result: { type: "string", value: "Full body text" } };
    }
    if (expr === "2 + 2") {
      return { result: { type: "number", value: 4 } };
    }
    return { result: { type: "string", value: "eval-result" } };
  }
  if (msg.method === "Page.navigate") return { frameId: "frame-1" };
  if (msg.method === "Page.captureScreenshot") return { data: "c21va2UtYmFzZTY0LXBuZw==" };
  if (msg.method === "Input.dispatchMouseEvent") return {};
  if (msg.method === "Input.dispatchKeyEvent") return {};
  if (msg.method === "Input.insertText") return {};
  if (msg.method === "Runtime.callFunctionOn") return { result: { type: "undefined", value: undefined } };
  if (msg.method === "DOM.getDocument") return { root: { nodeId: 1 } };
  if (msg.method === "Accessibility.getFullAXTree") return { nodes: [] };
  return {};
}

// ── Test setup ───────────────────────────────────────────────────

const driver = new ExtensionDriver({ bridgePort: 0 });
const relay = new RelayServer({ port: 0, driver, driverName: "extension" });
let baseUrl: string;
let fakeExtWs: WebSocket;

beforeAll(async () => {
  await driver.startBridge();
  const bridgePort = driver.getBridgePort();

  // Start relay HTTP server
  const app = relay.getExpressApp();
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // Connect fake extension
  fakeExtWs = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
  await new Promise<void>((resolve) => fakeExtWs.on("open", resolve));

  // Set up CDP responder (includes Page.domContentEventFired for navigate)
  fakeExtWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id != null && msg.method) {
      const result = defaultCDPResponder(msg);
      if (result !== undefined) {
        fakeExtWs.send(JSON.stringify({ id: msg.id, result }));
      }
      // Simulate Page.domContentEventFired after Page.navigate
      if (msg.method === "Page.navigate") {
        setTimeout(() => {
          fakeExtWs.send(JSON.stringify({ method: "Page.domContentEventFired", params: { timestamp: 1 } }));
        }, 10);
      }
    }
  });

  // Send bridge:hello to activate driver
  fakeExtWs.send(JSON.stringify({
    type: "bridge:hello",
    tabId: 42,
    tabUrl: "https://example.com",
    tabTitle: "Test Page",
  }));

  // Wait for handshake
  await new Promise((r) => setTimeout(r, 200));
});

afterAll(async () => {
  fakeExtWs?.close();
  await relay.shutdown();
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function get(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return response.json();
}

// ── Tests ───────────────────────────────────────────────────────

describe("extension driver bridge smoke test", () => {
  it("health check returns ok with extension driver", async () => {
    const result = (await get("/health")) as any;
    expect(result.status).toBe("ok");
    expect(result.driver).toBe("extension");
    expect(result.browser_active).toBe(true);
  });

  it("navigates to a URL", async () => {
    const result = (await post("/actions", {
      action: "navigate",
      url: "https://example.com/page",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.title).toBe("Test Page");
  });

  it("captures screenshot as base64 PNG", async () => {
    const result = (await post("/actions", { action: "screenshot" })) as any;
    expect(result.success).toBe(true);
    expect(result.screenshot_base64.length).toBeGreaterThan(10);
  });

  it("sends keyboard input", async () => {
    const result = (await post("/actions", {
      action: "keyboard",
      key: "Tab",
    })) as any;
    expect(result.success).toBe(true);
  });

  it("evaluates JavaScript", async () => {
    const result = (await post("/actions", {
      action: "evaluate",
      script: "2 + 2",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.result).toBe(4);
  });

  it("gets body text", async () => {
    const result = (await post("/actions", { action: "get_text" })) as any;
    expect(result.success).toBe(true);
    expect(result.text).toBe("Full body text");
  });

  it("returns error for unknown action", async () => {
    const result = (await post("/actions", { action: "fly" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });

  it("closes the driver", async () => {
    const result = (await post("/close", {})) as any;
    expect(result.closed).toBe(true);
  });

  it("health confirms inactive after close", async () => {
    const result = (await get("/health")) as any;
    expect(result.browser_active).toBe(false);
  });
});
