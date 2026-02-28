import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "@karnevil9/journal";
import { ScheduleStore } from "./schedule-store.js";
import { Scheduler } from "./scheduler.js";
import { scheduleToolManifest, createScheduleToolHandler } from "./schedule-tool.js";
import type { PolicyProfile } from "@karnevil9/schemas";

const mockPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

describe("schedule tool", () => {
  let dir: string;
  let scheduler: Scheduler;
  let handler: ReturnType<typeof createScheduleToolHandler>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schedule-tool-test-"));
    const journal = new Journal(join(dir, "journal.jsonl"), { fsync: false, lock: false });
    await journal.init();
    const store = new ScheduleStore(join(dir, "schedules.jsonl"));
    scheduler = new Scheduler({
      store,
      journal,
      sessionFactory: vi.fn().mockResolvedValue({ session_id: "s-1", status: "created" }),
      tickIntervalMs: 60_000,
    });
    await scheduler.start();
    handler = createScheduleToolHandler(scheduler);
  });

  afterEach(async () => {
    await scheduler.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("manifest has correct name and permissions", () => {
    expect(scheduleToolManifest.name).toBe("schedule");
    expect(scheduleToolManifest.permissions).toContain("scheduler:manage:schedules");
    expect(scheduleToolManifest.supports.mock).toBe(true);
  });

  it("creates a schedule in real mode", async () => {
    const result = await handler(
      {
        operation: "create",
        name: "my-schedule",
        trigger: { type: "every", interval: "10m" },
        action: { type: "createSession", task_text: "do stuff" },
      },
      "live",
      mockPolicy,
    ) as { schedule: { schedule_id: string; name: string; status: string } };
    expect(result.schedule.schedule_id).toBeTruthy();
    expect(result.schedule.name).toBe("my-schedule");
    expect(result.schedule.status).toBe("active");
  });

  it("lists schedules", async () => {
    await handler(
      {
        operation: "create",
        name: "s1",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "a" },
      },
      "live",
      mockPolicy,
    );
    const result = await handler({ operation: "list" }, "live", mockPolicy) as { schedules: unknown[] };
    expect(result.schedules.length).toBe(1);
  });

  it("returns mock response in mock mode", async () => {
    const result = await handler(
      { operation: "create", name: "mock-test" },
      "mock",
      mockPolicy,
    ) as { schedule: { schedule_id: string } };
    expect(result.schedule.schedule_id).toBe("mock-schedule-id");
  });

  it("returns dry_run response in dry_run mode", async () => {
    const result = await handler(
      { operation: "create", name: "dry" },
      "dry_run",
      mockPolicy,
    ) as { dry_run: boolean };
    expect(result.dry_run).toBe(true);
  });

  it("updates a schedule in real mode", async () => {
    const created = await handler(
      {
        operation: "create",
        name: "to-update",
        trigger: { type: "every", interval: "5m" },
        action: { type: "createSession", task_text: "original" },
      },
      "live",
      mockPolicy,
    ) as { schedule: { schedule_id: string; name: string } };

    const result = await handler(
      {
        operation: "update",
        schedule_id: created.schedule.schedule_id,
        name: "updated-name",
      },
      "live",
      mockPolicy,
    ) as { schedule: { schedule_id: string; name: string } };
    expect(result.schedule.name).toBe("updated-name");
    expect(result.schedule.schedule_id).toBe(created.schedule.schedule_id);
  });

  it("update throws without schedule_id", async () => {
    await expect(handler({ operation: "update", name: "x" }, "live", mockPolicy)).rejects.toThrow("schedule_id is required");
  });

  it("returns mock response for update in mock mode", async () => {
    const result = await handler(
      { operation: "update", schedule_id: "mock-id", name: "new-name" },
      "mock",
      mockPolicy,
    ) as { schedule: { schedule_id: string } };
    expect(result.schedule.schedule_id).toBe("mock-id");
  });

  it("throws on unknown operation", async () => {
    await expect(handler({ operation: "explode" }, "live", mockPolicy)).rejects.toThrow("Unknown operation");
  });

  it("rejects 'every' trigger with interval that overflows safe integer", async () => {
    await expect(handler(
      {
        operation: "create",
        name: "overflow-schedule",
        trigger: { type: "every", interval: "99999999999999d" },
        action: { type: "createSession", task_text: "boom" },
      },
      "live",
      mockPolicy,
    )).rejects.toThrow();
  });
});
