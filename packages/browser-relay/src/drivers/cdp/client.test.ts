import { describe, it, expect, afterEach } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { CDPClient } from "./client.js";

// ── Helper: create a mock CDP WebSocket server ──────────────────────

function createMockCDPServer(): {
  wss: WebSocketServer;
  port: number;
  url: string;
  ready: Promise<void>;
} {
  const wss = new WebSocketServer({ port: 0 });
  const ready = new Promise<void>((resolve) => {
    wss.on("listening", resolve);
  });
  const port = (wss.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}`;
  return { wss, port, url, ready };
}

let servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const s of servers) {
    s.close();
  }
  servers = [];
});

// ── Tests ───────────────────────────────────────────────────────────

describe("CDPClient", () => {
  it("connects to a WebSocket URL and reports connected", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    const client = new CDPClient({ wsUrl: url });
    expect(client.connected).toBe(false);
    await client.connect();
    expect(client.connected).toBe(true);
    await client.disconnect();
    expect(client.connected).toBe(false);
  });

  it("sends a command and receives a result", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "Runtime.evaluate") {
          ws.send(JSON.stringify({
            id: msg.id,
            result: {
              result: { type: "string", value: "hello" },
            },
          }));
        }
      });
    });

    const client = new CDPClient({ wsUrl: url });
    await client.connect();

    const result = await client.send("Runtime.evaluate", {
      expression: "'hello'",
      returnByValue: true,
    });
    expect(result).toEqual({
      result: { type: "string", value: "hello" },
    });

    await client.disconnect();
  });

  it("rejects on CDP error response", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        }));
      });
    });

    const client = new CDPClient({ wsUrl: url });
    await client.connect();

    await expect(client.send("Page.enable")).rejects.toThrow("Method not found");

    await client.disconnect();
  });

  it("receives CDP events", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    let serverWs: import("ws").WebSocket;
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const client = new CDPClient({ wsUrl: url });
    await client.connect();

    const eventPromise = client.waitForEvent("Page.domContentEventFired", 2000);

    // Give connection a moment to establish
    await new Promise((r) => setTimeout(r, 50));
    serverWs!.send(JSON.stringify({
      method: "Page.domContentEventFired",
      params: { timestamp: 12345 },
    }));

    const event = await eventPromise;
    expect(event.timestamp).toBe(12345);

    await client.disconnect();
  });

  it("rejects pending requests when connection closes", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    let serverWs: import("ws").WebSocket;
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const client = new CDPClient({ wsUrl: url });
    await client.connect();

    // Send a request that never gets a response, then close the server-side
    const promise = client.send("Page.enable");
    await new Promise((r) => setTimeout(r, 50));
    serverWs!.close();

    await expect(promise).rejects.toThrow("CDP connection closed");
  });

  it("throws when sending on a disconnected client", async () => {
    const client = new CDPClient({ wsUrl: "ws://localhost:1" });
    await expect(client.send("Page.enable")).rejects.toThrow("Not connected to CDP");
  });

  it("rejects pending request after requestTimeoutMs", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    // Server connects but never responds to commands
    wss.on("connection", () => { /* silence */ });

    const client = new CDPClient({ wsUrl: url, requestTimeoutMs: 200 });
    await client.connect();

    await expect(client.send("Page.enable")).rejects.toThrow("CDP request timeout");

    await client.disconnect();
  });

  it("times out waitForEvent", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    const client = new CDPClient({ wsUrl: url });
    await client.connect();

    await expect(
      client.waitForEvent("Page.domContentEventFired", 100),
    ).rejects.toThrow("Timeout waiting for CDP event");

    await client.disconnect();
  });
});

describe("CDPClient nextId reset", () => {
  it("resets nextId to 1 after disconnect", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    const receivedIds: number[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        receivedIds.push(msg.id);
        // Echo back a result so the send() promise resolves
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      });
    });

    const client = new CDPClient({ wsUrl: url });
    await client.connect();

    // Send a couple of commands — ids should be 1, 2
    await client.send("Page.enable");
    await client.send("Page.enable");
    expect(receivedIds).toEqual([1, 2]);

    await client.disconnect();

    // Reconnect and send again — id should restart at 1
    await client.connect();
    await client.send("Page.enable");
    expect(receivedIds).toEqual([1, 2, 1]);

    await client.disconnect();
  });
});

describe("CDPClient nextId overflow guard", () => {
  it("resets nextId before it reaches MAX_SAFE_INTEGER", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    const receivedIds: number[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        receivedIds.push(msg.id);
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      });
    });

    const client = new CDPClient({ wsUrl: url });
    await client.connect();

    // Force nextId to near MAX_SAFE_INTEGER
    (client as any).nextId = Number.MAX_SAFE_INTEGER - 1;

    // This send should trigger the overflow guard and reset nextId to 1
    await client.send("Page.enable");
    expect(receivedIds[receivedIds.length - 1]).toBe(1);

    // Next call should use 2
    await client.send("Page.enable");
    expect(receivedIds[receivedIds.length - 1]).toBe(2);

    await client.disconnect();
  });
});

describe("CDPClient bridge mode", () => {
  it("accepts a pre-connected WebSocket and reports connected", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    // Create a raw WS connection, then pass it as a pre-connected socket
    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const client = new CDPClient({ ws: ws as unknown as WebSocket });
    expect(client.connected).toBe(false);
    await client.connect();
    expect(client.connected).toBe(true);
    await client.disconnect();
  });

  it("sends commands and receives results in bridge mode", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "Runtime.evaluate") {
          ws.send(JSON.stringify({
            id: msg.id,
            result: { result: { type: "string", value: "bridge-hello" } },
          }));
        }
      });
    });

    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const client = new CDPClient({ ws: ws as unknown as WebSocket });
    await client.connect();

    const result = await client.send("Runtime.evaluate", {
      expression: "'bridge-hello'",
      returnByValue: true,
    });
    expect(result).toEqual({
      result: { type: "string", value: "bridge-hello" },
    });

    await client.disconnect();
  });

  it("throws on listTargets() in bridge mode", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const client = new CDPClient({ ws: ws as unknown as WebSocket });
    await client.connect();

    await expect(client.listTargets()).rejects.toThrow("not available in bridge mode");
    await expect(client.getVersion()).rejects.toThrow("not available in bridge mode");

    await client.disconnect();
  });

  it("receives events in bridge mode", async () => {
    const { wss, url, ready } = createMockCDPServer();
    servers.push(wss);
    await ready;

    let serverWs: import("ws").WebSocket;
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const client = new CDPClient({ ws: ws as unknown as WebSocket });
    await client.connect();

    const eventPromise = client.waitForEvent("Page.loadEventFired", 2000);
    await new Promise((r) => setTimeout(r, 50));
    serverWs!.send(JSON.stringify({
      method: "Page.loadEventFired",
      params: { timestamp: 99999 },
    }));

    const event = await eventPromise;
    expect(event.timestamp).toBe(99999);

    await client.disconnect();
  });
});
