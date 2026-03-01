import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "@karnevil9/journal";
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

  it("POST /schedules masks internal error details", async () => {
    // Create a scheduler that throws an internal error (not a user-facing one)
    const route = findRoute("POST", "/schedules");
    const res = makeRes();
    // Provide a valid body but cause an internal error by making the scheduler's
    // createSchedule throw something unexpected
    const originalCreate = scheduler.createSchedule.bind(scheduler);
    scheduler.createSchedule = async () => { throw new Error("SQLITE_IOERR: disk I/O error at /var/db/data.sqlite"); };
    try {
      await route.handler(
        {
          method: "POST", path: "/schedules", params: {}, query: {},
          body: {
            name: "internal-err",
            trigger: { type: "every", interval: "5m" },
            action: { type: "createSession", task_text: "test" },
          },
        },
        res,
      );
      expect(res.capture.status).toBe(500);
      // Should NOT leak the SQLITE_IOERR or file path
      expect((res.capture.data as { error: string }).error).toBe("Internal server error");
      expect((res.capture.data as { error: string }).error).not.toContain("SQLITE");
      expect((res.capture.data as { error: string }).error).not.toContain("/var/db");
    } finally {
      scheduler.createSchedule = originalCreate;
    }
  });

  it("POST /schedules exposes validation errors (Invalid/format/required)", async () => {
    const route = findRoute("POST", "/schedules");
    const res = makeRes();
    const originalCreate = scheduler.createSchedule.bind(scheduler);
    scheduler.createSchedule = async () => { throw new Error("Invalid cron expression format"); };
    try {
      await route.handler(
        {
          method: "POST", path: "/schedules", params: {}, query: {},
          body: {
            name: "validation-err",
            trigger: { type: "cron", expression: "bad" },
            action: { type: "createSession", task_text: "test" },
          },
        },
        res,
      );
      expect(res.capture.status).toBe(400);
      expect((res.capture.data as { error: string }).error).toContain("Invalid cron expression format");
    } finally {
      scheduler.createSchedule = originalCreate;
    }
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

  // ─── Hardening Round 18 Tests ──────────────────────────────────────

  it("PUT /schedules/:id rejects oversized name", async () => {
    const sched = await scheduler.createSchedule({
      name: "update-name-test",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    const route = findRoute("PUT", "/schedules/:id");
    const res = makeRes();
    await route.handler(
      {
        method: "PUT",
        path: `/schedules/${sched.schedule_id}`,
        params: { id: sched.schedule_id },
        query: {},
        body: { name: "x".repeat(201) },
      },
      res,
    );
    expect(res.capture.status).toBe(400);
    expect((res.capture.data as { error: string }).error).toContain("name");
    expect((res.capture.data as { error: string }).error).toContain("200");
  });

  it("PUT /schedules/:id rejects oversized description in options", async () => {
    const sched = await scheduler.createSchedule({
      name: "update-desc-test",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    const route = findRoute("PUT", "/schedules/:id");
    const res = makeRes();
    await route.handler(
      {
        method: "PUT",
        path: `/schedules/${sched.schedule_id}`,
        params: { id: sched.schedule_id },
        query: {},
        body: { options: { description: "x".repeat(2001) } },
      },
      res,
    );
    expect(res.capture.status).toBe(400);
    expect((res.capture.data as { error: string }).error).toContain("description");
    expect((res.capture.data as { error: string }).error).toContain("2000");
  });

  it("PUT /schedules/:id masks internal error details", async () => {
    const sched = await scheduler.createSchedule({
      name: "mask-test",
      trigger: { type: "every", interval: "5m" },
      action: { type: "createSession", task_text: "t" },
    });
    const route = findRoute("PUT", "/schedules/:id");
    const res = makeRes();
    const originalUpdate = scheduler.updateSchedule.bind(scheduler);
    scheduler.updateSchedule = async () => { throw new Error("ENOENT: disk path /var/secret/data.db"); };
    try {
      await route.handler(
        {
          method: "PUT",
          path: `/schedules/${sched.schedule_id}`,
          params: { id: sched.schedule_id },
          query: {},
          body: { name: "new-name" },
        },
        res,
      );
      expect(res.capture.status).toBe(500);
      expect((res.capture.data as { error: string }).error).toBe("Internal server error");
      expect((res.capture.data as { error: string }).error).not.toContain("ENOENT");
    } finally {
      scheduler.updateSchedule = originalUpdate;
    }
  });

  it("DELETE /schedules/:id masks internal error details", async () => {
    const route = findRoute("DELETE", "/schedules/:id");
    const res = makeRes();
    const originalDelete = scheduler.deleteSchedule.bind(scheduler);
    scheduler.deleteSchedule = async () => { throw new Error("SQLITE_CORRUPT: database corruption at page 42"); };
    try {
      await route.handler(
        { method: "DELETE", path: "/schedules/some-id", params: { id: "some-id" }, query: {}, body: null },
        res,
      );
      expect(res.capture.status).toBe(500);
      expect((res.capture.data as { error: string }).error).toBe("Internal server error");
      expect((res.capture.data as { error: string }).error).not.toContain("SQLITE");
    } finally {
      scheduler.deleteSchedule = originalDelete;
    }
  });

  it("POST /schedules/:id/pause masks internal error details", async () => {
    const route = findRoute("POST", "/schedules/:id/pause");
    const res = makeRes();
    const originalPause = scheduler.pauseSchedule.bind(scheduler);
    scheduler.pauseSchedule = async () => { throw new Error("Connection refused at 10.0.0.1:5432"); };
    try {
      await route.handler(
        { method: "POST", path: "/schedules/some-id/pause", params: { id: "some-id" }, query: {}, body: null },
        res,
      );
      expect(res.capture.status).toBe(500);
      expect((res.capture.data as { error: string }).error).toBe("Internal server error");
      expect((res.capture.data as { error: string }).error).not.toContain("10.0.0.1");
    } finally {
      scheduler.pauseSchedule = originalPause;
    }
  });
});
