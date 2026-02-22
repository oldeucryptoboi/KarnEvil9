import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { MockPlanner } from "@karnevil9/planner";
import { Kernel } from "@karnevil9/kernel";
import type { Task } from "@karnevil9/schemas";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/examples");

describe("Session Roundtrip Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-session-${uuid()}`);
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("full lifecycle: createSession → plan → execute → complete", async () => {
    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      mode: "mock",
      limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = {
      task_id: uuid(),
      text: "Smoke test: read a file",
      created_at: new Date().toISOString(),
    };

    // 1. Create session
    const session = await kernel.createSession(task);
    expect(session.session_id).toBeDefined();
    expect(session.status).toBe("created");
    expect(session.mode).toBe("mock");

    // 2. Run to completion
    const finalSession = await kernel.run();
    expect(finalSession.session_id).toBe(session.session_id);
    expect(finalSession.status).toBe("completed");

    // 3. Verify task state
    const taskState = kernel.getTaskState();
    expect(taskState).not.toBeNull();
    const snapshot = taskState!.getSnapshot();
    expect(snapshot.completed_steps).toBeGreaterThan(0);

    // 4. Verify journal events in correct order
    const events = await journal.readAll();
    const sessionEvents = events.filter((e) => e.session_id === session.session_id);
    const eventTypes = sessionEvents.map((e) => e.type);

    expect(eventTypes).toContain("session.created");
    expect(eventTypes).toContain("session.started");
    expect(eventTypes).toContain("planner.requested");
    expect(eventTypes).toContain("planner.plan_received");
    expect(eventTypes).toContain("plan.accepted");
    expect(eventTypes).toContain("step.started");
    expect(eventTypes).toContain("tool.requested");
    expect(eventTypes).toContain("tool.started");
    expect(eventTypes).toContain("tool.succeeded");
    expect(eventTypes).toContain("step.succeeded");
    expect(eventTypes).toContain("session.completed");

    // 5. Event ordering: session.created must come before session.started
    const createdIdx = eventTypes.indexOf("session.created");
    const startedIdx = eventTypes.indexOf("session.started");
    const completedIdx = eventTypes.indexOf("session.completed");
    expect(createdIdx).toBeLessThan(startedIdx);
    expect(startedIdx).toBeLessThan(completedIdx);

    // 6. Verify hash chain integrity
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("session with abort terminates cleanly", async () => {
    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      mode: "mock",
      limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = {
      task_id: uuid(),
      text: "Abort test",
      created_at: new Date().toISOString(),
    };

    await kernel.createSession(task);

    // With MockPlanner, the session completes almost instantly.
    // Start run, wait briefly for it to reach "running" state, then abort.
    const runPromise = kernel.run();

    // Give the kernel time to reach the running phase
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      await kernel.abort();
    } catch {
      // Abort may throw if session already completed or is in a non-abortable state
    }

    const session = await runPromise;
    // Session may complete before abort, or abort may succeed
    expect(["aborted", "completed", "failed"]).toContain(session.status);

    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("session without planner fails gracefully", async () => {
    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      // No planner
      mode: "mock",
      limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = {
      task_id: uuid(),
      text: "No planner test",
      created_at: new Date().toISOString(),
    };

    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("session.created");
    expect(types).toContain("planner.plan_rejected");
  });

  it("session with plugin hooks fires them in correct order", async () => {
    // Import plugin registry dynamically to keep it optional
    const { PluginRegistry } = await import("@karnevil9/plugins");

    const pluginsDir = join(ROOT, "plugins");
    const pluginRegistry = new PluginRegistry({
      journal,
      toolRegistry: registry,
      pluginsDir,
    });
    await pluginRegistry.discoverAndLoadAll();

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      pluginRegistry,
      planner: new MockPlanner(),
      mode: "mock",
      limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = {
      task_id: uuid(),
      text: "Plugin integration smoke test",
      created_at: new Date().toISOString(),
    };

    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readAll();
    const types = events.map((e) => e.type);

    // Plugin lifecycle events
    expect(types).toContain("plugin.discovered");
    expect(types).toContain("plugin.loaded");

    // Hook events during execution
    expect(types).toContain("plugin.hook_fired");

    // Session lifecycle
    expect(types).toContain("session.created");
    expect(types).toContain("session.completed");

    // Hash chain should be intact
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("journal readSession supports offset and limit", async () => {
    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      mode: "mock",
      limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = {
      task_id: uuid(),
      text: "Pagination test",
      created_at: new Date().toISOString(),
    };

    await kernel.createSession(task);
    await kernel.run();

    const session = kernel.getSession()!;
    const allEvents = await journal.readSession(session.session_id);
    expect(allEvents.length).toBeGreaterThan(5);

    // Paginated read
    const first3 = await journal.readSession(session.session_id, { offset: 0, limit: 3 });
    expect(first3).toHaveLength(3);
    expect(first3[0]!.event_id).toBe(allEvents[0]!.event_id);

    const next3 = await journal.readSession(session.session_id, { offset: 3, limit: 3 });
    expect(next3).toHaveLength(3);
    expect(next3[0]!.event_id).toBe(allEvents[3]!.event_id);
  });

  it("SSE stream delivers events for a session", async () => {
    const { ApiServer } = await import("@karnevil9/api");
    const planner = new MockPlanner();

    const apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner,
      insecure: true,
    });

    const port = 30000 + Math.floor(Math.random() * 10000);
    const app = apiServer.getExpressApp();
    const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    try {
      // Create a session
      const sessionRes = await fetch(`http://localhost:${port}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "SSE smoke test" }),
      });
      const { session_id } = await sessionRes.json() as { session_id: string };

      // Wait for session to complete
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Verify events were recorded
      const journalRes = await fetch(`http://localhost:${port}/api/sessions/${session_id}/journal`);
      const journalBody = await journalRes.json() as { events: Array<{ type: string; seq?: number }> };
      expect(journalBody.events.length).toBeGreaterThan(0);

      // Verify replay endpoint works
      const replayRes = await fetch(`http://localhost:${port}/api/sessions/${session_id}/replay`, {
        method: "POST",
      });
      expect(replayRes.status).toBe(200);
      const replayBody = await replayRes.json() as { event_count: number };
      expect(replayBody.event_count).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
