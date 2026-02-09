import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScheduleStore } from "./schedule-store.js";
import type { Schedule } from "@jarvis/schemas";

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    schedule_id: "sched-1",
    name: "Test schedule",
    trigger: { type: "every", interval: "5m" },
    action: { type: "createSession", task_text: "do stuff" },
    options: {},
    status: "active",
    run_count: 0,
    failure_count: 0,
    next_run_at: new Date().toISOString(),
    last_run_at: null,
    created_by: "api",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ScheduleStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scheduler-store-"));
    filePath = join(dir, "schedules.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty when file does not exist", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    expect(store.size).toBe(0);
    expect(store.getAll()).toEqual([]);
  });

  it("set and get a schedule", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    const sched = makeSchedule();
    store.set(sched);
    expect(store.get("sched-1")).toEqual(sched);
    expect(store.has("sched-1")).toBe(true);
    expect(store.size).toBe(1);
  });

  it("deletes a schedule", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    store.set(makeSchedule());
    expect(store.delete("sched-1")).toBe(true);
    expect(store.has("sched-1")).toBe(false);
    expect(store.delete("sched-1")).toBe(false);
  });

  it("persists and loads schedules", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    store.set(makeSchedule({ schedule_id: "a" }));
    store.set(makeSchedule({ schedule_id: "b", status: "paused" }));
    await store.save();

    const store2 = new ScheduleStore(filePath);
    await store2.load();
    expect(store2.size).toBe(2);
    expect(store2.get("a")?.schedule_id).toBe("a");
    expect(store2.get("b")?.status).toBe("paused");
  });

  it("getActive returns only active schedules", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    store.set(makeSchedule({ schedule_id: "a", status: "active" }));
    store.set(makeSchedule({ schedule_id: "b", status: "paused" }));
    store.set(makeSchedule({ schedule_id: "c", status: "active" }));
    const active = store.getActive();
    expect(active.length).toBe(2);
    expect(active.map(s => s.schedule_id).sort()).toEqual(["a", "c"]);
  });

  it("atomic write produces valid JSONL", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    store.set(makeSchedule({ schedule_id: "x" }));
    await store.save();
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.schedule_id).toBe("x");
  });

  it("overwrites existing file on save", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    store.set(makeSchedule({ schedule_id: "a" }));
    store.set(makeSchedule({ schedule_id: "b" }));
    await store.save();

    store.delete("a");
    await store.save();

    const store2 = new ScheduleStore(filePath);
    await store2.load();
    expect(store2.size).toBe(1);
    expect(store2.has("b")).toBe(true);
  });

  it("getAll returns all schedules", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    store.set(makeSchedule({ schedule_id: "1" }));
    store.set(makeSchedule({ schedule_id: "2" }));
    store.set(makeSchedule({ schedule_id: "3" }));
    expect(store.getAll().length).toBe(3);
  });

  it("handles empty save correctly", async () => {
    const store = new ScheduleStore(filePath);
    await store.load();
    await store.save();
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("");
  });
});
