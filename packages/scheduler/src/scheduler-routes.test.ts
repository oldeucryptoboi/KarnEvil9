import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "@jarvis/journal";
import { ScheduleStore } from "./schedule-store.js";
import { Scheduler } from "./scheduler.js";
import { createSchedulerRoutes } from "./scheduler-routes.js";
import type { SchedulerRoute } from "./scheduler-routes.js";

function makeRes() {
  const sent: { status?: number; data?: unknown } = {};
  return {
    capture: sent,
    json(data: unknown) { sent.data = data; sent.status = sent.status ?? 200; },
    text(data: string) { sent.data = data; sent.status = sent.status ?? 200; },
    status(code: number) {
      sent.status = code;
      return {
        json(data: unknown) { sent.data = data; },
        text(data: string) { sent.data = data; },
      };
    },
  };
}

describe("scheduler routes", () => {
  let dir: string;
  let scheduler: Scheduler;
  let routes: SchedulerRoute[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sched-routes-test-"));
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
    routes = createSchedulerRoutes(scheduler);
  });

  afterEach(async () => {
    await scheduler.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function findRoute(method: string, path: string): SchedulerRoute {
    const route = routes.find(r => r.method === method && r.path === path);
    if (!route) throw new Error(`Route not found: ${method} ${path}`);
    return route;
  }

  it("POST /schedules creates a schedule", async () => {
    const route = findRoute("POST", "/schedules");
    const res = makeRes();
    await route.handler(
      {
        method: "POST",
        path: "/schedules",
        params: {},
        query: {},
        body: {
          name: "test-route",
          trigger: { type: "every", interval: "5m" },
          action: { type: "createSession", task_text: "test" },
        },
      },
      res,
    );
    expect(res.capture.status).toBe(201);
    expect((res.capture.data as { schedule_id: string }).schedule_id).toBeTruthy();
  });

  it("POST /schedules rejects invalid input", async () => {
    const route = findRoute("POST", "/schedules");
    const res = makeRes();
    await route.handler(
      { method: "POST", path: "/schedules", params: {}, query: {}, body: { name: "" } },
      res,
    );
    expect(res.capture.status).toBe(400);
  });

  it("GET /schedules lists schedules", async () => {
    // Create one first
    await scheduler.createSchedule({
      name: "list-test",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    const route = findRoute("GET", "/schedules");
    const res = makeRes();
    await route.handler(
      { method: "GET", path: "/schedules", params: {}, query: {}, body: null },
      res,
    );
    expect(res.capture.status).toBe(200);
    expect((res.capture.data as { total: number }).total).toBe(1);
  });

  it("GET /schedules/:id returns 404 for missing schedule", async () => {
    const route = findRoute("GET", "/schedules/:id");
    const res = makeRes();
    await route.handler(
      { method: "GET", path: "/schedules/nope", params: { id: "nope" }, query: {}, body: null },
      res,
    );
    expect(res.capture.status).toBe(404);
  });

  it("DELETE /schedules/:id deletes a schedule", async () => {
    const sched = await scheduler.createSchedule({
      name: "del-test",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    const route = findRoute("DELETE", "/schedules/:id");
    const res = makeRes();
    await route.handler(
      { method: "DELETE", path: `/schedules/${sched.schedule_id}`, params: { id: sched.schedule_id }, query: {}, body: null },
      res,
    );
    expect(res.capture.status).toBe(200);
    expect((res.capture.data as { deleted: boolean }).deleted).toBe(true);
  });

  it("POST /schedules/:id/pause pauses a schedule", async () => {
    const sched = await scheduler.createSchedule({
      name: "pause-test",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    const route = findRoute("POST", "/schedules/:id/pause");
    const res = makeRes();
    await route.handler(
      { method: "POST", path: `/schedules/${sched.schedule_id}/pause`, params: { id: sched.schedule_id }, query: {}, body: null },
      res,
    );
    expect(res.capture.status).toBe(200);
    expect((res.capture.data as { status: string }).status).toBe("paused");
  });

  it("POST /schedules/:id/resume resumes a schedule", async () => {
    const sched = await scheduler.createSchedule({
      name: "resume-test",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    await scheduler.pauseSchedule(sched.schedule_id);
    const route = findRoute("POST", "/schedules/:id/resume");
    const res = makeRes();
    await route.handler(
      { method: "POST", path: `/schedules/${sched.schedule_id}/resume`, params: { id: sched.schedule_id }, query: {}, body: null },
      res,
    );
    expect(res.capture.status).toBe(200);
    expect((res.capture.data as { status: string }).status).toBe("active");
  });

  it("GET /schedules filters by status", async () => {
    await scheduler.createSchedule({
      name: "active-one",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    const sched2 = await scheduler.createSchedule({
      name: "paused-one",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    await scheduler.pauseSchedule(sched2.schedule_id);
    const route = findRoute("GET", "/schedules");
    const res = makeRes();
    await route.handler(
      { method: "GET", path: "/schedules", params: {}, query: { status: "paused" }, body: null },
      res,
    );
    expect((res.capture.data as { total: number }).total).toBe(1);
  });
});
