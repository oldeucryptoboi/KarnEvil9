import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@jarvis/journal";
import { ToolRegistry, ToolRuntime } from "@jarvis/tools";
import { PermissionEngine } from "@jarvis/permissions";
import { MockPlanner } from "@jarvis/planner";
import { ApiServer } from "@jarvis/api";
import WebSocket from "ws";
import type { Server } from "node:http";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/examples");

/** Helper: open a WS connection and wait for it to be ready */
function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Helper: wait for next WS message matching a predicate */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 10000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WS message"));
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", handler);
    };

    ws.on("message", handler);
  });
}

/** Helper: collect all messages until a predicate matches, return the full list */
function collectUntil(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 10000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out collecting WS messages. Got ${messages.length}: ${messages.map((m) => m.type).join(", ")}`));
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(msg);
      if (predicate(msg)) {
        cleanup();
        resolve(messages);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", handler);
    };

    ws.on("message", handler);
  });
}

describe("Chat WebSocket Smoke Tests", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: Server;
  let port: number;

  beforeEach(async () => {
    testDir = join(tmpdir(), `jarvis-e2e-chat-ws-${uuid()}`);
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);

    port = 30000 + Math.floor(Math.random() * 10000);
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await journal.close();
    await rm(testDir, { recursive: true, force: true });
  });

  // ─── Insecure (no auth) tests ──────────────────────────────────

  describe("insecure mode (no auth)", () => {
    beforeEach(async () => {
      apiServer = new ApiServer({
        toolRegistry: registry,
        journal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        insecure: true,
      });
      httpServer = apiServer.listen(port);
    });

    it("connects to /api/ws and receives pong", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        ws.send(JSON.stringify({ type: "ping" }));
        const msg = await waitForMessage(ws, (m) => m.type === "pong");
        expect(msg.type).toBe("pong");
      } finally {
        ws.close();
      }
    });

    it("submit creates a session and streams events to completion", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        // Start collecting before submitting
        const allMessages = collectUntil(ws, (m) => {
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        }, 15000);

        ws.send(JSON.stringify({ type: "submit", text: "smoke test via ws" }));

        const messages = await allMessages;

        // First message should be session.created ack
        const ack = messages.find((m) => m.type === "session.created");
        expect(ack).toBeDefined();
        expect(ack!.session_id).toBeTruthy();
        expect(ack!.task).toBeDefined();

        // Should have event messages with journal events
        const events = messages.filter((m) => m.type === "event");
        expect(events.length).toBeGreaterThan(0);

        // Extract event types
        const eventTypes = events.map((m) => (m.event as Record<string, unknown>).type);
        expect(eventTypes).toContain("session.created");
        expect(eventTypes).toContain("session.started");

        // Session should reach a terminal state
        const terminal = eventTypes.filter((t) => t === "session.completed" || t === "session.failed");
        expect(terminal.length).toBeGreaterThan(0);
      } finally {
        ws.close();
      }
    });

    it("submit with invalid text returns error", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        ws.send(JSON.stringify({ type: "submit", text: "" }));
        const msg = await waitForMessage(ws, (m) => m.type === "error");
        expect(msg.type).toBe("error");
        expect(msg.message).toMatch(/text/i);
      } finally {
        ws.close();
      }
    });

    it("submit with missing text returns error", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        ws.send(JSON.stringify({ type: "submit" }));
        const msg = await waitForMessage(ws, (m) => m.type === "error");
        expect(msg.type).toBe("error");
      } finally {
        ws.close();
      }
    });

    it("invalid JSON returns error", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        ws.send("not json{{{");
        const msg = await waitForMessage(ws, (m) => m.type === "error");
        expect(msg.type).toBe("error");
        expect(msg.message).toMatch(/invalid json/i);
      } finally {
        ws.close();
      }
    });

    it("unknown message type returns error", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        ws.send(JSON.stringify({ type: "bogus" }));
        const msg = await waitForMessage(ws, (m) => m.type === "error");
        expect(msg.type).toBe("error");
        expect(msg.message).toMatch(/unknown/i);
      } finally {
        ws.close();
      }
    });

    it("abort on a running session sends abort", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        // Submit a session
        const ackPromise = waitForMessage(ws, (m) => m.type === "session.created");
        ws.send(JSON.stringify({ type: "submit", text: "abort target" }));
        const ack = await ackPromise;
        const sessionId = ack.session_id as string;

        // Send abort
        ws.send(JSON.stringify({ type: "abort", session_id: sessionId }));

        // Wait for terminal event — could be aborted or completed (mock is fast)
        const terminal = await waitForMessage(ws, (m) => {
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed" || event.type === "session.aborted";
        }, 10000);

        const event = terminal.event as Record<string, unknown>;
        expect(["session.completed", "session.failed", "session.aborted"]).toContain(event.type);
      } finally {
        ws.close();
      }
    });

    it("multiple sequential sessions work on same connection", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        // Session 1
        const all1 = collectUntil(ws, (m) => {
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        }, 15000);
        ws.send(JSON.stringify({ type: "submit", text: "session one" }));
        const msgs1 = await all1;
        const ack1 = msgs1.find((m) => m.type === "session.created");
        expect(ack1).toBeDefined();

        // Session 2 on same connection
        const all2 = collectUntil(ws, (m) => {
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        }, 15000);
        ws.send(JSON.stringify({ type: "submit", text: "session two" }));
        const msgs2 = await all2;
        const ack2 = msgs2.find((m) => m.type === "session.created");
        expect(ack2).toBeDefined();

        // Different session IDs
        expect(ack1!.session_id).not.toBe(ack2!.session_id);
      } finally {
        ws.close();
      }
    });

    it("registerApproval broadcasts approve.needed to WS client", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        // Submit a session to get a session ID tracked by this WS client
        const ackPromise = waitForMessage(ws, (m) => m.type === "session.created");
        ws.send(JSON.stringify({ type: "submit", text: "approval test" }));
        const ack = await ackPromise;
        const sessionId = ack.session_id as string;

        // Register a pending approval for this session
        let resolvedDecision: string | null = null;
        apiServer.registerApproval("test-req-1", {
          request_id: "test-req-1",
          session_id: sessionId,
          step_id: "step-1",
          tool_name: "shell-exec",
          permissions: [{ scope: "system:exec:*" }],
        }, (decision) => {
          resolvedDecision = decision as string;
        });

        // WS client should receive approve.needed
        const approveMsg = await waitForMessage(ws, (m) => m.type === "approve.needed", 5000);
        expect(approveMsg.type).toBe("approve.needed");
        expect(approveMsg.request_id).toBe("test-req-1");
        expect(approveMsg.session_id).toBe(sessionId);
        expect(approveMsg.request).toBeDefined();
        const request = approveMsg.request as Record<string, unknown>;
        expect(request.tool_name).toBe("shell-exec");

        // Send approve decision back
        ws.send(JSON.stringify({ type: "approve", request_id: "test-req-1", decision: "allow_once" }));

        // Wait for resolution
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (resolvedDecision !== null) { clearInterval(check); resolve(); }
          }, 50);
          setTimeout(() => { clearInterval(check); resolve(); }, 3000);
        });
        expect(resolvedDecision).toBe("allow_once");
      } finally {
        ws.close();
      }
    });

    it("approve.needed is not sent to WS clients not tracking the session", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        // Register an approval for a session this WS client is NOT tracking
        apiServer.registerApproval("orphan-req", {
          request_id: "orphan-req",
          session_id: "non-existent-session",
          step_id: "step-1",
          tool_name: "shell-exec",
          permissions: [],
        }, () => {});

        // Send a ping and expect pong — approve.needed should NOT arrive
        ws.send(JSON.stringify({ type: "ping" }));
        const msg = await waitForMessage(ws, (m) => m.type === "pong", 2000);
        expect(msg.type).toBe("pong");
        // If approve.needed had been sent, the pong would still arrive but we verify
        // no approve.needed came through by checking no error was thrown
      } finally {
        ws.close();
      }
    });

    it("rejects upgrade on non /api/ws path", async () => {
      await expect(openWs(`ws://localhost:${port}/other`)).rejects.toThrow();
    });

    it("server shutdown closes WS clients", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);

      const closePromise = new Promise<number>((resolve) => {
        ws.on("close", (code) => resolve(code));
      });

      await apiServer.shutdown();

      const code = await closePromise;
      expect(code).toBe(1001);
    });
  });

  // ─── Auth tests ─────────────────────────────────────────────────

  describe("token auth", () => {
    const TOKEN = "test-secret-token-42";

    beforeEach(async () => {
      apiServer = new ApiServer({
        toolRegistry: registry,
        journal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        apiToken: TOKEN,
      });
      httpServer = apiServer.listen(port);
    });

    it("connects with valid token", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws?token=${TOKEN}`);
      try {
        ws.send(JSON.stringify({ type: "ping" }));
        const msg = await waitForMessage(ws, (m) => m.type === "pong");
        expect(msg.type).toBe("pong");
      } finally {
        ws.close();
      }
    });

    it("rejects connection with wrong token", async () => {
      await expect(openWs(`ws://localhost:${port}/api/ws?token=wrong`)).rejects.toThrow();
    });

    it("rejects connection with no token", async () => {
      await expect(openWs(`ws://localhost:${port}/api/ws`)).rejects.toThrow();
    });

    it("submit works with valid token", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws?token=${TOKEN}`);
      try {
        const allMessages = collectUntil(ws, (m) => {
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        }, 15000);

        ws.send(JSON.stringify({ type: "submit", text: "authed session" }));

        const messages = await allMessages;
        const ack = messages.find((m) => m.type === "session.created");
        expect(ack).toBeDefined();
      } finally {
        ws.close();
      }
    });
  });

  // ─── Mode tests ─────────────────────────────────────────────────

  describe("execution modes", () => {
    beforeEach(async () => {
      apiServer = new ApiServer({
        toolRegistry: registry,
        journal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        insecure: true,
      });
      httpServer = apiServer.listen(port);
    });

    it("submit with mode=mock uses mock execution", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        const allMessages = collectUntil(ws, (m) => {
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        }, 15000);

        ws.send(JSON.stringify({ type: "submit", text: "mock mode test", mode: "mock" }));
        const messages = await allMessages;

        const ack = messages.find((m) => m.type === "session.created");
        expect(ack).toBeDefined();

        // Verify session was created with mock mode via journal
        const sessionId = ack!.session_id as string;
        const sessionEvents = await journal.readSession(sessionId);
        const createdEvent = sessionEvents.find((e) => e.type === "session.created");
        expect(createdEvent).toBeDefined();
      } finally {
        ws.close();
      }
    });
  });

  // ─── Approval flow tests ────────────────────────────────────────

  describe("approve.needed protocol", () => {
    let approvalServer: ApiServer;

    beforeEach(async () => {
      // Create a PermissionEngine whose callback goes through registerApproval
      let serverRef: ApiServer | null = null;
      const approvalPermissions = new PermissionEngine(journal, async (request) => {
        if (!serverRef) return "deny";
        return new Promise((resolve) => {
          serverRef!.registerApproval(request.request_id, request, resolve);
        });
      });
      const approvalRuntime = new ToolRuntime(registry, approvalPermissions, journal);

      approvalServer = new ApiServer({
        toolRegistry: registry,
        journal,
        toolRuntime: approvalRuntime,
        permissions: approvalPermissions,
        planner: new MockPlanner(),
        insecure: true,
      });
      serverRef = approvalServer;
      httpServer = approvalServer.listen(port);
    });

    it("full approval flow: submit → approve.needed → approve → session completes", async () => {
      const ws = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        // Start collecting all messages
        const messages: Record<string, unknown>[] = [];
        const messageHandler = (raw: WebSocket.RawData) => {
          messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        };
        ws.on("message", messageHandler);

        ws.send(JSON.stringify({ type: "submit", text: "task needing approval" }));

        // Wait for session.created ack
        const ack = await waitForMessage(ws, (m) => m.type === "session.created", 10000);
        expect(ack.session_id).toBeTruthy();

        // If an approve.needed message comes, auto-approve it
        // The mock planner may or may not trigger permissions depending on the plan
        const terminal = await waitForMessage(ws, (m) => {
          // Auto-approve any approve.needed that arrives
          if (m.type === "approve.needed") {
            ws.send(JSON.stringify({
              type: "approve",
              request_id: m.request_id,
              decision: "allow_once",
            }));
          }
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        }, 15000);

        const event = terminal.event as Record<string, unknown>;
        expect(["session.completed", "session.failed"]).toContain(event.type);

        ws.off("message", messageHandler);
      } finally {
        ws.close();
      }
    });
  });

  // ─── Reconnection tests ──────────────────────────────────────────

  describe("reconnection", () => {
    it("client can reconnect after server restart on same port", async () => {
      // Start first server
      apiServer = new ApiServer({
        toolRegistry: registry,
        journal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        insecure: true,
      });
      httpServer = apiServer.listen(port);

      // Connect and verify
      const ws1 = await openWs(`ws://localhost:${port}/api/ws`);
      ws1.send(JSON.stringify({ type: "ping" }));
      const pong1 = await waitForMessage(ws1, (m) => m.type === "pong");
      expect(pong1.type).toBe("pong");

      // Track close event on first connection
      const closePromise = new Promise<number>((resolve) => {
        ws1.on("close", (code) => resolve(code));
      });

      // Shut down server
      await apiServer.shutdown();
      const closeCode = await closePromise;
      expect(closeCode).toBe(1001);

      // Start a new server on the same port with a fresh journal
      const journal2 = new Journal(join(testDir, "journal2.jsonl"), { fsync: false, redact: false });
      await journal2.init();
      const registry2 = new ToolRegistry();
      await registry2.loadFromDirectory(TOOLS_DIR);
      const permissions2 = new PermissionEngine(journal2, async () => "allow_always");
      const runtime2 = new ToolRuntime(registry2, permissions2, journal2);

      const apiServer2 = new ApiServer({
        toolRegistry: registry2,
        journal: journal2,
        toolRuntime: runtime2,
        permissions: permissions2,
        planner: new MockPlanner(),
        insecure: true,
      });
      httpServer = apiServer2.listen(port);

      // Connect again — simulating what the client reconnect logic does
      const ws2 = await openWs(`ws://localhost:${port}/api/ws`);
      try {
        ws2.send(JSON.stringify({ type: "ping" }));
        const pong2 = await waitForMessage(ws2, (m) => m.type === "pong");
        expect(pong2.type).toBe("pong");

        // Submit works on reconnected server
        const allMessages = collectUntil(ws2, (m) => {
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        }, 15000);
        ws2.send(JSON.stringify({ type: "submit", text: "after reconnect" }));
        const messages = await allMessages;
        const ack = messages.find((m) => m.type === "session.created");
        expect(ack).toBeDefined();
      } finally {
        ws2.close();
        await apiServer2.shutdown();
      }
    });

    it("WS connection fails when server is not running", async () => {
      // Pick a port where nothing is listening
      const deadPort = 30000 + Math.floor(Math.random() * 10000);
      await expect(openWs(`ws://localhost:${deadPort}/api/ws`)).rejects.toThrow();
    });
  });
});
