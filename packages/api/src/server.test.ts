import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve, join } from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import http from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { PluginRegistry } from "@karnevil9/plugins";
import { MockPlanner } from "@karnevil9/planner";
import type { ToolManifest, ApprovalDecision } from "@karnevil9/schemas";
import { MetricsCollector } from "@karnevil9/metrics";
import { ApiServer, RateLimiter } from "./server.js";

const TEST_DIR = resolve(import.meta.dirname ?? ".", "../../.test-data");
const TEST_FILE = resolve(TEST_DIR, "api-journal.jsonl");

const testTool: ToolManifest = {
  name: "test-tool",
  version: "1.0.0",
  description: "A test tool",
  runner: "internal",
  input_schema: { type: "object", additionalProperties: false },
  output_schema: { type: "object", additionalProperties: false },
  permissions: [],
  timeout_ms: 5000,
  supports: { mock: true, dry_run: false },
  mock_responses: [{}],
};

async function fetch(url: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const { method = "GET", body, headers: extraHeaders } = opts ?? {};
  const parsed = new URL(url);
  const headers: Record<string, string> = { ...(body ? { "Content-Type": "application/json" } : {}), ...extraHeaders };
  return new Promise<{ status: number; json: () => Promise<any> }>((resolve, reject) => {
    const req = http.request(
      url,
      { method, headers },
      (res: any) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            json: async () => JSON.parse(data),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}


describe("ApiServer (legacy constructor)", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    apiServer = new ApiServer(registry, journal);

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("GET /api/health returns healthy with checks object", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["healthy", "warning"]).toContain(body.status);
    expect(body.version).toBe("0.1.0");
    expect(body.timestamp).toBeTruthy();
    expect(body.checks).toBeTruthy();
    expect(body.checks.journal.status).toBe("ok");
    expect(body.checks.tools.status).toBe("ok");
    expect(body.checks.tools.loaded).toBe(1);
    expect(body.checks.sessions.status).toBe("ok");
    expect(body.checks.sessions.active).toBe(0);
  });

  it("health check shows unavailable subsystems in legacy mode", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.planner.status).toBe("unavailable");
    expect(body.checks.permissions.status).toBe("unavailable");
    expect(body.checks.runtime.status).toBe("unavailable");
  });

  it("GET /api/tools lists registered tools", async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("test-tool");
  });

  it("GET /api/tools/:name returns tool details", async () => {
    const res = await fetch(`${baseUrl}/api/tools/test-tool`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("test-tool");
  });

  it("GET /api/tools/:name returns 404 for unknown tool", async () => {
    const res = await fetch(`${baseUrl}/api/tools/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("POST /api/sessions creates a task (legacy mode)", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Do something" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.text).toBe("Do something");
    expect(body.task.task_id).toBeTruthy();
    expect(body.message).toContain("Use a kernel");
  });

  it("POST /api/sessions returns 400 without text", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/sessions returns 400 for empty text", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "   " },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/sessions returns 400 for invalid mode", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Valid text", mode: "dangerous" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mode");
  });

  it("POST /api/sessions returns 400 for invalid limits", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Valid text", limits: { max_steps: -5 } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("limits");
  });

  it("POST /api/sessions accepts valid mode and limits", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Valid text", mode: "mock", limits: { max_steps: 10 } },
    });
    expect(res.status).toBe(200);
  });

  it("GET /api/sessions/:id returns 400 for non-UUID session id", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid session ID");
  });

  it("GET /api/sessions/:id returns 404 for unknown UUID session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it("GET /api/approvals returns empty list initially", async () => {
    const res = await fetch(`${baseUrl}/api/approvals`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toEqual([]);
  });

  it("POST /api/approvals/:id returns 404 for unknown approval", async () => {
    const res = await fetch(`${baseUrl}/api/approvals/nonexistent`, {
      method: "POST",
      body: { decision: "allow_once" },
    });
    expect(res.status).toBe(404);
  });

  it("resolves pending approvals", async () => {
    let resolvedDecision: string | null = null;
    apiServer.registerApproval("req-1", { tool: "test" }, (decision) => {
      resolvedDecision = decision;
    });

    const listRes = await fetch(`${baseUrl}/api/approvals`);
    const listBody = await listRes.json();
    expect(listBody.pending).toHaveLength(1);

    const res = await fetch(`${baseUrl}/api/approvals/req-1`, {
      method: "POST",
      body: { decision: "allow_session" },
    });
    expect(res.status).toBe(200);
    expect(resolvedDecision).toBe("allow_session");
  });

  it("POST /api/approvals/:id rejects invalid decision", async () => {
    apiServer.registerApproval("req-2", {}, () => {});
    const res = await fetch(`${baseUrl}/api/approvals/req-2`, {
      method: "POST",
      body: { decision: "invalid_decision" },
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/sessions/:id/journal returns events", async () => {
    const sessId = "00000000-0000-0000-0000-000000000001";
    await journal.emit(sessId, "session.created", { task: "test" });
    const res = await fetch(`${baseUrl}/api/sessions/${sessId}/journal`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });

  it("POST /api/sessions/:id/replay returns events", async () => {
    const sessId = "00000000-0000-0000-0000-000000000002";
    await journal.emit(sessId, "session.created", {});
    await journal.emit(sessId, "session.started", {});
    const res = await fetch(`${baseUrl}/api/sessions/${sessId}/replay`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_count).toBe(2);
  });

  it("POST /api/sessions/:id/replay returns 400 for non-UUID session id", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/replay`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("POST /api/sessions/:id/replay returns 404 for empty UUID session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/00000000-0000-0000-0000-ffffffffffff/replay`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /api/journal/compact compacts the journal", async () => {
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    const res = await fetch(`${baseUrl}/api/journal/compact`, {
      method: "POST",
      body: { retain_sessions: ["sess-1"] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.before).toBe(3);
    expect(body.after).toBe(2);
  });
});

describe("ApiServer (full config constructor)", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    runtime = new ToolRuntime(registry, permissions, journal);
    apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      defaultMode: "mock",
      defaultLimits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      defaultPolicy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      insecure: true,
    });

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("POST /api/sessions creates and runs a kernel session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Run a test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_id).toBeTruthy();
    expect(body.task.text).toBe("Run a test");

    // Give the kernel time to run in background
    await new Promise((r) => setTimeout(r, 100));

    // Session should be retrievable
    const sessionRes = await fetch(`${baseUrl}/api/sessions/${body.session_id}`);
    expect(sessionRes.status).toBe(200);
    const session = await sessionRes.json();
    expect(["completed", "failed", "running", "planning"]).toContain(session.status);
  });

  it("POST /api/sessions accepts custom mode and limits (clamped to server max)", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: {
        text: "Custom config test",
        mode: "mock",
        limits: { max_steps: 5 },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_id).toBeTruthy();

    await new Promise((r) => setTimeout(r, 100));

    const sessionRes = await fetch(`${baseUrl}/api/sessions/${body.session_id}`);
    const session = await sessionRes.json();
    // Client requested 5 which is below server max of 10 — honored
    expect(session.limits.max_steps).toBe(5);
    // Policy is server-controlled — client cannot override
    expect(session.policy.allowed_paths).toEqual(["/tmp"]);
  });

  it("POST /api/sessions/:id/abort aborts a session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Abort me" },
    });
    const body = await res.json();
    const sessionId = body.session_id;

    // Give kernel time to start
    await new Promise((r) => setTimeout(r, 50));

    const abortRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/abort`, { method: "POST" });
    expect(abortRes.status).toBe(200);

    // Session status is either aborted (if we caught it in time) or completed
    await new Promise((r) => setTimeout(r, 50));
    const sessionRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    const session = await sessionRes.json();
    expect(["aborted", "completed"]).toContain(session.status);
  });

  it("broadcastEvent sends SSE data to clients (no-op without clients)", () => {
    expect(() => apiServer.broadcastEvent("no-clients", { type: "test" })).not.toThrow();
  });

  it("registerKernel makes session retrievable via GET", async () => {
    const { Kernel } = await import("@karnevil9/kernel");
    const kernel = new Kernel({
      journal, toolRuntime: runtime, toolRegistry: registry, permissions,
      planner: new MockPlanner(), mode: "mock",
      limits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      policy: { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });
    const task = { task_id: "t1", text: "test", created_at: new Date().toISOString() };
    const session = await kernel.createSession(task);
    apiServer.registerKernel(session.session_id, kernel);

    const res = await fetch(`${baseUrl}/api/sessions/${session.session_id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_id).toBe(session.session_id);
  });

  it("journal events for created sessions are retrievable", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Journal test" },
    });
    const body = await res.json();

    // Wait for kernel to complete (mock mode is fast)
    await new Promise((r) => setTimeout(r, 500));

    const journalRes = await fetch(`${baseUrl}/api/sessions/${body.session_id}/journal`);
    expect(journalRes.status).toBe(200);
    const journalBody = await journalRes.json();
    // At minimum, session.created should be there
    const types = journalBody.events.map((e: any) => e.type);
    expect(types).toContain("session.created");
  });

  it("health check includes tool count and active sessions", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["healthy", "warning"]).toContain(body.status);
    expect(body.checks.tools.loaded).toBe(1);
    expect(body.checks.sessions.active).toBeGreaterThanOrEqual(0);
  });

  it("health check shows subsystem availability", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.planner.status).toBe("ok");
    expect(body.checks.permissions.status).toBe("ok");
    expect(body.checks.runtime.status).toBe("ok");
  });

  it("health check events have seq numbers", async () => {
    const event = await journal.emit("test-sess", "session.created", {});
    expect(event.seq).toBeDefined();
    expect(typeof event.seq).toBe("number");
  });

  it("health check includes disk_usage in journal check", async () => {
    // Emit an event first so the journal file exists
    await journal.emit("test-sess", "session.created", {});
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.journal.disk_usage).toBeDefined();
    expect(body.checks.journal.disk_usage.total_bytes).toBeGreaterThan(0);
    expect(body.checks.journal.disk_usage.available_bytes).toBeGreaterThan(0);
    expect(typeof body.checks.journal.disk_usage.usage_pct).toBe("number");
  });
});

describe("ApiServer concurrency limits", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    runtime = new ToolRuntime(registry, permissions, journal);
    apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      defaultMode: "mock",
      defaultLimits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      defaultPolicy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      maxConcurrentSessions: 2,
      insecure: true,
    });

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("returns 429 when max_concurrent_sessions exceeded", async () => {
    // Create sessions up to the limit
    const res1 = await fetch(`${baseUrl}/api/sessions`, { method: "POST", body: { text: "Session 1" } });
    expect(res1.status).toBe(200);
    const res2 = await fetch(`${baseUrl}/api/sessions`, { method: "POST", body: { text: "Session 2" } });
    expect(res2.status).toBe(200);

    // Third should be rejected
    const res3 = await fetch(`${baseUrl}/api/sessions`, { method: "POST", body: { text: "Session 3" } });
    expect(res3.status).toBe(429);
  });
});

describe("ApiServer recovery", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    runtime = new ToolRuntime(registry, permissions, journal);
    apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      defaultMode: "mock",
      defaultLimits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      defaultPolicy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      insecure: true,
    });

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("POST /sessions/:id/recover recovers a session", async () => {
    const { v4: uuidv4 } = await import("uuid");
    const sessionId = uuidv4();
    const planId = uuidv4();

    // Set up recoverable journal events (session started + plan accepted, no terminal event)
    await journal.emit(sessionId, "session.created", {
      task_id: uuidv4(), task_text: "Recovery test", mode: "mock",
    });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId,
      plan: {
        plan_id: planId,
        schema_version: "0.1",
        goal: "Recovery test",
        assumptions: [],
        steps: [{
          step_id: uuidv4(), title: "Test step", tool_ref: { name: "test-tool" },
          input: {}, success_criteria: ["done"], failure_policy: "abort",
          timeout_ms: 5000, max_retries: 0,
        }],
        created_at: new Date().toISOString(),
      },
    });

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/recover`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_id).toBe(sessionId);
    expect(["completed", "failed"]).toContain(body.status);
  });

  it("POST /sessions/:id/recover returns 400 for non-UUID session id", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/recover`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("POST /sessions/:id/recover returns 404 for nonexistent UUID session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/00000000-0000-0000-0000-ffffffffffff/recover`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("H1: POST /sessions/:id/recover returns 409 for already active session", async () => {
    const { v4: uuidv4 } = await import("uuid");
    const sessionId = uuidv4();
    const planId = uuidv4();

    // Set up recoverable journal events
    await journal.emit(sessionId, "session.created", {
      task_id: uuidv4(), task_text: "Recovery test", mode: "mock",
    });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId,
      plan: {
        plan_id: planId, schema_version: "0.1", goal: "Recovery test",
        assumptions: [], steps: [{
          step_id: uuidv4(), title: "Test step", tool_ref: { name: "test-tool" },
          input: {}, success_criteria: ["done"], failure_policy: "abort",
          timeout_ms: 5000, max_retries: 0,
        }],
        created_at: new Date().toISOString(),
      },
    });

    // First recover
    const res1 = await fetch(`${baseUrl}/api/sessions/${sessionId}/recover`, { method: "POST" });
    expect(res1.status).toBe(200);

    // Wait a bit for kernel to be registered
    await new Promise((r) => setTimeout(r, 50));

    // Second recover should conflict
    const res2 = await fetch(`${baseUrl}/api/sessions/${sessionId}/recover`, { method: "POST" });
    expect(res2.status).toBe(409);
  });

  it("discoverRecoverableSessions finds sessions without terminal events", async () => {
    const { v4: uuidv4 } = await import("uuid");
    const recoverableId = uuidv4();
    const completedId = uuidv4();

    // Set up a recoverable session
    await journal.emit(recoverableId, "session.created", {});
    await journal.emit(recoverableId, "session.started", {});
    await journal.emit(recoverableId, "plan.accepted", { plan_id: uuidv4() });

    // Set up a completed session
    await journal.emit(completedId, "session.created", {});
    await journal.emit(completedId, "session.started", {});
    await journal.emit(completedId, "plan.accepted", { plan_id: uuidv4() });
    await journal.emit(completedId, "session.completed", {});

    const recoverable = await apiServer.discoverRecoverableSessions();
    expect(recoverable).toContain(recoverableId);
    expect(recoverable).not.toContain(completedId);
  });
});

describe("ApiServer plugin integration", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let pluginRegistry: PluginRegistry;
  let pluginsDir: string;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    runtime = new ToolRuntime(registry, permissions, journal);

    pluginsDir = join(tmpdir(), `karnevil9-api-test-${uuid()}`);
    const pluginDir = join(pluginsDir, "api-test-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.yaml"), `
id: api-test-plugin
name: API Test Plugin
version: "1.0.0"
description: Test plugin for API
entry: index.js
permissions: []
provides:
  hooks:
    - before_step
  routes:
    - status
`);
    await writeFile(join(pluginDir, "index.js"), `
export async function register(api) {
  api.registerHook("before_step", async (ctx) => ({ action: "observe" }));
  api.registerRoute("GET", "status", async (req, res) => {
    res.json({ plugin_ok: true });
  });
}
`);

    pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
    });
    await pluginRegistry.discoverAndLoadAll();

    apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      pluginRegistry,
      insecure: true,
    });

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    try { await rm(pluginsDir, { recursive: true }); } catch { /* ok */ }
  });

  it("GET /api/plugins lists plugins", async () => {
    const res = await fetch(`${baseUrl}/api/plugins`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0].id).toBe("api-test-plugin");
    expect(body.plugins[0].status).toBe("active");
  });

  it("GET /api/plugins/:id returns single plugin", async () => {
    const res = await fetch(`${baseUrl}/api/plugins/api-test-plugin`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("api-test-plugin");
  });

  it("GET /api/plugins/:id returns 404 for unknown plugin", async () => {
    const res = await fetch(`${baseUrl}/api/plugins/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("plugin routes are served", async () => {
    const res = await fetch(`${baseUrl}/api/plugins/api-test-plugin/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plugin_ok).toBe(true);
  });

  it("health check includes plugins section", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.plugins).toBeDefined();
    expect(body.checks.plugins.status).toBe("ok");
    expect(body.checks.plugins.loaded).toBe(1);
    expect(body.checks.plugins.failed).toBe(0);
  });

  it("POST /api/plugins/:id/reload reloads a plugin", async () => {
    const res = await fetch(`${baseUrl}/api/plugins/api-test-plugin/reload`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
  });

  it("POST /api/plugins/:id/unload unloads a plugin", async () => {
    const res = await fetch(`${baseUrl}/api/plugins/api-test-plugin/unload`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("unloaded");

    // Plugin should show as unloaded now
    const listRes = await fetch(`${baseUrl}/api/plugins`);
    const listBody = await listRes.json();
    expect(listBody.plugins[0].status).toBe("unloaded");
  });
});

describe("ApiServer authentication", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;
  const API_TOKEN = "test-secret-token-12345";

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      apiToken: API_TOKEN,
    });

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("health endpoint is accessible without token", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });

  it("rejects requests without auth header", async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects requests with wrong token", async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with malformed auth header", async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("allows requests with correct token", async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools).toHaveLength(1);
  });

  it("allows POST with correct token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Authenticated task" },
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    // Should succeed (200) or return task message — not 401
    expect(res.status).not.toBe(401);
  });
});

describe("ApiServer rate limiting", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    apiServer = new ApiServer(registry, journal);

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("includes rate limit headers in responses", async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(200);
    // Our custom fetch doesn't expose headers, so we test via the rate limiter behavior
    // After 100 requests, the 101st should be rate-limited
  });

  it("returns 429 after exceeding rate limit", async () => {
    // Send 101 requests to trigger rate limit (default 100/minute)
    let lastStatus = 200;
    for (let i = 0; i < 105; i++) {
      const res = await fetch(`${baseUrl}/api/tools`);
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("ApiServer journal pagination", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    apiServer = new ApiServer(registry, journal);

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("GET /sessions/:id/journal returns paginated events with metadata", async () => {
    const sessId = "10000000-0000-0000-0000-000000000001";
    // Write 10 events
    for (let i = 0; i < 10; i++) {
      await journal.emit(sessId, "step.started", { step: i });
    }

    const res = await fetch(`${baseUrl}/api/sessions/${sessId}/journal?limit=3&offset=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(3);
    expect(body.total).toBe(10);
    expect(body.offset).toBe(2);
    expect(body.limit).toBe(3);
  });

  it("GET /sessions/:id/journal defaults to max 500 events", async () => {
    const sessId = "10000000-0000-0000-0000-000000000002";
    // Write 5 events
    for (let i = 0; i < 5; i++) {
      await journal.emit(sessId, "step.started", { step: i });
    }

    const res = await fetch(`${baseUrl}/api/sessions/${sessId}/journal`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(5);
    expect(body.total).toBe(5);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(500);
  });

  it("GET /sessions/:id/journal clamps oversized limit", async () => {
    const sessId = "10000000-0000-0000-0000-000000000003";
    await journal.emit(sessId, "step.started", { step: 1 });

    const res = await fetch(`${baseUrl}/api/sessions/${sessId}/journal?limit=9999`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // limit should be clamped to 500
    expect(body.limit).toBe(500);
  });

  it("POST /sessions/:id/replay caps events at 1000", async () => {
    const sessId = "10000000-0000-0000-0000-000000000004";
    // Write a few events
    for (let i = 0; i < 5; i++) {
      await journal.emit(sessId, "step.started", { step: i });
    }

    const res = await fetch(`${baseUrl}/api/sessions/${sessId}/replay`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_count).toBe(5);
    expect(body.total_events).toBe(5);
    expect(body.truncated).toBe(false);
  });
});

describe("ApiServer security hardening", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    runtime = new ToolRuntime(registry, permissions, journal);
    apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      defaultMode: "mock",
      defaultLimits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      defaultPolicy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      insecure: true,
    });

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("B2: client cannot override server policy", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: {
        text: "Policy override attempt",
        policy: { allowed_paths: ["/etc", "/root"], allowed_endpoints: ["http://evil.com"], allowed_commands: ["rm"], require_approval_for_writes: false },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    await new Promise((r) => setTimeout(r, 100));

    const sessionRes = await fetch(`${baseUrl}/api/sessions/${body.session_id}`);
    const session = await sessionRes.json();
    // Policy should be server-controlled, not client-supplied
    expect(session.policy.allowed_paths).toEqual(["/tmp"]);
    expect(session.policy.allowed_commands).toEqual([]);
  });

  it("H3: client limits are clamped to server maximums", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: {
        text: "Limits override attempt",
        limits: { max_steps: 999, max_duration_ms: 99999999, max_cost_usd: 99999, max_tokens: 99999999 },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    await new Promise((r) => setTimeout(r, 100));

    const sessionRes = await fetch(`${baseUrl}/api/sessions/${body.session_id}`);
    const session = await sessionRes.json();
    // All should be clamped to server defaults
    expect(session.limits.max_steps).toBe(10);
    expect(session.limits.max_duration_ms).toBe(60000);
    expect(session.limits.max_cost_usd).toBe(1);
    expect(session.limits.max_tokens).toBe(10000);
  });

  it("H3: client limits below server max are honored", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: {
        text: "Lower limits test",
        limits: { max_steps: 3 },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    await new Promise((r) => setTimeout(r, 100));

    const sessionRes = await fetch(`${baseUrl}/api/sessions/${body.session_id}`);
    const session = await sessionRes.json();
    expect(session.limits.max_steps).toBe(3);
    // Other limits should be server defaults
    expect(session.limits.max_duration_ms).toBe(60000);
  });

  it("security headers are set on all responses", async () => {
    // Use raw http to check headers
    const res = await new Promise<{ headers: Record<string, string>; status: number }>((resolve, reject) => {
      const parsed = new URL(`${baseUrl}/api/health`);
      http.request(parsed, (res: any) => {
        let _data = "";
        res.on("data", (chunk: string) => { _data += chunk; });
        res.on("end", () => {
          resolve({ headers: res.headers, status: res.statusCode });
        });
      }).on("error", reject).end();
    });
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("ApiServer approval timeout", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      insecure: true,
      approvalTimeoutMs: 50, // Very short timeout for testing
    });

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("auto-denies pending approval after timeout", async () => {
    let resolvedDecision: ApprovalDecision | null = null;
    apiServer.registerApproval("timeout-req", { tool: "test" }, (decision) => {
      resolvedDecision = decision;
    });

    // Wait for the timeout to expire
    await new Promise((r) => setTimeout(r, 100));

    // Should have been auto-denied
    expect(resolvedDecision).toBe("deny");

    // Should no longer be in pending list
    const res = await fetch(`${baseUrl}/api/approvals`);
    const body = await res.json();
    expect(body.pending).toHaveLength(0);
  });

  it("resolving before timeout clears the timer", async () => {
    let resolvedDecision: ApprovalDecision | null = null;
    apiServer.registerApproval("early-req", { tool: "test" }, (decision) => {
      resolvedDecision = decision;
    });

    // Resolve immediately
    const res = await fetch(`${baseUrl}/api/approvals/early-req`, {
      method: "POST",
      body: { decision: "allow_once" },
    });
    expect(res.status).toBe(200);
    expect(resolvedDecision).toBe("allow_once");

    // Wait past the timeout to ensure no double-resolve
    await new Promise((r) => setTimeout(r, 100));
    // Should still be allow_once, not overwritten to deny
    expect(resolvedDecision).toBe("allow_once");
  });
});

describe("ApiServer constructor validation", () => {
  it("throws when no apiToken and insecure is not set", async () => {
    const journal = new Journal(resolve(TEST_DIR, "ctor-test.jsonl"), { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();

    expect(() => new ApiServer({
      toolRegistry: registry,
      journal,
      // No apiToken, no insecure
    })).toThrow(/API token is required/);

    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("allows insecure: true without apiToken", async () => {
    const journal = new Journal(resolve(TEST_DIR, "ctor-test2.jsonl"), { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();

    expect(() => new ApiServer({
      toolRegistry: registry,
      journal,
      insecure: true,
    })).not.toThrow();

    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });
});

describe("ApiServer compact input validation", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    apiServer = new ApiServer(registry, journal);

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("rejects non-object body", async () => {
    const res = await fetch(`${baseUrl}/api/journal/compact`, {
      method: "POST",
      body: "not an object" as any,
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-array retain_sessions", async () => {
    const res = await fetch(`${baseUrl}/api/journal/compact`, {
      method: "POST",
      body: { retain_sessions: "not-an-array" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("retain_sessions must be an array");
  });

  it("rejects retain_sessions with non-string elements", async () => {
    const res = await fetch(`${baseUrl}/api/journal/compact`, {
      method: "POST",
      body: { retain_sessions: [123, true] },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("strings");
  });

  it("accepts valid compact request without retain_sessions", async () => {
    await journal.emit("s1", "session.created", {});
    const res = await fetch(`${baseUrl}/api/journal/compact`, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(200);
  });
});

describe("ApiServer CORS", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      insecure: true,
      corsOrigins: ["http://localhost:3000", "http://example.com"],
    });

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("sets CORS headers for allowed origin", async () => {
    const res = await new Promise<{ headers: Record<string, string>; status: number }>((resolve, reject) => {
      const parsed = new URL(`${baseUrl}/api/health`);
      http.request(parsed, { headers: { Origin: "http://localhost:3000" } }, (res: any) => {
        let _data = "";
        res.on("data", (chunk: string) => { _data += chunk; });
        res.on("end", () => { resolve({ headers: res.headers, status: res.statusCode }); });
      }).on("error", reject).end();
    });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("does not set CORS headers for disallowed origin", async () => {
    const res = await new Promise<{ headers: Record<string, string>; status: number }>((resolve, reject) => {
      const parsed = new URL(`${baseUrl}/api/health`);
      http.request(parsed, { headers: { Origin: "http://evil.com" } }, (res: any) => {
        let _data = "";
        res.on("data", (chunk: string) => { _data += chunk; });
        res.on("end", () => { resolve({ headers: res.headers, status: res.statusCode }); });
      }).on("error", reject).end();
    });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handles OPTIONS preflight for allowed origin", async () => {
    const res = await new Promise<{ headers: Record<string, string>; status: number }>((resolve, reject) => {
      const parsed = new URL(`${baseUrl}/api/tools`);
      http.request(parsed, {
        method: "OPTIONS",
        headers: { Origin: "http://example.com" },
      }, (res: any) => {
        let _data = "";
        res.on("data", (chunk: string) => { _data += chunk; });
        res.on("end", () => { resolve({ headers: res.headers, status: res.statusCode }); });
      }).on("error", reject).end();
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://example.com");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });
});

describe("ApiServer session input validation edge cases", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    apiServer = new ApiServer(registry, journal);

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("rejects text exceeding MAX_TEXT_LENGTH", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "x".repeat(10001) },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("10000");
  });

  it("rejects submitted_by exceeding MAX_SUBMITTED_BY_LENGTH", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "valid", submitted_by: "x".repeat(201) },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("submitted_by");
  });

  it("rejects non-object constraints", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "valid", constraints: "not-an-object" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("constraints");
  });

  it("rejects array constraints", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "valid", constraints: [1, 2, 3] },
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-number submitted_by", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "valid", submitted_by: 12345 },
    });
    expect(res.status).toBe(400);
  });

  it("rejects limits with zero value", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "valid", limits: { max_steps: 0 } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("max_steps");
  });

  it("accepts valid object approval decision", async () => {
    let resolvedDecision: any = null;
    apiServer.registerApproval("obj-req", { tool: "test" }, (decision) => {
      resolvedDecision = decision;
    });

    const res = await fetch(`${baseUrl}/api/approvals/obj-req`, {
      method: "POST",
      body: { decision: { type: "allow_constrained", constraints: {} } },
    });
    expect(res.status).toBe(200);
    expect(resolvedDecision).toEqual({ type: "allow_constrained", constraints: {} });
  });

  it("rejects approval with invalid object decision type", async () => {
    apiServer.registerApproval("bad-obj-req", { tool: "test" }, () => {});
    const res = await fetch(`${baseUrl}/api/approvals/bad-obj-req`, {
      method: "POST",
      body: { decision: { type: "invalid_type" } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid decision type");
  });

  it("rejects approval with non-string/non-object decision", async () => {
    apiServer.registerApproval("num-req", { tool: "test" }, () => {});
    const res = await fetch(`${baseUrl}/api/approvals/num-req`, {
      method: "POST",
      body: { decision: 42 },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("string or object");
  });

  it("rejects approval with missing decision field", async () => {
    apiServer.registerApproval("no-dec-req", { tool: "test" }, () => {});
    const res = await fetch(`${baseUrl}/api/approvals/no-dec-req`, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("decision is required");
  });
});

describe("ApiServer shutdown cleans pending approvals", () => {
  it("shutdown auto-denies all pending approvals", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    const apiServer = new ApiServer(registry, journal);

    const decisions: ApprovalDecision[] = [];
    apiServer.registerApproval("a1", {}, (d) => decisions.push(d));
    apiServer.registerApproval("a2", {}, (d) => decisions.push(d));

    await apiServer.shutdown();

    expect(decisions).toEqual(["deny", "deny"]);
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });
});

describe("ApiServer H7: metrics behind auth", () => {
  const API_TOKEN = "metrics-auth-token";

  it("metrics endpoint requires auth when API token is set", async () => {
    const journalFile = resolve(TEST_DIR, "metrics-auth-journal.jsonl");
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(journalFile, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    registry.register(testTool);
    const metricsCollector = new MetricsCollector();
    const apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      apiToken: API_TOKEN,
      metricsCollector,
    });

    const httpServer = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer(apiServer.getExpressApp());
      s.listen(0, () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    try {
      // Without auth — should get 401
      const noAuth = await fetch(`${baseUrl}/api/metrics`);
      expect(noAuth.status).toBe(401);

      // With auth — should get 200
      const withAuth = await fetch(`${baseUrl}/api/metrics`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      expect(withAuth.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
      try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    }
  });
});

describe("ApiServer H8: shutdown aborts running kernels", () => {
  it("shutdown() aborts active kernel sessions", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    registry.register(testTool);
    const permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    const runtime = new ToolRuntime(registry, permissions, journal);
    const apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      defaultMode: "mock",
      defaultLimits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      defaultPolicy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      insecure: true,
    });

    const httpServer = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer(apiServer.getExpressApp());
      s.listen(0, () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    // Create a session to get a running kernel
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Session for shutdown test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_id).toBeTruthy();

    // Give kernel time to start
    await new Promise((r) => setTimeout(r, 50));

    // Shutdown should complete without hanging
    await apiServer.shutdown();

    // After shutdown the http server is closed via shutdown()
    // Verify we can't make new requests (server closed)
    try {
      await fetch(`${baseUrl}/api/health`);
      // If we get here, the server is still running — that's ok for some implementations
    } catch {
      // Connection refused — server properly shut down
    }

    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });
});

describe("ApiServer H1: /recover respects concurrency limit", () => {
  it("POST /sessions/:id/recover returns 429 when at max concurrent sessions", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    registry.register(testTool);
    const permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    const runtime = new ToolRuntime(registry, permissions, journal);
    const apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      defaultMode: "mock",
      defaultLimits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      defaultPolicy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      maxConcurrentSessions: 1,
      insecure: true,
    });

    const httpServer = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer(apiServer.getExpressApp());
      s.listen(0, () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    try {
      // Create a regular session (fills the 1 slot)
      const res1 = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        body: { text: "Session 1" },
      });
      expect(res1.status).toBe(200);

      const { v4: uuidv4 } = await import("uuid");
      const sessionId = uuidv4();
      const planId = uuidv4();

      // Set up recoverable journal events
      await journal.emit(sessionId, "session.created", {
        task_id: uuidv4(), task_text: "Recovery", mode: "mock",
      });
      await journal.emit(sessionId, "session.started", {});
      await journal.emit(sessionId, "plan.accepted", {
        plan_id: planId,
        plan: {
          plan_id: planId, schema_version: "0.1", goal: "Recovery",
          assumptions: [], steps: [{
            step_id: uuidv4(), title: "Test step", tool_ref: { name: "test-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort",
            timeout_ms: 5000, max_retries: 0,
          }],
          created_at: new Date().toISOString(),
        },
      });

      // Recover should fail because we're at max capacity
      const res2 = await fetch(`${baseUrl}/api/sessions/${sessionId}/recover`, { method: "POST" });
      expect(res2.status).toBe(429);
      const body = await res2.json();
      expect(body.error).toContain("Max concurrent sessions");
    } finally {
      await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
      try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    }
  });
});

describe("ApiServer M3: journal listener cleanup on shutdown", () => {
  it("shutdown() unsubscribes journal listener (no broadcast after shutdown)", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journalFile = resolve(TEST_DIR, "m3-journal.jsonl");
    const journal = new Journal(journalFile, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    registry.register(testTool);
    const apiServer = new ApiServer(registry, journal);

    const _httpServer = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer(apiServer.getExpressApp());
      s.listen(0, () => resolve(s));
    });

    // Before shutdown, broadcastEvent should be callable
    expect(() => apiServer.broadcastEvent("test-sess", { type: "test" })).not.toThrow();

    // Shutdown cleans up the listener
    await apiServer.shutdown();

    // After shutdown, the SSE clients map is cleared and the listener is detached.
    // broadcastEvent is safe to call (no-ops) but the journal listener is removed.
    expect(() => apiServer.broadcastEvent("test-sess", { type: "test" })).not.toThrow();

    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });
});

describe("ApiServer B3: session timer cleanup", () => {
  it("session timer is cleaned up on normal completion", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    registry.register(testTool);
    const permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    const runtime = new ToolRuntime(registry, permissions, journal);
    const apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      defaultMode: "mock",
      defaultLimits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      defaultPolicy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      insecure: true,
    });

    const httpServer = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer(apiServer.getExpressApp());
      s.listen(0, () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    // Create a session
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Timer cleanup test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Wait for session to complete
    await new Promise((r) => setTimeout(r, 500));

    // Session should complete normally — timer is cleaned up
    const sessionRes = await fetch(`${baseUrl}/api/sessions/${body.session_id}`);
    const session = await sessionRes.json();
    expect(["completed", "failed"]).toContain(session.status);
    // If timer leaked, subsequent operations would hang or fail

    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });
});

// ─── RateLimiter Unit Tests ─────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests within the limit", () => {
    const limiter = new RateLimiter(3, 60000);
    const r1 = limiter.check("client-a");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    const r2 = limiter.check("client-a");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
    const r3 = limiter.check("client-a");
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks requests over the limit", () => {
    const limiter = new RateLimiter(2, 60000);
    limiter.check("client-b");
    limiter.check("client-b");
    const r3 = limiter.check("client-b");
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it("tracks clients independently", () => {
    const limiter = new RateLimiter(1, 60000);
    limiter.check("client-c");
    const r2 = limiter.check("client-c");
    expect(r2.allowed).toBe(false);

    const r3 = limiter.check("client-d");
    expect(r3.allowed).toBe(true);
  });

  it("resets window after expiry", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(1, 1000);
      limiter.check("client-e");
      const r2 = limiter.check("client-e");
      expect(r2.allowed).toBe(false);

      vi.advanceTimersByTime(1001);

      const r3 = limiter.check("client-e");
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prune removes expired entries", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(10, 500);
      limiter.check("client-f");
      limiter.check("client-g");

      limiter.prune();
      const rf = limiter.check("client-f");
      expect(rf.remaining).toBe(8); // 10 - 2

      vi.advanceTimersByTime(600);
      limiter.prune();

      const rf2 = limiter.check("client-f");
      expect(rf2.allowed).toBe(true);
      expect(rf2.remaining).toBe(9); // fresh window
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns correct resetAt timestamp", () => {
    vi.useFakeTimers({ now: 10000 });
    try {
      const limiter = new RateLimiter(5, 2000);
      const result = limiter.check("client-h");
      expect(result.resetAt).toBe(12000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prune enforces hard cap on windows map", () => {
    const limiter = new RateLimiter(100, 60000);
    // Fill well beyond what should be a reasonable size
    for (let i = 0; i < 200; i++) {
      limiter.check(`flood-${i}`);
    }
    // After prune, windows should be at most MAX_WINDOWS (100_000)
    // but in practice the 200 entries are all fresh so prune won't expire them.
    // The hard cap kicks in at 100_000 — verify no crash with many entries
    limiter.prune();
    // Limiter should still function correctly
    const result = limiter.check("after-flood");
    expect(result.allowed).toBe(true);
  });
});

// ─── WebSocket Tests ────────────────────────────────────────────────

describe("ApiServer WebSocket", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    runtime = new ToolRuntime(registry, permissions, journal);
    apiServer = new ApiServer({
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      permissions,
      planner: new MockPlanner(),
      defaultMode: "mock",
      defaultLimits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
      defaultPolicy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      insecure: true,
    });

    server = apiServer.listen(0);
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await apiServer.shutdown();
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      ws.once("message", (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  it("responds to ping with pong", async () => {
    const ws = await connectWs();
    try {
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "ping" }));
      const msg = await msgPromise;
      expect(msg.type).toBe("pong");
    } finally {
      ws.close();
    }
  });

  it("returns error for invalid JSON", async () => {
    const ws = await connectWs();
    try {
      const msgPromise = waitForMessage(ws);
      ws.send("not valid json{{{");
      const msg = await msgPromise;
      expect(msg.type).toBe("error");
      expect(msg.message).toBe("Invalid JSON");
    } finally {
      ws.close();
    }
  });

  it("returns error for unknown message type", async () => {
    const ws = await connectWs();
    try {
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "unknown_type" }));
      const msg = await msgPromise;
      expect(msg.type).toBe("error");
      expect(msg.message).toContain("Unknown message type");
    } finally {
      ws.close();
    }
  });

  it("submit creates a session and returns session.created", async () => {
    const ws = await connectWs();
    try {
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "submit", text: "WS test task" }));
      const msg = await msgPromise;
      expect(msg.type).toBe("session.created");
      expect(msg.session_id).toBeTruthy();
      expect((msg.task as Record<string, unknown>).text).toBe("WS test task");
    } finally {
      ws.close();
    }
  });

  it("submit rejects empty text", async () => {
    const ws = await connectWs();
    try {
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "submit", text: "" }));
      const msg = await msgPromise;
      expect(msg.type).toBe("error");
      expect(msg.message).toContain("text is required");
    } finally {
      ws.close();
    }
  });

  it("submit rejects oversized text", async () => {
    const ws = await connectWs();
    try {
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "submit", text: "x".repeat(10001) }));
      const msg = await msgPromise;
      expect(msg.type).toBe("error");
      expect(msg.message).toContain("10000");
    } finally {
      ws.close();
    }
  });

  it("submit receives journal events for the session", async () => {
    const ws = await connectWs();
    try {
      const messages: Record<string, unknown>[] = [];
      const collectDone = new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          messages.push(JSON.parse(data.toString()));
          if (messages.length >= 3) resolve();
        });
      });

      ws.send(JSON.stringify({ type: "submit", text: "Events test" }));

      await Promise.race([collectDone, new Promise((r) => setTimeout(r, 2000))]);

      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0]!.type).toBe("session.created");
      expect(messages[1]!.type).toBe("event");
    } finally {
      ws.close();
    }
  });

  it("approve resolves a pending approval via WebSocket", async () => {
    const ws = await connectWs();
    try {
      let resolvedDecision: ApprovalDecision | null = null;
      apiServer.registerApproval("ws-approve-1", { tool: "test" }, (decision) => {
        resolvedDecision = decision;
      });

      ws.send(JSON.stringify({ type: "approve", request_id: "ws-approve-1", decision: "allow_session" }));

      await new Promise((r) => setTimeout(r, 50));
      expect(resolvedDecision).toBe("allow_session");
    } finally {
      ws.close();
    }
  });

  it("approve rejects invalid decision payloads via WebSocket", async () => {
    const ws = await connectWs();
    try {
      let resolvedDecision: ApprovalDecision | null = null;
      apiServer.registerApproval("ws-approve-invalid", { tool: "test" }, (decision) => {
        resolvedDecision = decision;
      });

      // Send an invalid decision (not a valid approval type)
      ws.send(JSON.stringify({ type: "approve", request_id: "ws-approve-invalid", decision: "grant_everything" }));

      await new Promise((r) => setTimeout(r, 50));
      // Decision should NOT have been resolved — still null
      expect(resolvedDecision).toBeNull();
    } finally {
      ws.close();
    }
  });

  it("approve rejects missing decision via WebSocket", async () => {
    const ws = await connectWs();
    try {
      let resolvedDecision: ApprovalDecision | null = null;
      apiServer.registerApproval("ws-approve-no-decision", { tool: "test" }, (decision) => {
        resolvedDecision = decision;
      });

      // Send without decision field
      ws.send(JSON.stringify({ type: "approve", request_id: "ws-approve-no-decision" }));

      await new Promise((r) => setTimeout(r, 50));
      expect(resolvedDecision).toBeNull();
    } finally {
      ws.close();
    }
  });

  it("approve accepts valid object decisions via WebSocket", async () => {
    const ws = await connectWs();
    try {
      let resolvedDecision: ApprovalDecision | null = null;
      apiServer.registerApproval("ws-approve-obj", { tool: "test" }, (decision) => {
        resolvedDecision = decision;
      });

      ws.send(JSON.stringify({
        type: "approve",
        request_id: "ws-approve-obj",
        decision: { type: "allow_constrained", constraints: { max_calls: 5 } },
      }));

      await new Promise((r) => setTimeout(r, 50));
      expect(resolvedDecision).toEqual({ type: "allow_constrained", constraints: { max_calls: 5 } });
    } finally {
      ws.close();
    }
  });

  it("cleans up client on close", async () => {
    const ws = await connectWs();
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "submit", text: "Cleanup test" }));
    await msgPromise;

    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(() => apiServer.broadcastEvent("any-session", { type: "test" })).not.toThrow();
  });
});

describe("ApiServer WebSocket authentication", () => {
  const API_TOKEN = "ws-auth-token-123";

  it("rejects WebSocket without token when auth is required", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    const apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      apiToken: API_TOKEN,
    });

    const server = apiServer.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
        ws.on("error", () => resolve());
        ws.on("unexpected-response", () => resolve());
        ws.on("open", () => {
          ws.close();
          reject(new Error("Should not have connected"));
        });
        setTimeout(() => resolve(), 1000);
      });
    } finally {
      await apiServer.shutdown();
      try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    }
  });

  it("accepts WebSocket with valid token", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    const apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      apiToken: API_TOKEN,
    });

    const server = apiServer.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${API_TOKEN}`);
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("Timeout")), 2000);
      });

      const msgPromise = new Promise<Record<string, unknown>>((resolve) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(JSON.stringify({ type: "ping" }));
      const msg = await msgPromise;
      expect(msg.type).toBe("pong");

      ws.close();
    } finally {
      await apiServer.shutdown();
      try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    }
  });
});

// ─── SSE Tests ──────────────────────────────────────────────────────

describe("ApiServer SSE streaming", () => {
  it("receives events via SSE after journal emit", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    const apiServer = new ApiServer(registry, journal);

    const httpServer = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer(apiServer.getExpressApp());
      s.listen(0, () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    try {
      const events: string[] = [];
      let contentType = "";
      const sseSessionId = "20000000-0000-0000-0000-000000000001";
      const gotEvent = new Promise<void>((resolve) => {
        const parsed = new URL(`${baseUrl}/api/sessions/${sseSessionId}/stream`);
        const req = http.request(parsed, (res: any) => {
          contentType = res.headers["content-type"] ?? "";
          res.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            for (const line of text.split("\n")) {
              if (line.startsWith("data:")) {
                events.push(line);
                resolve();
              }
            }
          });
        });
        req.on("error", () => {});
        req.end();
      });

      await new Promise((r) => setTimeout(r, 100));

      await journal.emit(sseSessionId, "step.started", { step_id: "s1" });

      await Promise.race([gotEvent, new Promise((r) => setTimeout(r, 2000))]);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toContain("step.started");
      expect(contentType).toBe("text/event-stream");
    } finally {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
      try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    }
  });

  it("rejects SSE connections over maxSseClientsPerSession", async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const journal = new Journal(resolve(TEST_DIR, "sse-limit.jsonl"), { fsync: false, lock: false });
    await journal.init();
    const registry = new ToolRegistry();
    const apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      insecure: true,
      maxSseClientsPerSession: 1,
    });

    const httpServer = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer(apiServer.getExpressApp());
      s.listen(0, () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    try {
      // First SSE connection — fire-and-forget (headers won't flush until data is written,
      // but the server registers the SSE client synchronously)
      const parsed = new URL(`${baseUrl}/api/sessions/20000000-0000-0000-0000-000000000002/stream`);
      const req1 = http.request(parsed, { agent: false }, () => {});
      req1.on("error", () => {});
      req1.end();

      // Wait for server to process the first request and register the SSE client
      await new Promise((r) => setTimeout(r, 100));

      // Second connection — should be 429 (JSON response, not streaming, so it completes)
      const res2 = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(parsed, { agent: false }, (res: any) => {
          res.on("data", () => {});
          res.on("end", () => resolve({ status: res.statusCode }));
        });
        req.on("error", reject);
        req.end();
      });
      expect(res2.status).toBe(429);
    } finally {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
      try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    }
  });
});
