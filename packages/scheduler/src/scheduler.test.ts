import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "@karnevil9/journal";
import { ScheduleStore } from "./schedule-store.js";
import { Scheduler } from "./scheduler.js";
import type { SessionFactory } from "./scheduler.js";
import type { Schedule, } from "@karnevil9/schemas";

function makeSessionFactory(result?: { session_id: string; status: string }): SessionFactory {
  return vi.fn().mockResolvedValue(result ?? { session_id: "sess-123", status: "created" });
}

function failingSessionFactory(error: string): SessionFactory {
  return vi.fn().mockRejectedValue(new Error(error));
}

describe("Scheduler", () => {
  let dir: string;
  let journal: Journal;
  let store: ScheduleStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scheduler-test-"));
    journal = new Journal(join(dir, "journal.jsonl"), { fsync: false, lock: false });
    await journal.init();
    store = new ScheduleStore(join(dir, "schedules.jsonl"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function createScheduler(overrides: Partial<{
    sessionFactory: SessionFactory;
    tickIntervalMs: number;
    maxConcurrentJobs: number;
    missedGracePeriodMs: number;
  }> = {}) {
    return new Scheduler({
      store,
      journal,
      sessionFactory: overrides.sessionFactory ?? makeSessionFactory(),
      tickIntervalMs: overrides.tickIntervalMs ?? 60_000, // high so ticks don't auto-fire
      maxConcurrentJobs: overrides.maxConcurrentJobs ?? 5,
      missedGracePeriodMs: overrides.missedGracePeriodMs ?? 300_000,
    });
  }

  describe("lifecycle", () => {
    it("starts and stops", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      await scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it("emits started and stopped events", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      await scheduler.stop();
      const events = await journal.readSession("scheduler");
      const types = events.map(e => e.type);
      expect(types).toContain("scheduler.started");
      expect(types).toContain("scheduler.stopped");
    });
  });

  describe("createSchedule", () => {
    it("creates an interval schedule", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "test-every",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "do work" },
      });
      expect(sched.schedule_id).toBeTruthy();
      expect(sched.status).toBe("active");
      expect(sched.run_count).toBe(0);
      expect(sched.next_run_at).toBeTruthy();
      await scheduler.stop();
    });

    it("creates an at schedule", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const future = new Date(Date.now() + 60_000).toISOString();
      const sched = await scheduler.createSchedule({
        name: "test-at",
        trigger: { type: "at", at: future },
        action: { type: "createSession", task_text: "once" },
      });
      expect(sched.next_run_at).toBe(future);
      await scheduler.stop();
    });

    it("creates a cron schedule", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "test-cron",
        trigger: { type: "cron", expression: "*/5 * * * *" },
        action: { type: "createSession", task_text: "cron job" },
      });
      expect(sched.next_run_at).toBeTruthy();
      await scheduler.stop();
    });

    it("emits schedule_created event", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "evt-test",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "test" },
      });
      await scheduler.stop();
      const events = await journal.readSession("scheduler");
      const created = events.find(e => e.type === "scheduler.schedule_created");
      expect(created).toBeTruthy();
      expect(created!.payload.schedule_id).toBe(sched.schedule_id);
    });

    it("persists schedule to store", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      await scheduler.createSchedule({
        name: "persist-test",
        trigger: { type: "every", interval: "10m" },
        action: { type: "createSession", task_text: "persist" },
      });
      await scheduler.stop();

      const store2 = new ScheduleStore(join(dir, "schedules.jsonl"));
      await store2.load();
      expect(store2.size).toBe(1);
    });
  });

  describe("updateSchedule", () => {
    it("updates a schedule name", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "original",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "test" },
      });
      const updated = await scheduler.updateSchedule(sched.schedule_id, { name: "renamed" });
      expect(updated.name).toBe("renamed");
      await scheduler.stop();
    });

    it("throws on non-existent schedule", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      await expect(scheduler.updateSchedule("nonexistent", { name: "x" })).rejects.toThrow("Schedule not found");
      await scheduler.stop();
    });
  });

  describe("deleteSchedule", () => {
    it("deletes a schedule", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "to-delete",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "test" },
      });
      await scheduler.deleteSchedule(sched.schedule_id);
      expect(scheduler.getSchedule(sched.schedule_id)).toBeUndefined();
      await scheduler.stop();
    });

    it("throws on non-existent schedule", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      await expect(scheduler.deleteSchedule("nope")).rejects.toThrow("Schedule not found");
      await scheduler.stop();
    });

    it("emits schedule_deleted event", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "del-evt",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "test" },
      });
      await scheduler.deleteSchedule(sched.schedule_id);
      await scheduler.stop();
      const events = await journal.readSession("scheduler");
      expect(events.some(e => e.type === "scheduler.schedule_deleted")).toBe(true);
    });
  });

  describe("pauseSchedule / resumeSchedule", () => {
    it("pauses an active schedule", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "pause-me",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "test" },
      });
      const paused = await scheduler.pauseSchedule(sched.schedule_id);
      expect(paused.status).toBe("paused");
      await scheduler.stop();
    });

    it("resumes a paused schedule", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "resume-me",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "test" },
      });
      await scheduler.pauseSchedule(sched.schedule_id);
      const resumed = await scheduler.resumeSchedule(sched.schedule_id);
      expect(resumed.status).toBe("active");
      expect(resumed.next_run_at).toBeTruthy();
      await scheduler.stop();
    });
  });

  describe("listSchedules / getSchedule", () => {
    it("lists all schedules", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      await scheduler.createSchedule({
        name: "s1",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "a" },
      });
      await scheduler.createSchedule({
        name: "s2",
        trigger: { type: "every", interval: "10m" },
        action: { type: "createSession", task_text: "b" },
      });
      expect(scheduler.listSchedules().length).toBe(2);
      await scheduler.stop();
    });

    it("gets a schedule by id", async () => {
      const scheduler = createScheduler();
      await scheduler.start();
      const sched = await scheduler.createSchedule({
        name: "get-me",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "test" },
      });
      const found = scheduler.getSchedule(sched.schedule_id);
      expect(found?.name).toBe("get-me");
      await scheduler.stop();
    });
  });

  describe("job execution", () => {
    it("executes a createSession job when next_run_at is in the past", async () => {
      const factory = makeSessionFactory();
      const scheduler = createScheduler({ sessionFactory: factory, tickIntervalMs: 50 });
      await scheduler.start();

      // Create schedule with next_run_at already in the past
      const sched = await scheduler.createSchedule({
        name: "run-now",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "execute me" },
      });

      // Manually set next_run_at to past
      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      // Wait for tick
      await new Promise(resolve => setTimeout(resolve, 200));
      await scheduler.stop();

      expect(factory).toHaveBeenCalled();
      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.run_count).toBe(1);
      expect(updated.failure_count).toBe(0);
    });

    it("executes an emitEvent job", async () => {
      const scheduler = createScheduler({ tickIntervalMs: 50 });
      await scheduler.start();

      const sched = await scheduler.createSchedule({
        name: "emit-test",
        trigger: { type: "every", interval: "1h" },
        action: { type: "emitEvent", event_type: "session.checkpoint", payload: { msg: "hello" } },
      });

      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      await new Promise(resolve => setTimeout(resolve, 200));
      await scheduler.stop();

      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.run_count).toBe(1);
    });

    it("marks at-trigger schedules as completed after run", async () => {
      const scheduler = createScheduler({ tickIntervalMs: 50 });
      await scheduler.start();

      const sched = await scheduler.createSchedule({
        name: "one-shot",
        trigger: { type: "at", at: new Date(Date.now() - 1000).toISOString() },
        action: { type: "createSession", task_text: "once" },
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      await scheduler.stop();

      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.status).toBe("completed");
      expect(updated.next_run_at).toBeNull();
    });

    it("handles job failure and increments failure_count", async () => {
      const factory = failingSessionFactory("boom");
      const scheduler = createScheduler({ sessionFactory: factory, tickIntervalMs: 50 });
      await scheduler.start();

      const sched = await scheduler.createSchedule({
        name: "fail-test",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "will fail" },
      });

      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      await new Promise(resolve => setTimeout(resolve, 200));
      await scheduler.stop();

      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.failure_count).toBe(1);
      expect(updated.last_error).toBe("boom");
      expect(updated.status).toBe("active"); // not yet at max_failures
    });

    it("marks schedule as failed after max_failures", async () => {
      const factory = failingSessionFactory("boom");
      const scheduler = createScheduler({ sessionFactory: factory, tickIntervalMs: 50 });
      await scheduler.start();

      const sched = await scheduler.createSchedule({
        name: "fail-max",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "will fail" },
        options: { max_failures: 1 },
      });

      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      await new Promise(resolve => setTimeout(resolve, 200));
      await scheduler.stop();

      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.status).toBe("failed");
      expect(updated.next_run_at).toBeNull();
    });

    it("respects maxConcurrentJobs", async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;
      const factory: SessionFactory = vi.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise(resolve => setTimeout(resolve, 100));
        concurrentCount--;
        return { session_id: "s", status: "created" };
      });

      const scheduler = createScheduler({ sessionFactory: factory, tickIntervalMs: 30, maxConcurrentJobs: 2 });
      await scheduler.start();

      // Create 4 schedules all due now
      for (let i = 0; i < 4; i++) {
        const sched = await scheduler.createSchedule({
          name: `concurrent-${i}`,
          trigger: { type: "every", interval: "1h" },
          action: { type: "createSession", task_text: `job ${i}` },
        });
        const s = scheduler.getSchedule(sched.schedule_id)!;
        s.next_run_at = new Date(Date.now() - 1000).toISOString();
        store.set(s);
      }

      await new Promise(resolve => setTimeout(resolve, 500));
      await scheduler.stop();

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("handles delete_after_run option", async () => {
      const scheduler = createScheduler({ tickIntervalMs: 50 });
      await scheduler.start();

      const sched = await scheduler.createSchedule({
        name: "delete-after",
        trigger: { type: "every", interval: "1h" },
        action: { type: "createSession", task_text: "test" },
        options: { delete_after_run: true },
      });

      const s = scheduler.getSchedule(sched.schedule_id)!;
      s.next_run_at = new Date(Date.now() - 1000).toISOString();
      store.set(s);

      await new Promise(resolve => setTimeout(resolve, 200));
      await scheduler.stop();

      const updated = scheduler.getSchedule(sched.schedule_id)!;
      expect(updated.status).toBe("completed");
    });
  });

  describe("missed schedule handling", () => {
    it("skip policy advances next_run_at", async () => {
      // Pre-seed store with a missed schedule
      const pastSchedule: Schedule = {
        schedule_id: "missed-skip",
        name: "missed-skip",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "test" },
        options: { missed_policy: "skip" },
        status: "active",
        run_count: 0,
        failure_count: 0,
        next_run_at: new Date(Date.now() - 60_000).toISOString(),
        last_run_at: null,
        created_by: "test",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      store.set(pastSchedule);
      await store.save();

      const factory = makeSessionFactory();
      const scheduler = createScheduler({ sessionFactory: factory });
      await scheduler.start();

      const updated = scheduler.getSchedule("missed-skip")!;
      expect(new Date(updated.next_run_at!).getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
      expect(factory).not.toHaveBeenCalled(); // skip = no execution
      await scheduler.stop();
    });

    it("catchup_one policy executes once within grace period", async () => {
      const pastSchedule: Schedule = {
        schedule_id: "missed-catchup1",
        name: "missed-catchup1",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "test" },
        options: { missed_policy: "catchup_one" },
        status: "active",
        run_count: 0,
        failure_count: 0,
        next_run_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago, within grace
        last_run_at: null,
        created_by: "test",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      store.set(pastSchedule);
      await store.save();

      const factory = makeSessionFactory();
      const scheduler = createScheduler({ sessionFactory: factory });
      await scheduler.start();
      await scheduler.stop();

      expect(factory).toHaveBeenCalledOnce();
      const updated = scheduler.getSchedule("missed-catchup1")!;
      expect(updated.run_count).toBe(1);
    });
  });
});
