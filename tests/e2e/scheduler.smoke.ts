import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm, readFile } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@jarvis/journal";
import { ToolRegistry, ToolRuntime } from "@jarvis/tools";
import { PermissionEngine } from "@jarvis/permissions";
import { MockPlanner } from "@jarvis/planner";
import { Kernel } from "@jarvis/kernel";
import { ApiServer } from "@jarvis/api";
import { PluginRegistry } from "@jarvis/plugins";
import { ScheduleStore, Scheduler } from "@jarvis/scheduler";
import type { SessionFactory } from "@jarvis/scheduler";
import type { Task, Schedule } from "@jarvis/schemas";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/examples");

describe("Scheduler Smoke Tests", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    testDir = join(tmpdir(), `jarvis-e2e-scheduler-${uuid()}`);
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

  // ─── Standalone Scheduler Tests ──────────────────────────────────

  describe("standalone scheduler lifecycle", () => {
    it("start → create schedule → tick fires job → stop", async () => {
      const store = new ScheduleStore(join(testDir, "schedules.jsonl"));
      const sessionsCreated: string[] = [];

      const sessionFactory: SessionFactory = async (task) => {
        const id = `factory-${uuid()}`;
        sessionsCreated.push(id);
        return { session_id: id, status: "created" };
      };

      const scheduler = new Scheduler({
        store,
        journal,
        sessionFactory,
        tickIntervalMs: 50,
      });

      // 1. Start
      await scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      // 2. Create a schedule with next_run_at in the past so it fires immediately
      const sched = await scheduler.createSchedule({
        name: "smoke-immediate",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "smoke test job" },
      });
      expect(sched.schedule_id).toBeTruthy();
      expect(sched.status).toBe("active");

      // Force it to fire on next tick
      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      // 3. Wait for tick to fire
      await new Promise((r) => setTimeout(r, 300));

      // 4. Verify the job ran
      expect(sessionsCreated.length).toBe(1);
      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.run_count).toBe(1);
      expect(updated.failure_count).toBe(0);
      expect(updated.last_run_at).toBeTruthy();

      // 5. Verify journal events
      const events = await journal.readSession("scheduler");
      const types = events.map((e) => e.type);
      expect(types).toContain("scheduler.started");
      expect(types).toContain("scheduler.schedule_created");
      expect(types).toContain("scheduler.job_triggered");
      expect(types).toContain("scheduler.job_completed");

      // 6. Stop
      await scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
      expect(types).toContain("scheduler.started");

      // Verify stopped event
      const eventsAfterStop = await journal.readSession("scheduler");
      expect(eventsAfterStop.map((e) => e.type)).toContain("scheduler.stopped");
    });

    it("one-shot 'at' schedule completes and does not re-fire", async () => {
      const store = new ScheduleStore(join(testDir, "schedules.jsonl"));
      let callCount = 0;

      const scheduler = new Scheduler({
        store,
        journal,
        sessionFactory: async () => {
          callCount++;
          return { session_id: `at-${callCount}`, status: "created" };
        },
        tickIntervalMs: 50,
      });

      await scheduler.start();

      // Create an "at" trigger set to the past
      const sched = await scheduler.createSchedule({
        name: "one-shot",
        trigger: { type: "at", at: new Date(Date.now() - 500).toISOString() },
        action: { type: "createSession", task_text: "fire once" },
      });

      // Wait for a few ticks
      await new Promise((r) => setTimeout(r, 400));

      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.status).toBe("completed");
      expect(updated.run_count).toBe(1);
      expect(updated.next_run_at).toBeNull();
      expect(callCount).toBe(1); // only fired once

      await scheduler.stop();
    });

    it("failed jobs increment failure_count and pause at max_failures", async () => {
      const store = new ScheduleStore(join(testDir, "schedules.jsonl"));

      const scheduler = new Scheduler({
        store,
        journal,
        sessionFactory: async () => {
          throw new Error("intentional failure");
        },
        tickIntervalMs: 50,
      });

      await scheduler.start();

      const sched = await scheduler.createSchedule({
        name: "failing-job",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "will fail" },
        options: { max_failures: 2 },
      });

      // Force two consecutive failures
      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      await new Promise((r) => setTimeout(r, 300));

      // After first failure, it should still be active but with failure_count = 1
      const afterFirst = scheduler.getSchedule(sched.schedule_id)!;
      if (afterFirst.status === "active" && afterFirst.failure_count === 1) {
        // Trigger another failure
        afterFirst.next_run_at = new Date(Date.now() - 1000).toISOString();
        store.set(afterFirst);

        await new Promise((r) => setTimeout(r, 300));
      }

      const final = scheduler.getSchedule(sched.schedule_id)!;
      expect(final.failure_count).toBeGreaterThanOrEqual(2);
      expect(final.status).toBe("failed");
      expect(final.last_error).toBe("intentional failure");

      // Verify journal captured the failures
      const events = await journal.readSession("scheduler");
      const failEvents = events.filter((e) => e.type === "scheduler.job_failed");
      expect(failEvents.length).toBeGreaterThanOrEqual(2);

      await scheduler.stop();
    });

    it("CRUD operations: create → get → update → pause → resume → delete", async () => {
      const store = new ScheduleStore(join(testDir, "schedules.jsonl"));

      const scheduler = new Scheduler({
        store,
        journal,
        sessionFactory: async () => ({ session_id: "s", status: "created" }),
        tickIntervalMs: 60_000,
      });

      await scheduler.start();

      // Create
      const sched = await scheduler.createSchedule({
        name: "crud-test",
        trigger: { type: "cron", expression: "0 9 * * 1-5" },
        action: { type: "createSession", task_text: "daily standup" },
        options: { tags: ["daily", "standup"], description: "Weekday standup" },
      });
      expect(sched.name).toBe("crud-test");
      expect(sched.status).toBe("active");
      expect(sched.next_run_at).toBeTruthy();

      // Get
      const fetched = scheduler.getSchedule(sched.schedule_id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("crud-test");

      // Update
      const updated = await scheduler.updateSchedule(sched.schedule_id, {
        name: "renamed-schedule",
        options: { description: "Updated description" },
      });
      expect(updated.name).toBe("renamed-schedule");

      // Pause
      const paused = await scheduler.pauseSchedule(sched.schedule_id);
      expect(paused.status).toBe("paused");

      // Resume
      const resumed = await scheduler.resumeSchedule(sched.schedule_id);
      expect(resumed.status).toBe("active");
      expect(resumed.next_run_at).toBeTruthy();

      // List
      const all = scheduler.listSchedules();
      expect(all.length).toBe(1);

      // Delete
      await scheduler.deleteSchedule(sched.schedule_id);
      expect(scheduler.getSchedule(sched.schedule_id)).toBeUndefined();
      expect(scheduler.listSchedules().length).toBe(0);

      await scheduler.stop();
    });

    it("persists schedules across restarts", async () => {
      const storePath = join(testDir, "schedules.jsonl");
      const store1 = new ScheduleStore(storePath);

      const scheduler1 = new Scheduler({
        store: store1,
        journal,
        sessionFactory: async () => ({ session_id: "s", status: "created" }),
        tickIntervalMs: 60_000,
      });

      await scheduler1.start();
      await scheduler1.createSchedule({
        name: "persist-me",
        trigger: { type: "every", interval: "30m" },
        action: { type: "createSession", task_text: "persistent task" },
      });
      await scheduler1.createSchedule({
        name: "persist-me-too",
        trigger: { type: "cron", expression: "*/15 * * * *" },
        action: { type: "emitEvent", event_type: "session.checkpoint", payload: { msg: "ping" } },
      });
      await scheduler1.stop();

      // Verify JSONL file exists and has content
      const content = await readFile(storePath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2);

      // "Restart" with a new store + scheduler
      const store2 = new ScheduleStore(storePath);
      const scheduler2 = new Scheduler({
        store: store2,
        journal,
        sessionFactory: async () => ({ session_id: "s", status: "created" }),
        tickIntervalMs: 60_000,
      });

      await scheduler2.start();
      const schedules = scheduler2.listSchedules();
      expect(schedules.length).toBe(2);
      expect(schedules.map((s) => s.name).sort()).toEqual(["persist-me", "persist-me-too"]);
      await scheduler2.stop();
    });

    it("emitEvent action writes to the journal", async () => {
      const store = new ScheduleStore(join(testDir, "schedules.jsonl"));

      const scheduler = new Scheduler({
        store,
        journal,
        sessionFactory: async () => ({ session_id: "s", status: "created" }),
        tickIntervalMs: 50,
      });

      await scheduler.start();

      const sched = await scheduler.createSchedule({
        name: "emit-test",
        trigger: { type: "every", interval: "1h" },
        action: {
          type: "emitEvent",
          session_id: "custom-target",
          event_type: "session.checkpoint",
          payload: { source: "scheduler-smoke" },
        },
      });

      // Force immediate execution
      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      await new Promise((r) => setTimeout(r, 300));

      // The emitEvent should have written to the custom session
      const targetEvents = await journal.readSession("custom-target");
      expect(targetEvents.length).toBe(1);
      expect(targetEvents[0]!.type).toBe("session.checkpoint");
      expect(targetEvents[0]!.payload.source).toBe("scheduler-smoke");

      await scheduler.stop();
    });
  });

  // ─── Scheduler + Kernel Integration ──────────────────────────────

  describe("scheduler + kernel integration", () => {
    it("scheduled job creates a real kernel session that runs to completion", async () => {
      const store = new ScheduleStore(join(testDir, "schedules.jsonl"));
      const completedSessions: string[] = [];

      const sessionFactory: SessionFactory = async (task, opts) => {
        const kernel = new Kernel({
          journal,
          toolRegistry: registry,
          toolRuntime: runtime,
          permissions,
          planner: new MockPlanner(),
          mode: opts?.mode ?? "mock",
          limits: { max_steps: 20, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
          policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
        });
        const session = await kernel.createSession(task);
        // Run in background
        void kernel.run().then((s) => {
          completedSessions.push(s.session_id);
        });
        return { session_id: session.session_id, status: session.status };
      };

      const scheduler = new Scheduler({
        store,
        journal,
        sessionFactory,
        tickIntervalMs: 50,
      });

      await scheduler.start();

      const sched = await scheduler.createSchedule({
        name: "kernel-integration",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "read a file" },
      });

      // Trigger immediately
      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      // Wait for tick + kernel run
      await new Promise((r) => setTimeout(r, 3000));

      // The session should have completed
      expect(completedSessions.length).toBe(1);

      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.run_count).toBe(1);
      expect(updated.last_session_id).toBeTruthy();

      // Verify the created session has full lifecycle events
      const sessionEvents = await journal.readSession(updated.last_session_id!);
      const sessionTypes = sessionEvents.map((e) => e.type);
      expect(sessionTypes).toContain("session.created");
      expect(sessionTypes).toContain("session.started");
      expect(sessionTypes).toContain("session.completed");

      // Journal integrity
      const integrity = await journal.verifyIntegrity();
      expect(integrity.valid).toBe(true);

      await scheduler.stop();
    });
  });

  // ─── API Server Integration ──────────────────────────────────────

  describe("scheduler REST API via server", () => {
    let httpServer: ReturnType<typeof import("node:http").createServer> | null = null;
    let scheduler: Scheduler;
    let port: number;

    beforeEach(async () => {
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
            policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
          });
          const session = await kernel.createSession(task);
          void kernel.run();
          return { session_id: session.session_id, status: session.status };
        },
        tickIntervalMs: 50,
      });
      await scheduler.start();

      // Load the scheduler-tool plugin to register the schedule tool
      const pluginsDir = resolve(import.meta.dirname ?? ".", "../../plugins");
      const pluginRegistry = new PluginRegistry({
        journal,
        toolRegistry: registry,
        toolRuntime: runtime,
        permissions,
        pluginsDir,
        pluginConfigs: { "scheduler-tool": { scheduler } },
      });
      await pluginRegistry.discoverAndLoadAll();

      const apiServer = new ApiServer({
        toolRegistry: registry,
        journal,
        toolRuntime: runtime,
        permissions,
        planner,
        pluginRegistry,
        scheduler,
        insecure: true,
      });

      port = 30000 + Math.floor(Math.random() * 10000);
      const app = apiServer.getExpressApp();
      httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const s = app.listen(port, () => resolve(s));
      });
    });

    afterEach(async () => {
      await scheduler.stop();
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer = null;
      }
    });

    it("health check includes scheduler status", async () => {
      const res = await fetch(`http://localhost:${port}/api/health`);
      expect(res.status).toBe(200);

      const body = await res.json() as { checks: { scheduler: { status: string; schedules: number } } };
      expect(body.checks.scheduler.status).toBe("ok");
      expect(body.checks.scheduler.schedules).toBe(0);
    });

    it("POST /schedules → GET /schedules round-trip", async () => {
      // Create
      const createRes = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "api-smoke-test",
          trigger: { type: "every", interval: "10m" },
          action: { type: "createSession", task_text: "api smoke" },
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as Schedule;
      expect(created.schedule_id).toBeTruthy();
      expect(created.name).toBe("api-smoke-test");
      expect(created.status).toBe("active");

      // List
      const listRes = await fetch(`http://localhost:${port}/api/schedules`);
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json() as { schedules: Schedule[]; total: number };
      expect(listBody.total).toBe(1);
      expect(listBody.schedules[0]!.schedule_id).toBe(created.schedule_id);

      // Get by ID
      const getRes = await fetch(`http://localhost:${port}/api/schedules/${created.schedule_id}`);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json() as Schedule;
      expect(fetched.name).toBe("api-smoke-test");
    });

    it("PUT /schedules/:id updates a schedule", async () => {
      const createRes = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "to-update",
          trigger: { type: "every", interval: "5m" },
          action: { type: "createSession", task_text: "update me" },
        }),
      });
      const created = await createRes.json() as Schedule;

      const updateRes = await fetch(`http://localhost:${port}/api/schedules/${created.schedule_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "updated-name" }),
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json() as Schedule;
      expect(updated.name).toBe("updated-name");
    });

    it("POST pause → POST resume lifecycle", async () => {
      const createRes = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "pause-resume",
          trigger: { type: "cron", expression: "0 * * * *" },
          action: { type: "createSession", task_text: "hourly" },
        }),
      });
      const created = await createRes.json() as Schedule;

      // Pause
      const pauseRes = await fetch(`http://localhost:${port}/api/schedules/${created.schedule_id}/pause`, {
        method: "POST",
      });
      expect(pauseRes.status).toBe(200);
      const paused = await pauseRes.json() as Schedule;
      expect(paused.status).toBe("paused");

      // Resume
      const resumeRes = await fetch(`http://localhost:${port}/api/schedules/${created.schedule_id}/resume`, {
        method: "POST",
      });
      expect(resumeRes.status).toBe(200);
      const resumed = await resumeRes.json() as Schedule;
      expect(resumed.status).toBe("active");
    });

    it("DELETE /schedules/:id removes a schedule", async () => {
      const createRes = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "to-delete",
          trigger: { type: "every", interval: "1h" },
          action: { type: "createSession", task_text: "bye" },
        }),
      });
      const created = await createRes.json() as Schedule;

      const delRes = await fetch(`http://localhost:${port}/api/schedules/${created.schedule_id}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);
      const delBody = await delRes.json() as { deleted: boolean };
      expect(delBody.deleted).toBe(true);

      // Confirm 404
      const getRes = await fetch(`http://localhost:${port}/api/schedules/${created.schedule_id}`);
      expect(getRes.status).toBe(404);
    });

    it("GET /schedules?status= filters by status", async () => {
      // Create two schedules
      await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "active-one",
          trigger: { type: "every", interval: "5m" },
          action: { type: "createSession", task_text: "a" },
        }),
      });
      const createRes2 = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "to-pause",
          trigger: { type: "every", interval: "5m" },
          action: { type: "createSession", task_text: "b" },
        }),
      });
      const sched2 = await createRes2.json() as Schedule;

      // Pause one
      await fetch(`http://localhost:${port}/api/schedules/${sched2.schedule_id}/pause`, {
        method: "POST",
      });

      // Filter active
      const activeRes = await fetch(`http://localhost:${port}/api/schedules?status=active`);
      const activeBody = await activeRes.json() as { schedules: Schedule[]; total: number };
      expect(activeBody.total).toBe(1);
      expect(activeBody.schedules[0]!.name).toBe("active-one");

      // Filter paused
      const pausedRes = await fetch(`http://localhost:${port}/api/schedules?status=paused`);
      const pausedBody = await pausedRes.json() as { schedules: Schedule[]; total: number };
      expect(pausedBody.total).toBe(1);
      expect(pausedBody.schedules[0]!.name).toBe("to-pause");
    });

    it("POST /schedules validates input", async () => {
      // Missing name
      const res1 = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: { type: "every", interval: "5m" }, action: { type: "createSession", task_text: "x" } }),
      });
      expect(res1.status).toBe(400);

      // Missing trigger
      const res2 = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", action: { type: "createSession", task_text: "x" } }),
      });
      expect(res2.status).toBe(400);

      // Invalid trigger type
      const res3 = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", trigger: { type: "invalid" }, action: { type: "createSession", task_text: "x" } }),
      });
      expect(res3.status).toBe(400);

      // Missing action
      const res4 = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", trigger: { type: "every", interval: "5m" } }),
      });
      expect(res4.status).toBe(400);
    });

    it("GET /schedules/:id returns 404 for nonexistent schedule", async () => {
      const res = await fetch(`http://localhost:${port}/api/schedules/nonexistent-id`);
      expect(res.status).toBe(404);
    });

    it("schedule tool is registered and visible in tools list", async () => {
      const res = await fetch(`http://localhost:${port}/api/tools`);
      const body = await res.json() as { tools: Array<{ name: string }> };
      const names = body.tools.map((t) => t.name);
      expect(names).toContain("schedule");
    });

    it("scheduled job triggers a kernel session via API", async () => {
      // Create schedule with past next_run_at so it fires on next tick
      const createRes = await fetch(`http://localhost:${port}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "auto-fire",
          trigger: { type: "at", at: new Date(Date.now() - 1000).toISOString() },
          action: { type: "createSession", task_text: "auto-fire test" },
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as Schedule;

      // Wait for tick to fire + kernel to run
      await new Promise((r) => setTimeout(r, 3000));

      // Verify schedule completed
      const getRes = await fetch(`http://localhost:${port}/api/schedules/${created.schedule_id}`);
      const updated = await getRes.json() as Schedule;
      expect(updated.status).toBe("completed");
      expect(updated.run_count).toBe(1);
      expect(updated.last_session_id).toBeTruthy();

      // Verify the kernel session was created and has journal events
      const journalRes = await fetch(`http://localhost:${port}/api/sessions/${updated.last_session_id}/journal`);
      if (journalRes.status === 200) {
        const journalBody = await journalRes.json() as { events: Array<{ type: string }> };
        const types = journalBody.events.map((e) => e.type);
        expect(types).toContain("session.created");
      }
      // Session may not be tracked by ApiServer since scheduler creates its own Kernel,
      // but journal events should exist
      const allEvents = await journal.readAll();
      const sessionEvents = allEvents.filter((e) => e.session_id === updated.last_session_id);
      expect(sessionEvents.length).toBeGreaterThan(0);
      expect(sessionEvents.map((e) => e.type)).toContain("session.created");
    });
  });
});
