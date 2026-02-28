import type { RouteHandler, ScheduleTrigger, JobAction, ScheduleOptions } from "@karnevil9/schemas";
import type { Scheduler } from "./scheduler.js";

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const VALID_TRIGGER_TYPES = new Set(["at", "every", "cron"]);
const VALID_ACTION_TYPES = new Set(["createSession", "emitEvent"]);
const VALID_STATUSES = new Set(["active", "paused", "completed", "failed"]);

function validateCreateInput(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object";
  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || b.name.trim().length === 0) return "name is required and must be a non-empty string";
  if (b.name.length > MAX_NAME_LENGTH) return `name must be at most ${MAX_NAME_LENGTH} characters`;

  if (!b.trigger || typeof b.trigger !== "object" || Array.isArray(b.trigger)) return "trigger is required and must be an object";
  const trigger = b.trigger as Record<string, unknown>;
  if (typeof trigger.type !== "string" || !VALID_TRIGGER_TYPES.has(trigger.type)) {
    return `trigger.type must be one of: ${[...VALID_TRIGGER_TYPES].join(", ")}`;
  }
  if (trigger.type === "at" && typeof trigger.at !== "string") return "trigger.at is required for at triggers";
  if (trigger.type === "every" && typeof trigger.interval !== "string") return "trigger.interval is required for every triggers";
  if (trigger.type === "cron" && typeof trigger.expression !== "string") return "trigger.expression is required for cron triggers";

  if (!b.action || typeof b.action !== "object" || Array.isArray(b.action)) return "action is required and must be an object";
  const action = b.action as Record<string, unknown>;
  if (typeof action.type !== "string" || !VALID_ACTION_TYPES.has(action.type)) {
    return `action.type must be one of: ${[...VALID_ACTION_TYPES].join(", ")}`;
  }
  if (action.type === "createSession" && typeof action.task_text !== "string") return "action.task_text is required for createSession actions";
  if (action.type === "emitEvent" && typeof action.event_type !== "string") return "action.event_type is required for emitEvent actions";

  if (b.options !== undefined && (typeof b.options !== "object" || Array.isArray(b.options))) return "options must be an object";
  if (b.options) {
    const opts = b.options as Record<string, unknown>;
    if (opts.description !== undefined && typeof opts.description === "string" && opts.description.length > MAX_DESCRIPTION_LENGTH) {
      return `options.description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
    }
  }

  return null;
}

function validateUpdateInput(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object";
  const b = body as Record<string, unknown>;

  if (b.name !== undefined && (typeof b.name !== "string" || b.name.trim().length === 0)) {
    return "name must be a non-empty string";
  }
  if (b.trigger !== undefined) {
    if (typeof b.trigger !== "object" || Array.isArray(b.trigger)) return "trigger must be an object";
    const trigger = b.trigger as Record<string, unknown>;
    if (typeof trigger.type !== "string" || !VALID_TRIGGER_TYPES.has(trigger.type)) {
      return `trigger.type must be one of: ${[...VALID_TRIGGER_TYPES].join(", ")}`;
    }
  }
  if (b.action !== undefined) {
    if (typeof b.action !== "object" || Array.isArray(b.action)) return "action must be an object";
    const action = b.action as Record<string, unknown>;
    if (typeof action.type !== "string" || !VALID_ACTION_TYPES.has(action.type)) {
      return `action.type must be one of: ${[...VALID_ACTION_TYPES].join(", ")}`;
    }
  }
  if (b.options !== undefined && (typeof b.options !== "object" || Array.isArray(b.options))) {
    return "options must be an object";
  }

  return null;
}

export interface SchedulerRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

export function createSchedulerRoutes(scheduler: Scheduler): SchedulerRoute[] {
  const listSchedules: RouteHandler = async (req, res) => {
    const schedules = scheduler.listSchedules();
    const statusFilter = req.query.status;
    const tagFilter = req.query.tag;

    let filtered = schedules;
    if (statusFilter && VALID_STATUSES.has(statusFilter)) {
      filtered = filtered.filter(s => s.status === statusFilter);
    }
    if (tagFilter) {
      filtered = filtered.filter(s => s.options.tags?.includes(tagFilter));
    }

    res.json({ schedules: filtered, total: filtered.length });
  };

  const getSchedule: RouteHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) { res.status(400).json({ error: "Schedule ID is required" }); return; }
    const schedule = scheduler.getSchedule(id);
    if (!schedule) { res.status(404).json({ error: "Schedule not found" }); return; }
    res.json(schedule);
  };

  const createSchedule: RouteHandler = async (req, res) => {
    const error = validateCreateInput(req.body);
    if (error) { res.status(400).json({ error }); return; }
    try {
      const body = req.body as {
        name: string;
        trigger: ScheduleTrigger;
        action: JobAction;
        options?: ScheduleOptions;
      };
      const schedule = await scheduler.createSchedule({
        name: body.name,
        trigger: body.trigger,
        action: body.action,
        options: body.options,
        created_by: "api",
      });
      res.status(201).json(schedule);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      // Only expose known user-facing errors; mask internal details
      if (msg.includes("Invalid") || msg.includes("format") || msg.includes("required")) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  };

  const updateSchedule: RouteHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) { res.status(400).json({ error: "Schedule ID is required" }); return; }
    const error = validateUpdateInput(req.body);
    if (error) { res.status(400).json({ error }); return; }
    try {
      const body = req.body as Record<string, unknown>;
      const updates: Partial<{
        name: string;
        trigger: ScheduleTrigger;
        action: JobAction;
        options: ScheduleOptions;
      }> = {};
      if (body.name !== undefined) updates.name = body.name as string;
      if (body.trigger !== undefined) updates.trigger = body.trigger as ScheduleTrigger;
      if (body.action !== undefined) updates.action = body.action as JobAction;
      if (body.options !== undefined) updates.options = body.options as ScheduleOptions;
      const schedule = await scheduler.updateSchedule(id, updates);
      res.json(schedule);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      res.status(500).json({ error: msg });
    }
  };

  const deleteSchedule: RouteHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) { res.status(400).json({ error: "Schedule ID is required" }); return; }
    try {
      await scheduler.deleteSchedule(id);
      res.json({ deleted: true, schedule_id: id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      res.status(500).json({ error: msg });
    }
  };

  const pauseSchedule: RouteHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) { res.status(400).json({ error: "Schedule ID is required" }); return; }
    try {
      const schedule = await scheduler.pauseSchedule(id);
      res.json(schedule);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      res.status(500).json({ error: msg });
    }
  };

  const triggerSchedule: RouteHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) { res.status(400).json({ error: "Schedule ID is required" }); return; }
    try {
      const result = await scheduler.triggerSchedule(id);
      res.json({ triggered: true, schedule_id: id, session_id: result.session_id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      res.status(500).json({ error: msg });
    }
  };

  const resumeSchedule: RouteHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) { res.status(400).json({ error: "Schedule ID is required" }); return; }
    try {
      const schedule = await scheduler.resumeSchedule(id);
      res.json(schedule);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      res.status(500).json({ error: msg });
    }
  };

  return [
    { method: "GET", path: "/schedules", handler: listSchedules },
    { method: "GET", path: "/schedules/:id", handler: getSchedule },
    { method: "POST", path: "/schedules", handler: createSchedule },
    { method: "PUT", path: "/schedules/:id", handler: updateSchedule },
    { method: "DELETE", path: "/schedules/:id", handler: deleteSchedule },
    { method: "POST", path: "/schedules/:id/pause", handler: pauseSchedule },
    { method: "POST", path: "/schedules/:id/resume", handler: resumeSchedule },
    { method: "POST", path: "/schedules/:id/trigger", handler: triggerSchedule },
  ];
}
