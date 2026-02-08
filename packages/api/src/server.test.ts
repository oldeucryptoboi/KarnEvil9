import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Journal } from "@jarvis/journal";
import { ToolRegistry, ToolRuntime } from "@jarvis/tools";
import { PermissionEngine } from "@jarvis/permissions";
import { PluginRegistry } from "@jarvis/plugins";
import { MockPlanner } from "@jarvis/planner";
import type { ToolManifest, ApprovalDecision } from "@jarvis/schemas";
import { ApiServer } from "./server.js";

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
    const req = (parsed.protocol === "https:" ? require("node:https") : require("node:http")).request(
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
    journal = new Journal(TEST_FILE, { fsync: false });
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

  it("GET /api/sessions/:id returns 404 for unknown session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent`);
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
    await journal.emit("sess-1", "session.created", { task: "test" });
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/journal`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });

  it("POST /api/sessions/:id/replay returns events", async () => {
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/replay`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_count).toBe(2);
  });

  it("POST /api/sessions/:id/replay returns 404 for empty session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/replay`, { method: "POST" });
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
    journal = new Journal(TEST_FILE, { fsync: false });
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

  it("POST /api/sessions accepts custom mode and limits", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: {
        text: "Custom config test",
        mode: "mock",
        limits: { max_steps: 5 },
        policy: { allowed_paths: ["/custom"] },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_id).toBeTruthy();

    await new Promise((r) => setTimeout(r, 100));

    const sessionRes = await fetch(`${baseUrl}/api/sessions/${body.session_id}`);
    const session = await sessionRes.json();
    expect(session.limits.max_steps).toBe(5);
    expect(session.policy.allowed_paths).toContain("/custom");
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
    const { Kernel } = await import("@jarvis/kernel");
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
    journal = new Journal(TEST_FILE, { fsync: false });
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
    journal = new Journal(TEST_FILE, { fsync: false });
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

  it("POST /sessions/:id/recover returns 404 for nonexistent session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/recover`, { method: "POST" });
    expect(res.status).toBe(404);
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
    journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    runtime = new ToolRuntime(registry, permissions, journal);

    pluginsDir = join(tmpdir(), `jarvis-api-test-${uuid()}`);
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
    journal = new Journal(TEST_FILE, { fsync: false });
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
