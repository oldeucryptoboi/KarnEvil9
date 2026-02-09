import type { ToolManifest, ToolHandler, ScheduleTrigger, JobAction, ScheduleOptions } from "@jarvis/schemas";
import type { Scheduler } from "./scheduler.js";

export const scheduleToolManifest: ToolManifest = {
  name: "schedule",
  version: "1.0.0",
  description: "Create, list, get, update, delete, pause, and resume scheduled tasks",
  runner: "internal",
  input_schema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: { type: "string", enum: ["create", "list", "get", "update", "delete", "pause", "resume"] },
      schedule_id: { type: "string", description: "Required for get, update, delete, pause, resume" },
      name: { type: "string", description: "Required for create" },
      trigger: {
        type: "object",
        description: "Required for create. Discriminated on 'type': at, every, cron",
      },
      action: {
        type: "object",
        description: "Required for create. Discriminated on 'type': createSession, emitEvent",
      },
      options: { type: "object", description: "Optional schedule options" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      schedule: { type: "object" },
      schedules: { type: "array" },
      deleted: { type: "boolean" },
    },
  },
  permissions: ["scheduler:manage:schedules"],
  timeout_ms: 10_000,
  supports: { mock: true, dry_run: true },
};

export function createScheduleToolHandler(scheduler: Scheduler): ToolHandler {
  return async (input, mode, _policy) => {
    const op = input.operation as string;

    if (mode === "mock") {
      return mockResponse(op, input);
    }

    if (mode === "dry_run") {
      return { dry_run: true, operation: op, would_execute: true };
    }

    switch (op) {
      case "create": {
        if (typeof input.name !== "string" || !input.name) {
          throw new Error("name is required for create operation");
        }
        if (!input.trigger || typeof input.trigger !== "object") {
          throw new Error("trigger is required for create operation");
        }
        if (!input.action || typeof input.action !== "object") {
          throw new Error("action is required for create operation");
        }
        const schedule = await scheduler.createSchedule({
          name: input.name as string,
          trigger: input.trigger as ScheduleTrigger,
          action: input.action as JobAction,
          options: (input.options as ScheduleOptions) ?? {},
          created_by: "agent",
        });
        return { schedule };
      }

      case "list": {
        const schedules = scheduler.listSchedules();
        return { schedules };
      }

      case "get": {
        const id = input.schedule_id as string;
        if (!id) throw new Error("schedule_id is required for get operation");
        const schedule = scheduler.getSchedule(id);
        if (!schedule) throw new Error(`Schedule not found: ${id}`);
        return { schedule };
      }

      case "update": {
        const id = input.schedule_id as string;
        if (!id) throw new Error("schedule_id is required for update operation");
        const updates: Record<string, unknown> = {};
        if (input.name !== undefined) updates.name = input.name;
        if (input.trigger !== undefined) updates.trigger = input.trigger;
        if (input.action !== undefined) updates.action = input.action;
        if (input.options !== undefined) updates.options = input.options;
        const schedule = await scheduler.updateSchedule(id, updates as Parameters<typeof scheduler.updateSchedule>[1]);
        return { schedule };
      }

      case "delete": {
        const id = input.schedule_id as string;
        if (!id) throw new Error("schedule_id is required for delete operation");
        await scheduler.deleteSchedule(id);
        return { deleted: true, schedule_id: id };
      }

      case "pause": {
        const id = input.schedule_id as string;
        if (!id) throw new Error("schedule_id is required for pause operation");
        const schedule = await scheduler.pauseSchedule(id);
        return { schedule };
      }

      case "resume": {
        const id = input.schedule_id as string;
        if (!id) throw new Error("schedule_id is required for resume operation");
        const schedule = await scheduler.resumeSchedule(id);
        return { schedule };
      }

      default:
        throw new Error(`Unknown operation: ${op}`);
    }
  };
}

function mockResponse(op: string, input: Record<string, unknown>): unknown {
  switch (op) {
    case "create":
      return {
        schedule: {
          schedule_id: "mock-schedule-id",
          name: input.name ?? "mock-schedule",
          status: "active",
          run_count: 0,
          next_run_at: new Date(Date.now() + 300_000).toISOString(),
        },
      };
    case "list":
      return { schedules: [] };
    case "get":
      return {
        schedule: {
          schedule_id: input.schedule_id ?? "mock-id",
          name: "mock-schedule",
          status: "active",
        },
      };
    case "update":
      return {
        schedule: {
          schedule_id: input.schedule_id ?? "mock-id",
          name: input.name ?? "mock-schedule",
          status: "active",
        },
      };
    case "delete":
      return { deleted: true, schedule_id: input.schedule_id ?? "mock-id" };
    case "pause":
      return {
        schedule: { schedule_id: input.schedule_id ?? "mock-id", status: "paused" },
      };
    case "resume":
      return {
        schedule: { schedule_id: input.schedule_id ?? "mock-id", status: "active" },
      };
    default:
      return { error: `Unknown operation: ${op}` };
  }
}
