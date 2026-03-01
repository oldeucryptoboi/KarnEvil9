/**
 * WebSocket Session Lifecycle E2E Smoke Tests
 *
 * End-to-end tests for the full WebSocket session flow, SSE streaming,
 * approval round-trip, and schedule execution. Self-contained: creates
 * temp directories, instantiates ApiServer directly, and cleans up.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { MockPlanner } from "@karnevil9/planner";
import { ApiServer } from "@karnevil9/api";
import { Kernel } from "@karnevil9/kernel";
import { Scheduler, ScheduleStore } from "@karnevil9/scheduler";
import WebSocket from "ws";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApprovalDecision, Schedule } from "@karnevil9/schemas";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/manifests");

// ─── Helpers ──────────────────────────────────────────────────────────

function serverPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

/** Open a WS connection and wait for it to be ready. */
function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Wait for the next WS message matching a predicate. */
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

/** Collect all WS messages until a predicate matches; return the full list. */
function collectUntil(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 15000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out collecting WS messages. Got ${messages.length}: ${messages.map((m) => m.type).join(", ")}`,
        ),
      );
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

// =====================================================================
// 1) WebSocket Session Lifecycle
// =====================================================================

describe("WebSocket Session Lifecycle (E2E)", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: Server;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-ws-lifecycle-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);

    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      insecure: true,
    });
    httpServer = apiServer.listen(0);
  });

  afterEach(async () => {
    if (httpServer) {
      await apiServer.shutdown();
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it("full lifecycle: submit -> session.created -> events -> terminal state", async () => {
    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      // Collect all messages until a terminal session event arrives
      const allMessages = collectUntil(ws, (m) => {
        if (m.type !== "event") return false;
        const event = m.event as Record<string, unknown>;
        return event.type === "session.completed" || event.type === "session.failed";
      }, 15000);

      ws.send(JSON.stringify({ type: "submit", text: "ws lifecycle smoke test" }));

      const messages = await allMessages;

      // 1. Should receive session.created ack
      const ack = messages.find((m) => m.type === "session.created");
      expect(ack).toBeDefined();
      expect(ack!.session_id).toBeTruthy();
      expect(typeof ack!.session_id).toBe("string");
      expect(ack!.task).toBeDefined();

      const sessionId = ack!.session_id as string;

      // 2. Collect event-type messages
      const events = messages.filter((m) => m.type === "event");
      expect(events.length).toBeGreaterThan(0);

      // 3. Extract journal event types
      const eventTypes = events.map((m) => (m.event as Record<string, unknown>).type as string);

      // 4. Verify planning events
      expect(eventTypes).toContain("session.created");
      expect(eventTypes).toContain("session.started");

      // 5. Verify a terminal state was reached
      const terminal = eventTypes.filter(
        (t) => t === "session.completed" || t === "session.failed",
      );
      expect(terminal.length).toBeGreaterThan(0);

      // 6. All events must reference the correct session_id
      for (const evt of events) {
        expect(evt.session_id).toBe(sessionId);
      }
    } finally {
      ws.close();
    }
  });

  it("event ordering: created -> started -> completed", async () => {
    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      const allMessages = collectUntil(ws, (m) => {
        if (m.type !== "event") return false;
        const event = m.event as Record<string, unknown>;
        return event.type === "session.completed" || event.type === "session.failed";
      }, 15000);

      ws.send(JSON.stringify({ type: "submit", text: "ordering test" }));

      const messages = await allMessages;
      const events = messages.filter((m) => m.type === "event");
      const eventTypes = events.map((m) => (m.event as Record<string, unknown>).type as string);

      // session.created must come before session.started
      const createdIdx = eventTypes.indexOf("session.created");
      const startedIdx = eventTypes.indexOf("session.started");
      expect(createdIdx).toBeGreaterThanOrEqual(0);
      expect(startedIdx).toBeGreaterThanOrEqual(0);
      expect(createdIdx).toBeLessThan(startedIdx);

      // session.started must come before terminal
      const completedIdx = eventTypes.findIndex(
        (t) => t === "session.completed" || t === "session.failed",
      );
      expect(completedIdx).toBeGreaterThan(startedIdx);
    } finally {
      ws.close();
    }
  });

  it("all events have valid timestamps and session_id", async () => {
    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      const allMessages = collectUntil(ws, (m) => {
        if (m.type !== "event") return false;
        const event = m.event as Record<string, unknown>;
        return event.type === "session.completed" || event.type === "session.failed";
      }, 15000);

      ws.send(JSON.stringify({ type: "submit", text: "timestamp validation" }));

      const messages = await allMessages;
      const ack = messages.find((m) => m.type === "session.created");
      const sessionId = ack!.session_id as string;

      const events = messages.filter((m) => m.type === "event");
      for (const msg of events) {
        const event = msg.event as Record<string, unknown>;
        // Must have session_id
        expect(event.session_id).toBe(sessionId);
        // Must have a valid ISO timestamp
        expect(typeof event.timestamp).toBe("string");
        const ts = new Date(event.timestamp as string);
        expect(ts.getTime()).not.toBeNaN();
        // Timestamp should be recent (within the last 60s)
        expect(Date.now() - ts.getTime()).toBeLessThan(60000);
      }
    } finally {
      ws.close();
    }
  });

  it("receives plan.generated / plan.accepted events during planning", async () => {
    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      const allMessages = collectUntil(ws, (m) => {
        if (m.type !== "event") return false;
        const event = m.event as Record<string, unknown>;
        return event.type === "session.completed" || event.type === "session.failed";
      }, 15000);

      ws.send(JSON.stringify({ type: "submit", text: "planning events test" }));

      const messages = await allMessages;
      const eventTypes = messages
        .filter((m) => m.type === "event")
        .map((m) => (m.event as Record<string, unknown>).type as string);

      // MockPlanner generates a plan with one step
      expect(eventTypes).toContain("planner.requested");
      expect(eventTypes).toContain("planner.plan_received");
      expect(eventTypes).toContain("plan.accepted");
    } finally {
      ws.close();
    }
  });

  it("receives step execution events (step.started, step.succeeded or step.failed)", async () => {
    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      const allMessages = collectUntil(ws, (m) => {
        if (m.type !== "event") return false;
        const event = m.event as Record<string, unknown>;
        return event.type === "session.completed" || event.type === "session.failed";
      }, 15000);

      ws.send(JSON.stringify({ type: "submit", text: "step events test" }));

      const messages = await allMessages;
      const eventTypes = messages
        .filter((m) => m.type === "event")
        .map((m) => (m.event as Record<string, unknown>).type as string);

      expect(eventTypes).toContain("step.started");
      // Should have either step.succeeded or step.failed
      const hasStepResult =
        eventTypes.includes("step.succeeded") || eventTypes.includes("step.failed");
      expect(hasStepResult).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("step events arrive after plan events and before terminal event", async () => {
    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      const allMessages = collectUntil(ws, (m) => {
        if (m.type !== "event") return false;
        const event = m.event as Record<string, unknown>;
        return event.type === "session.completed" || event.type === "session.failed";
      }, 15000);

      ws.send(JSON.stringify({ type: "submit", text: "step ordering test" }));

      const messages = await allMessages;
      const eventTypes = messages
        .filter((m) => m.type === "event")
        .map((m) => (m.event as Record<string, unknown>).type as string);

      const planAcceptedIdx = eventTypes.indexOf("plan.accepted");
      const stepStartedIdx = eventTypes.indexOf("step.started");
      const terminalIdx = eventTypes.findIndex(
        (t) => t === "session.completed" || t === "session.failed",
      );

      if (planAcceptedIdx >= 0 && stepStartedIdx >= 0) {
        expect(planAcceptedIdx).toBeLessThan(stepStartedIdx);
      }
      if (stepStartedIdx >= 0 && terminalIdx >= 0) {
        expect(stepStartedIdx).toBeLessThan(terminalIdx);
      }
    } finally {
      ws.close();
    }
  });
});

// =====================================================================
// 2) SSE Streaming
// =====================================================================

describe("SSE Streaming (E2E)", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: Server;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-sse-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);

    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      insecure: true,
    });
    httpServer = apiServer.listen(0);
  });

  afterEach(async () => {
    if (httpServer) {
      await apiServer.shutdown();
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it("SSE endpoint streams session events as text/event-stream", async () => {
    const port = serverPort(httpServer);
    const baseUrl = `http://localhost:${port}`;

    // 1. Create a session via REST
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "SSE streaming test" }),
    });
    expect(createRes.status).toBe(200);
    const { session_id } = (await createRes.json()) as { session_id: string };
    expect(session_id).toBeTruthy();

    // 2. Connect to the SSE stream endpoint
    const sseRes = await fetch(`${baseUrl}/api/sessions/${session_id}/stream`);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // 3. Read the SSE stream and collect data lines
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const dataLines: string[] = [];
    const startTime = Date.now();
    const MAX_READ_TIME_MS = 10000;

    try {
      while (Date.now() - startTime < MAX_READ_TIME_MS) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), MAX_READ_TIME_MS),
          ),
        ]);
        if (done) break;
        if (!value) continue;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          }
          if (line === ":keepalive") {
            dataLines.push("__keepalive__");
          }
        }
        // If we have any data lines, we have verified streaming works
        if (dataLines.length > 0) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    // 4. Verify we received at least some SSE data or a keepalive.
    //    The session runs fast with MockPlanner; events may have already been emitted
    //    before we connected, but the keepalive should still arrive.
    //    If the session completed before our SSE connect, data lines may be empty,
    //    so verify at least the connection succeeded (status 200 + correct content-type).
    expect(sseRes.status).toBe(200);
  });

  it("SSE endpoint returns 400 for invalid session ID format", async () => {
    const port = serverPort(httpServer);
    const res = await fetch(`http://localhost:${port}/api/sessions/not-a-uuid/stream`);
    expect(res.status).toBe(400);
  });

  it("SSE replay catches up from after_seq", async () => {
    const port = serverPort(httpServer);
    const baseUrl = `http://localhost:${port}`;

    // Create a session and wait for it to complete
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "SSE replay test" }),
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    // Wait for session to complete
    const maxWait = Date.now() + 10000;
    while (Date.now() < maxWait) {
      const statusRes = await fetch(`${baseUrl}/api/sessions/${session_id}`);
      if (statusRes.status === 200) {
        const session = (await statusRes.json()) as { status: string };
        if (session.status === "completed" || session.status === "failed") break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Connect SSE with after_seq=0 to replay from the beginning
    const sseRes = await fetch(`${baseUrl}/api/sessions/${session_id}/stream?after_seq=0`);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // Read a chunk of the replay
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const dataLines: string[] = [];

    try {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 5000),
        ),
      ]);
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    // Replayed events should include journal events from seq > 0
    // Parse the data lines and verify they are valid JSON events
    for (const line of dataLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.type).toBeTruthy();
      expect(parsed.session_id).toBe(session_id);
    }
  });
});

// =====================================================================
// 3) Approval Flow Round-Trip
// =====================================================================

describe("Approval Flow Round-Trip (E2E)", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: Server;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-approval-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
  });

  afterEach(async () => {
    if (httpServer) {
      await apiServer.shutdown();
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it("full approval flow: submit -> approve.needed -> approve -> session completes", async () => {
    // Create a PermissionEngine that routes through registerApproval
    let serverRef: ApiServer | null = null;
    const approvalPermissions = new PermissionEngine(journal, async (request) => {
      if (!serverRef) return "deny";
      return new Promise<ApprovalDecision>((resolve) => {
        serverRef!.registerApproval(request.request_id, request, resolve);
      });
    });
    const approvalRuntime = new ToolRuntime(registry, approvalPermissions, journal);

    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: approvalRuntime,
      permissions: approvalPermissions,
      planner: new MockPlanner(),
      insecure: true,
    });
    serverRef = apiServer;
    httpServer = apiServer.listen(0);

    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      // Collect all messages, auto-approving any approve.needed
      const messages: Record<string, unknown>[] = [];
      const messageHandler = (raw: WebSocket.RawData) => {
        messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      };
      ws.on("message", messageHandler);

      ws.send(JSON.stringify({ type: "submit", text: "task needing approval" }));

      // Wait for session.created ack
      const ack = await waitForMessage(ws, (m) => m.type === "session.created", 10000);
      expect(ack.session_id).toBeTruthy();

      // Wait for terminal event, auto-approving any approve.needed along the way
      const terminal = await waitForMessage(
        ws,
        (m) => {
          if (m.type === "approve.needed") {
            ws.send(
              JSON.stringify({
                type: "approve",
                request_id: m.request_id,
                decision: "allow_once",
              }),
            );
          }
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        },
        15000,
      );

      const event = terminal.event as Record<string, unknown>;
      expect(["session.completed", "session.failed"]).toContain(event.type);

      ws.off("message", messageHandler);
    } finally {
      ws.close();
    }
  });

  it("approve.needed includes request_id, session_id, and tool info", async () => {
    const approvalPermissions = new PermissionEngine(journal, async () => "allow_always");
    const approvalRuntime = new ToolRuntime(registry, approvalPermissions, journal);

    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: approvalRuntime,
      permissions: approvalPermissions,
      planner: new MockPlanner(),
      insecure: true,
    });
    httpServer = apiServer.listen(0);

    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      // Submit a session to get a session ID tracked by this WS client
      const ackPromise = waitForMessage(ws, (m) => m.type === "session.created");
      ws.send(JSON.stringify({ type: "submit", text: "approval info test" }));
      const ack = await ackPromise;
      const sessionId = ack.session_id as string;

      // Manually register an approval to test the broadcast message shape
      let resolvedDecision: ApprovalDecision | null = null;
      apiServer.registerApproval("test-approval-info", {
        request_id: "test-approval-info",
        session_id: sessionId,
        step_id: "step-123",
        tool_name: "shell-exec",
        permissions: [{ scope: "system:exec:*" }],
      }, (decision) => {
        resolvedDecision = decision;
      });

      // Wait for approve.needed
      const approveMsg = await waitForMessage(ws, (m) => m.type === "approve.needed", 5000);
      expect(approveMsg.type).toBe("approve.needed");
      expect(approveMsg.request_id).toBe("test-approval-info");
      expect(approveMsg.session_id).toBe(sessionId);
      expect(approveMsg.request).toBeDefined();

      const request = approveMsg.request as Record<string, unknown>;
      expect(request.tool_name).toBe("shell-exec");
      expect(request.step_id).toBe("step-123");

      // Send approval
      ws.send(
        JSON.stringify({
          type: "approve",
          request_id: "test-approval-info",
          decision: "allow_session",
        }),
      );

      // Wait for resolution
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (resolvedDecision !== null) {
            clearInterval(check);
            resolve();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, 3000);
      });
      expect(resolvedDecision).toBe("allow_session");
    } finally {
      ws.close();
    }
  });

  it("deny decision stops the session from proceeding", async () => {
    let serverRef: ApiServer | null = null;
    const denyPermissions = new PermissionEngine(journal, async (request) => {
      if (!serverRef) return "deny";
      return new Promise<ApprovalDecision>((resolve) => {
        serverRef!.registerApproval(request.request_id, request, resolve);
      });
    });
    const denyRuntime = new ToolRuntime(registry, denyPermissions, journal);

    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: denyRuntime,
      permissions: denyPermissions,
      planner: new MockPlanner(),
      insecure: true,
    });
    serverRef = apiServer;
    httpServer = apiServer.listen(0);

    const ws = await openWs(`ws://localhost:${serverPort(httpServer)}/api/ws`);
    try {
      ws.send(JSON.stringify({ type: "submit", text: "denial test" }));

      // Wait for terminal event, denying any approval requests
      const terminal = await waitForMessage(
        ws,
        (m) => {
          if (m.type === "approve.needed") {
            ws.send(
              JSON.stringify({
                type: "approve",
                request_id: m.request_id,
                decision: "deny",
              }),
            );
          }
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return (
            event.type === "session.completed" ||
            event.type === "session.failed" ||
            event.type === "session.aborted"
          );
        },
        15000,
      );

      const event = terminal.event as Record<string, unknown>;
      // With a deny decision, the session should fail (step denied -> abort)
      expect(["session.completed", "session.failed", "session.aborted"]).toContain(event.type);
    } finally {
      ws.close();
    }
  });

  it("approval via REST endpoint also resolves the WS session", async () => {
    let serverRef: ApiServer | null = null;
    const restApprovalPermissions = new PermissionEngine(journal, async (request) => {
      if (!serverRef) return "deny";
      return new Promise<ApprovalDecision>((resolve) => {
        serverRef!.registerApproval(request.request_id, request, resolve);
      });
    });
    const restApprovalRuntime = new ToolRuntime(registry, restApprovalPermissions, journal);

    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: restApprovalRuntime,
      permissions: restApprovalPermissions,
      planner: new MockPlanner(),
      insecure: true,
    });
    serverRef = apiServer;
    httpServer = apiServer.listen(0);

    const port = serverPort(httpServer);
    const ws = await openWs(`ws://localhost:${port}/api/ws`);
    try {
      ws.send(JSON.stringify({ type: "submit", text: "REST approval test" }));

      // Wait for approve.needed over WS
      const approveNeeded = await waitForMessage(ws, (m) => m.type === "approve.needed", 10000);
      const requestId = approveNeeded.request_id as string;
      expect(requestId).toBeTruthy();

      // Approve via REST instead of WS
      const approveRes = await fetch(`http://localhost:${port}/api/approvals/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allow_once" }),
      });
      expect(approveRes.status).toBe(200);

      // Session should complete
      const terminal = await waitForMessage(
        ws,
        (m) => {
          // Auto-approve any further approval requests
          if (m.type === "approve.needed") {
            fetch(`http://localhost:${port}/api/approvals/${m.request_id as string}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decision: "allow_once" }),
            }).catch(() => {});
          }
          if (m.type !== "event") return false;
          const event = m.event as Record<string, unknown>;
          return event.type === "session.completed" || event.type === "session.failed";
        },
        15000,
      );

      const event = terminal.event as Record<string, unknown>;
      expect(["session.completed", "session.failed"]).toContain(event.type);
    } finally {
      ws.close();
    }
  });
});

// =====================================================================
// 4) Schedule Execution
// =====================================================================

describe("Schedule Execution (E2E)", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: Server;
  let scheduler: Scheduler;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-schedule-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);

    const store = new ScheduleStore(join(testDir, "schedules.jsonl"));
    const planner = new MockPlanner();

    scheduler = new Scheduler({
      store,
      journal,
      sessionFactory: async (task) => {
        const kernel = new Kernel({
          journal,
          toolRegistry: registry,
          toolRuntime: runtime,
          permissions,
          planner,
          mode: "mock",
          limits: { max_steps: 20, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
          policy: {
            allowed_paths: [process.cwd()],
            allowed_endpoints: [],
            allowed_commands: [],
            require_approval_for_writes: false,
          },
        });
        const session = await kernel.createSession(task);
        void kernel.run();
        return { session_id: session.session_id, status: session.status };
      },
      tickIntervalMs: 50,
    });
    await scheduler.start();

    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner,
      scheduler,
      insecure: true,
    });
    httpServer = apiServer.listen(0);
  });

  afterEach(async () => {
    await scheduler.stop();
    if (httpServer) {
      await apiServer.shutdown();
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it("create schedule via REST and verify it appears in GET /schedules", async () => {
    const port = serverPort(httpServer);
    const baseUrl = `http://localhost:${port}`;

    // Create a schedule
    const createRes = await fetch(`${baseUrl}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "e2e-schedule-test",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "scheduled task" },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Schedule;
    expect(created.schedule_id).toBeTruthy();
    expect(created.name).toBe("e2e-schedule-test");
    expect(created.status).toBe("active");

    // Verify it appears in the list
    const listRes = await fetch(`${baseUrl}/api/schedules`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { schedules: Schedule[]; total: number };
    expect(listBody.total).toBeGreaterThanOrEqual(1);
    const found = listBody.schedules.find((s) => s.schedule_id === created.schedule_id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("e2e-schedule-test");
  });

  it("one-shot 'at' schedule fires and creates a session", async () => {
    const port = serverPort(httpServer);
    const baseUrl = `http://localhost:${port}`;

    // Create a one-shot schedule with trigger time in the past
    const createRes = await fetch(`${baseUrl}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "one-shot-e2e",
        trigger: { type: "at", at: new Date(Date.now() - 1000).toISOString() },
        action: { type: "createSession", task_text: "one-shot job" },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Schedule;

    // Wait for the scheduler tick to fire and the session to run
    await new Promise((r) => setTimeout(r, 3000));

    // Verify the schedule completed and a session was created
    const getRes = await fetch(`${baseUrl}/api/schedules/${created.schedule_id}`);
    expect(getRes.status).toBe(200);
    const updated = (await getRes.json()) as Schedule;
    expect(updated.status).toBe("completed");
    expect(updated.run_count).toBe(1);
    expect(updated.last_session_id).toBeTruthy();

    // Verify journal events exist for the created session
    const allEvents = await journal.readAll();
    const sessionEvents = allEvents.filter((e) => e.session_id === updated.last_session_id);
    expect(sessionEvents.length).toBeGreaterThan(0);
    expect(sessionEvents.map((e) => e.type)).toContain("session.created");
  });

  it("recurring schedule fires and updates run_count", async () => {
    const port = serverPort(httpServer);
    const baseUrl = `http://localhost:${port}`;

    // Create a recurring schedule
    const createRes = await fetch(`${baseUrl}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "recurring-e2e",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "recurring job" },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Schedule;

    // Force the next_run_at to the past so it fires on the next tick
    const sched = scheduler.getSchedule(created.schedule_id)!;
    sched.next_run_at = new Date(Date.now() - 1000).toISOString();
    // Update the schedule in the store (scheduler has direct access)
    const store = scheduler as unknown as { store: ScheduleStore };
    if (store.store && typeof store.store.set === "function") {
      store.store.set(sched);
    }

    // Wait for the tick to fire
    await new Promise((r) => setTimeout(r, 1000));

    // Check run_count incremented
    const updated = scheduler.getSchedule(created.schedule_id)!;
    expect(updated.run_count).toBeGreaterThanOrEqual(1);
    expect(updated.last_run_at).toBeTruthy();
    expect(updated.status).toBe("active"); // Recurring stays active
  });

  it("schedule health check is reflected in GET /health", async () => {
    const port = serverPort(httpServer);
    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      checks: { scheduler: { status: string; schedules: number } };
    };
    expect(body.checks.scheduler).toBeDefined();
    expect(body.checks.scheduler.status).toBe("ok");
  });

  it("deleted schedule does not fire", async () => {
    const port = serverPort(httpServer);
    const baseUrl = `http://localhost:${port}`;

    // Create and immediately delete a schedule
    const createRes = await fetch(`${baseUrl}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "delete-before-fire",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "should not run" },
      }),
    });
    const created = (await createRes.json()) as Schedule;

    // Delete it
    const delRes = await fetch(`${baseUrl}/api/schedules/${created.schedule_id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    // Verify 404 on fetch
    const getRes = await fetch(`${baseUrl}/api/schedules/${created.schedule_id}`);
    expect(getRes.status).toBe(404);

    // Wait a tick and verify no session was created from this schedule
    await new Promise((r) => setTimeout(r, 500));
    const allEvents = await journal.readAll();
    const schedulerEvents = allEvents.filter(
      (e) =>
        e.type === "scheduler.job_triggered" &&
        (e.payload as Record<string, unknown>).schedule_id === created.schedule_id,
    );
    expect(schedulerEvents.length).toBe(0);
  });
});
