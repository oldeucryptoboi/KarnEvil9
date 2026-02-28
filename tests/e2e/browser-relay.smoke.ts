/**
 * Browser Relay E2E smoke tests.
 *
 * Validates the ExtensionDriver bridge lifecycle, CDPClient bridge mode,
 * and RelayServer HTTP layer — all without requiring a real browser.
 * Uses `ws` WebSocket mocks and ephemeral port 0 to avoid conflicts.
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { ExtensionDriver } from "@karnevil9/browser-relay";
import { RelayServer } from "@karnevil9/browser-relay";

// ── Shared cleanup tracking ───────────────────────────────────────────

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Run cleanups in reverse order (LIFO)
  for (const fn of cleanups.reverse()) {
    await fn().catch(() => {});
  }
  cleanups.length = 0;
});

// ── Helper: wait for a condition with timeout ─────────────────────────

async function waitFor(
  fn: () => boolean,
  timeoutMs = 3000,
  pollMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ── Helper: simulate a CDP-compliant extension that auto-replies ──────

function createAutoReplyCDPHandler(ws: WebSocket): void {
  ws.on("message", (data) => {
    let msg: { id?: number; method?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Auto-respond to CDP enable commands with empty result
    if (msg.id !== undefined) {
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    }
  });
}

// ── 1. ExtensionDriver bridge lifecycle ───────────────────────────────

describe("ExtensionDriver bridge lifecycle", () => {
  it("start bridge, extension connects with bridge:hello, isActive becomes true, bridge:detached makes it false", async () => {
    const driver = new ExtensionDriver({ bridgePort: 0 });
    await driver.startBridge();
    const port = driver.getBridgePort();
    expect(port).toBeGreaterThan(0);

    cleanups.push(async () => {
      await driver.close();
    });

    // Driver starts inactive
    expect(driver.isActive()).toBe(false);

    // Simulate extension connecting
    const extWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      extWs.on("open", resolve);
      extWs.on("error", reject);
    });

    cleanups.push(async () => {
      if (extWs.readyState === WebSocket.OPEN) {
        extWs.close();
      }
    });

    // Attach auto-reply handler so CDPClient.connect() + domain enables succeed
    createAutoReplyCDPHandler(extWs);

    // Send bridge:hello — triggers CDPClient creation and domain enables
    extWs.send(JSON.stringify({
      type: "bridge:hello",
      tabId: 1,
      tabUrl: "https://example.com",
      tabTitle: "Test Tab",
    }));

    // Wait for isActive to become true
    await waitFor(() => driver.isActive(), 5000);
    expect(driver.isActive()).toBe(true);

    // Send bridge:detached — should deactivate
    extWs.send(JSON.stringify({
      type: "bridge:detached",
      reason: "tab closed",
    }));

    await waitFor(() => !driver.isActive(), 3000);
    expect(driver.isActive()).toBe(false);
  });

  it("isActive becomes false when extension WebSocket closes", async () => {
    const driver = new ExtensionDriver({ bridgePort: 0 });
    await driver.startBridge();
    const port = driver.getBridgePort();

    cleanups.push(async () => {
      await driver.close();
    });

    const extWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      extWs.on("open", resolve);
      extWs.on("error", reject);
    });

    createAutoReplyCDPHandler(extWs);

    extWs.send(JSON.stringify({
      type: "bridge:hello",
      tabId: 1,
      tabUrl: "https://example.com",
      tabTitle: "Test",
    }));

    await waitFor(() => driver.isActive(), 5000);
    expect(driver.isActive()).toBe(true);

    // Close the WebSocket from the extension side
    extWs.close();

    await waitFor(() => !driver.isActive(), 3000);
    expect(driver.isActive()).toBe(false);
  });
});

// ── 2. ExtensionDriver execute without connection ─────────────────────

describe("ExtensionDriver execute without connection", () => {
  it("returns error when no extension is connected", async () => {
    const driver = new ExtensionDriver({ bridgePort: 0 });
    await driver.startBridge();

    cleanups.push(async () => {
      await driver.close();
    });

    const result = await driver.execute({ action: "snapshot" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("No extension connected");
  });

  it("returns error for any action without extension", async () => {
    const driver = new ExtensionDriver({ bridgePort: 0 });
    await driver.startBridge();

    cleanups.push(async () => {
      await driver.close();
    });

    const actions = ["navigate", "click", "fill", "screenshot", "evaluate"];
    for (const action of actions) {
      const result = await driver.execute({ action });
      expect(result.success).toBe(false);
      expect(result.error).toBe("No extension connected");
    }
  });
});

// ── 3. ExtensionDriver handles duplicate connections ──────────────────

describe("ExtensionDriver duplicate connections", () => {
  it("second connection replaces the first, first gets disconnected", async () => {
    const driver = new ExtensionDriver({ bridgePort: 0 });
    await driver.startBridge();
    const port = driver.getBridgePort();

    cleanups.push(async () => {
      await driver.close();
    });

    // First extension connects
    const ext1 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ext1.on("open", resolve);
      ext1.on("error", reject);
    });
    createAutoReplyCDPHandler(ext1);

    ext1.send(JSON.stringify({
      type: "bridge:hello",
      tabId: 1,
      tabUrl: "https://one.com",
      tabTitle: "Tab 1",
    }));

    await waitFor(() => driver.isActive(), 5000);
    expect(driver.isActive()).toBe(true);

    // Track first connection close
    let ext1Closed = false;
    ext1.on("close", () => { ext1Closed = true; });

    // Second extension connects — should replace first
    const ext2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ext2.on("open", resolve);
      ext2.on("error", reject);
    });

    cleanups.push(async () => {
      if (ext2.readyState === WebSocket.OPEN) ext2.close();
    });

    createAutoReplyCDPHandler(ext2);

    ext2.send(JSON.stringify({
      type: "bridge:hello",
      tabId: 2,
      tabUrl: "https://two.com",
      tabTitle: "Tab 2",
    }));

    // Wait for second connection to become active
    await waitFor(() => driver.isActive(), 5000);
    expect(driver.isActive()).toBe(true);

    // First connection should have been closed by the driver
    await waitFor(() => ext1Closed, 3000);
    expect(ext1Closed).toBe(true);

    // Closing ext2 should deactivate
    ext2.close();
    await waitFor(() => !driver.isActive(), 3000);
    expect(driver.isActive()).toBe(false);
  });
});

// ── 4. CDPClient bridge mode lifecycle ────────────────────────────────

describe("CDPClient bridge mode", () => {
  it("connect, send command, receive result, disconnect lifecycle", async () => {
    // We import CDPClient from the built dist directly since it is not
    // re-exported from the package index.
    const { CDPClient } = await import(
      "../../packages/browser-relay/dist/drivers/cdp/client.js"
    );

    // Create a mock server to act as the bridge peer
    const mockServer = new WebSocketServer({ port: 0 });
    const serverReady = new Promise<void>((resolve) => {
      mockServer.on("listening", resolve);
    });
    await serverReady;

    const addr = mockServer.address() as { port: number };
    const serverPort = addr.port;

    cleanups.push(async () => {
      mockServer.close();
    });

    // Server echoes results for any CDP command
    mockServer.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined) {
          ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
        }
      });
    });

    // Create a raw WebSocket and pass it to CDPClient as bridge mode
    const rawWs = new WebSocket(`ws://127.0.0.1:${serverPort}`);
    await new Promise<void>((resolve) => rawWs.on("open", resolve));

    cleanups.push(async () => {
      if (rawWs.readyState === WebSocket.OPEN) rawWs.close();
    });

    const client = new CDPClient({ ws: rawWs });
    expect(client.connected).toBe(false);

    await client.connect();
    expect(client.connected).toBe(true);

    // Send a command and get a result
    const result = await client.send("Page.enable");
    expect(result).toEqual({ ok: true });

    await client.disconnect();
    expect(client.connected).toBe(false);
  });

  it("pending requests are rejected on disconnect", async () => {
    const { CDPClient } = await import(
      "../../packages/browser-relay/dist/drivers/cdp/client.js"
    );

    // Server that never responds
    const mockServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      mockServer.on("listening", resolve);
    });

    const addr = mockServer.address() as { port: number };

    cleanups.push(async () => {
      mockServer.close();
    });

    // Server accepts but never replies
    mockServer.on("connection", () => { /* silence */ });

    const rawWs = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    await new Promise<void>((resolve) => rawWs.on("open", resolve));

    const client = new CDPClient({ ws: rawWs, requestTimeoutMs: 10000 });
    await client.connect();

    // Fire a command that will never get a reply
    const pendingPromise = client.send("Page.enable");

    // Small delay to ensure the request is queued
    await new Promise((r) => setTimeout(r, 50));

    // Disconnect should reject the pending request
    await client.disconnect();

    await expect(pendingPromise).rejects.toThrow(/disconnect/i);
  });

  it("events are received in bridge mode", async () => {
    const { CDPClient } = await import(
      "../../packages/browser-relay/dist/drivers/cdp/client.js"
    );

    const mockServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      mockServer.on("listening", resolve);
    });

    const addr = mockServer.address() as { port: number };
    let serverWs: WebSocket | null = null;

    cleanups.push(async () => {
      mockServer.close();
    });

    mockServer.on("connection", (ws) => {
      serverWs = ws as unknown as WebSocket;
    });

    const rawWs = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    await new Promise<void>((resolve) => rawWs.on("open", resolve));

    const client = new CDPClient({ ws: rawWs });
    await client.connect();

    const eventPromise = client.waitForEvent("Page.loadEventFired", 3000);

    // Give connection time to stabilize
    await new Promise((r) => setTimeout(r, 50));

    serverWs!.send(JSON.stringify({
      method: "Page.loadEventFired",
      params: { timestamp: 42 },
    }));

    const event = await eventPromise;
    expect(event.timestamp).toBe(42);

    await client.disconnect();
  });
});

// ── 5. RelayServer lifecycle ──────────────────────────────────────────

describe("RelayServer lifecycle", () => {
  it("starts on ephemeral port, serves health, rejects actions without browser, shuts down", async () => {
    // Create an ExtensionDriver (no browser connected) as the driver
    const driver = new ExtensionDriver({ bridgePort: 0 });
    await driver.startBridge();

    const server = new RelayServer({
      port: 0,
      driver,
      driverName: "extension",
    });

    // RelayServer.listen() uses the configured port. Since port 0 goes
    // through Express/Node, we need to get the actual port after listen.
    // The server stores it internally. We can get it from the Express app.
    await server.listen();

    cleanups.push(async () => {
      await server.shutdown();
    });

    // Get the actual port from the underlying HTTP server
    const app = server.getExpressApp();
    // The server object is private, so we fetch health via a different approach:
    // We'll access the address from the internal server. Since RelayServer doesn't
    // expose the port, we find it via a workaround.
    // Actually, re-reading server.ts, the port is set in constructor but listen()
    // uses this.port which will be 0. The actual port is on this.server.address().
    // Since this.server is private, we need to use a known port instead.

    // Let's restart with a known ephemeral port via the Express app directly.
    await server.shutdown();

    // Re-create with a random high port
    const port = 40000 + Math.floor(Math.random() * 10000);
    const driver2 = new ExtensionDriver({ bridgePort: 0 });
    await driver2.startBridge();

    const server2 = new RelayServer({
      port,
      driver: driver2,
      driverName: "extension",
    });
    await server2.listen();

    cleanups.push(async () => {
      await server2.shutdown();
    });

    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json() as {
      status: string;
      driver: string;
      browser_active: boolean;
      uptime_ms: number;
    };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.driver).toBe("extension");
    expect(healthBody.browser_active).toBe(false);
    expect(healthBody.uptime_ms).toBeGreaterThanOrEqual(0);

    // 2. POST /actions without browser should return 422 (driver returns success:false)
    const actionRes = await fetch(`http://127.0.0.1:${port}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "snapshot" }),
    });
    expect(actionRes.status).toBe(422);
    const actionBody = await actionRes.json() as { success: boolean; error: string };
    expect(actionBody.success).toBe(false);
    expect(actionBody.error).toBe("No extension connected");

    // 3. POST /actions with malformed body should return 400
    const badRes = await fetch(`http://127.0.0.1:${port}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(badRes.status).toBe(400);
    const badBody = await badRes.json() as { success: boolean; error: string };
    expect(badBody.success).toBe(false);
    expect(badBody.error).toContain("action");

    // 4. POST /close should close the driver
    const closeRes = await fetch(`http://127.0.0.1:${port}/close`, {
      method: "POST",
    });
    expect(closeRes.status).toBe(200);
    const closeBody = await closeRes.json() as { closed: boolean };
    expect(closeBody.closed).toBe(true);
  });
});
