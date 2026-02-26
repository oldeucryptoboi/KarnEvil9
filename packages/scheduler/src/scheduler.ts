import { v4 as uuid } from "uuid";
import type { Journal } from "@karnevil9/journal";
import type {
  Schedule,
  ScheduleTrigger,
  ScheduleOptions,
  JobAction,
  Task,
  ExecutionMode,
} from "@karnevil9/schemas";
import { ScheduleStore } from "./schedule-store.js";
import { computeNextCron, computeNextInterval } from "./interval.js";

export type SessionFactory = (
  task: Task,
  options?: { mode?: ExecutionMode; agentic?: boolean }
) => Promise<{ session_id: string; status: string }>;

export interface SchedulerConfig {
  store: ScheduleStore;
  journal: Journal;
  sessionFactory: SessionFactory;
  sessionId?: string;
  tickIntervalMs?: number;
  maxConcurrentJobs?: number;
  missedGracePeriodMs?: number;
}

export class Scheduler {
  private store: ScheduleStore;
  private journal: Journal;
  private sessionFactory: SessionFactory;
  private sessionId: string;
  private tickIntervalMs: number;
  private maxConcurrentJobs: number;
  private missedGracePeriodMs: number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private activeJobs = 0;
  private activeJobPromises = new Set<Promise<void>>();
  private running = false;

  constructor(config: SchedulerConfig) {
    this.store = config.store;
    this.journal = config.journal;
    this.sessionFactory = config.sessionFactory;
    this.sessionId = config.sessionId ?? "scheduler";
    this.tickIntervalMs = config.tickIntervalMs ?? 1000;
    this.maxConcurrentJobs = config.maxConcurrentJobs ?? 5;
    this.missedGracePeriodMs = config.missedGracePeriodMs ?? 300_000;
  }

  async start(): Promise<void> {
    await this.store.load();
    await this.handleMissedSchedules();
    this.running = true;
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        void this.journal.emit(this.sessionId, "scheduler.tick_failed", {
          error: msg,
        }).catch(() => {
          process.stderr.write(`[scheduler] tick failed (journal unavailable): ${msg}\n`);
        });
      });
    }, this.tickIntervalMs);
    this.tickTimer.unref();
    await this.journal.emit(this.sessionId, "scheduler.started", {
      tick_interval_ms: this.tickIntervalMs,
      max_concurrent_jobs: this.maxConcurrentJobs,
      schedule_count: this.store.size,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    // Await in-flight jobs before persisting final state
    if (this.activeJobPromises.size > 0) {
      await Promise.allSettled([...this.activeJobPromises]);
    }
    await this.safeSave("stop");
    await this.journal.emit(this.sessionId, "scheduler.stopped", {});
  }

  isRunning(): boolean {
    return this.running;
  }

  async createSchedule(input: {
    name: string;
    trigger: ScheduleTrigger;
    action: JobAction;
    options?: ScheduleOptions;
    created_by?: string;
  }): Promise<Schedule> {
    const now = new Date().toISOString();
    const nextRunAt = this.computeNextRun(input.trigger, null);
    const schedule: Schedule = {
      schedule_id: uuid(),
      name: input.name,
      trigger: input.trigger,
      action: input.action,
      options: input.options ?? {},
      status: "active",
      run_count: 0,
      failure_count: 0,
      next_run_at: nextRunAt,
      last_run_at: null,
      created_by: input.created_by ?? "api",
      created_at: now,
      updated_at: now,
    };
    this.store.set(schedule);
    await this.safeSave("createSchedule");
    await this.journal.emit(this.sessionId, "scheduler.schedule_created", {
      schedule_id: schedule.schedule_id,
      name: schedule.name,
      trigger: schedule.trigger,
      next_run_at: schedule.next_run_at,
    });
    return schedule;
  }

  async updateSchedule(
    id: string,
    updates: Partial<Pick<Schedule, "name" | "trigger" | "action" | "options">>
  ): Promise<Schedule> {
    const schedule = this.store.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    if (updates.name !== undefined) schedule.name = updates.name;
    if (updates.trigger !== undefined) {
      schedule.trigger = updates.trigger;
      schedule.next_run_at = this.computeNextRun(updates.trigger, schedule.last_run_at);
    }
    if (updates.action !== undefined) schedule.action = updates.action;
    if (updates.options !== undefined) schedule.options = { ...schedule.options, ...updates.options };
    schedule.updated_at = new Date().toISOString();
    this.store.set(schedule);
    await this.safeSave("updateSchedule");
    await this.journal.emit(this.sessionId, "scheduler.schedule_updated", {
      schedule_id: id,
      updates: Object.keys(updates),
    });
    return schedule;
  }

  async deleteSchedule(id: string): Promise<void> {
    if (!this.store.has(id)) throw new Error(`Schedule not found: ${id}`);
    this.store.delete(id);
    await this.safeSave("deleteSchedule");
    await this.journal.emit(this.sessionId, "scheduler.schedule_deleted", { schedule_id: id });
  }

  async pauseSchedule(id: string): Promise<Schedule> {
    const schedule = this.store.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    schedule.status = "paused";
    schedule.updated_at = new Date().toISOString();
    this.store.set(schedule);
    await this.safeSave("pauseSchedule");
    await this.journal.emit(this.sessionId, "scheduler.schedule_paused", { schedule_id: id });
    return schedule;
  }

  async resumeSchedule(id: string): Promise<Schedule> {
    const schedule = this.store.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    schedule.status = "active";
    schedule.next_run_at = this.computeNextRun(schedule.trigger, schedule.last_run_at);
    schedule.updated_at = new Date().toISOString();
    this.store.set(schedule);
    await this.safeSave("resumeSchedule");
    await this.journal.emit(this.sessionId, "scheduler.schedule_updated", {
      schedule_id: id,
      resumed: true,
    });
    return schedule;
  }

  getSchedule(id: string): Schedule | undefined {
    return this.store.get(id);
  }

  listSchedules(): Schedule[] {
    return this.store.getAll();
  }

  getStore(): ScheduleStore {
    return this.store;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    const active = this.store.getActive();
    for (const schedule of active) {
      if (!schedule.next_run_at) continue;
      const nextRunMs = new Date(schedule.next_run_at).getTime();
      if (now >= nextRunMs && this.activeJobs < this.maxConcurrentJobs) {
        this.activeJobs++;
        const jobPromise = this.executeJob(schedule).catch(() => {
          // Job-level errors are already handled inside executeJob;
          // this catch prevents unhandled rejection if executeJob itself throws.
        }).finally(() => {
          this.activeJobs--;
          this.activeJobPromises.delete(jobPromise);
        });
        this.activeJobPromises.add(jobPromise);
      }
    }
  }

  private async executeJob(schedule: Schedule): Promise<void> {
    await this.journal.emit(this.sessionId, "scheduler.job_triggered", {
      schedule_id: schedule.schedule_id,
      name: schedule.name,
      action_type: schedule.action.type,
      created_by: schedule.created_by,
      task_text: schedule.action.type === "createSession" ? schedule.action.task_text : undefined,
    });

    try {
      let sessionId: string | undefined;
      if (schedule.action.type === "createSession") {
        const task: Task = {
          task_id: uuid(),
          text: schedule.action.task_text,
          constraints: schedule.action.constraints,
          submitted_by: `scheduler:${schedule.schedule_id}`,
          created_at: new Date().toISOString(),
        };
        const result = await this.sessionFactory(task, {
          mode: schedule.action.mode,
          agentic: schedule.action.agentic,
        });
        sessionId = result.session_id;
      } else if (schedule.action.type === "emitEvent") {
        const targetSession = schedule.action.session_id ?? this.sessionId;
        await this.journal.emit(targetSession, schedule.action.event_type, schedule.action.payload);
      }

      // Success
      schedule.run_count++;
      schedule.failure_count = 0;
      schedule.last_run_at = new Date().toISOString();
      if (sessionId) schedule.last_session_id = sessionId;
      schedule.last_error = undefined;

      // Handle one-shot "at" triggers or delete_after_run
      if (schedule.trigger.type === "at" || schedule.options.delete_after_run) {
        schedule.status = "completed";
        schedule.next_run_at = null;
      } else {
        schedule.next_run_at = this.computeNextRun(schedule.trigger, schedule.last_run_at);
      }

      schedule.updated_at = new Date().toISOString();
      this.store.set(schedule);
      await this.safeSave("job_completed");

      await this.journal.emit(this.sessionId, "scheduler.job_completed", {
        schedule_id: schedule.schedule_id,
        run_count: schedule.run_count,
        session_id: sessionId,
      });
    } catch (err) {
      schedule.failure_count++;
      schedule.last_run_at = new Date().toISOString();
      schedule.last_error = err instanceof Error ? err.message : String(err);

      const maxFailures = schedule.options.max_failures ?? 3;
      if (schedule.failure_count >= maxFailures) {
        schedule.status = "failed";
        schedule.next_run_at = null;
      } else {
        schedule.next_run_at = this.computeNextRun(schedule.trigger, schedule.last_run_at);
      }

      schedule.updated_at = new Date().toISOString();
      this.store.set(schedule);
      await this.safeSave("job_failed");

      await this.journal.emit(this.sessionId, "scheduler.job_failed", {
        schedule_id: schedule.schedule_id,
        failure_count: schedule.failure_count,
        error: schedule.last_error,
        paused: schedule.status === "failed",
      });
    }
  }

  private async handleMissedSchedules(): Promise<void> {
    const now = Date.now();
    const graceLimit = now - this.missedGracePeriodMs;
    const active = this.store.getActive();

    for (const schedule of active) {
      if (!schedule.next_run_at) continue;
      const nextRunMs = new Date(schedule.next_run_at).getTime();
      if (nextRunMs >= now) continue; // not missed

      const policy = schedule.options.missed_policy ?? "skip";

      if (policy === "skip") {
        schedule.next_run_at = this.computeNextRun(schedule.trigger, new Date().toISOString());
        schedule.updated_at = new Date().toISOString();
        this.store.set(schedule);
        await this.journal.emit(this.sessionId, "scheduler.job_skipped", {
          schedule_id: schedule.schedule_id,
          missed_at: new Date(nextRunMs).toISOString(),
          policy: "skip",
        });
      } else if (policy === "catchup_one") {
        if (nextRunMs >= graceLimit) {
          await this.executeJob(schedule);
        } else {
          schedule.next_run_at = this.computeNextRun(schedule.trigger, new Date().toISOString());
          schedule.updated_at = new Date().toISOString();
          this.store.set(schedule);
          await this.journal.emit(this.sessionId, "scheduler.job_skipped", {
            schedule_id: schedule.schedule_id,
            missed_at: new Date(nextRunMs).toISOString(),
            policy: "catchup_one",
            reason: "outside_grace_period",
          });
        }
      } else if (policy === "catchup_all") {
        // Execute for each missed occurrence within grace period
        const MAX_CATCHUP_ITERATIONS = 1000;
        let cursor = nextRunMs;
        let iterations = 0;
        while (cursor < now && cursor >= graceLimit && iterations < MAX_CATCHUP_ITERATIONS) {
          await this.executeJob(schedule);
          const nextStr = this.computeNextRun(schedule.trigger, new Date(cursor).toISOString());
          if (!nextStr) break;
          const nextMs = new Date(nextStr).getTime();
          if (nextMs <= cursor) break; // prevent infinite loop
          cursor = nextMs;
          iterations++;
        }
        // Advance to future
        if (schedule.status === "active") {
          schedule.next_run_at = this.computeNextRun(schedule.trigger, new Date().toISOString());
          schedule.updated_at = new Date().toISOString();
          this.store.set(schedule);
        }
      }
    }

    await this.safeSave("handleMissedSchedules");
  }

  /** Persist store state, emitting a journal warning on failure. */
  private async safeSave(context: string): Promise<void> {
    try {
      await this.store.save();
    } catch (err) {
      await this.journal.emit(this.sessionId, "scheduler.save_failed", {
        context,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
    }
  }

  private computeNextRun(trigger: ScheduleTrigger, lastRunAt: string | null): string | null {
    switch (trigger.type) {
      case "at":
        return trigger.at;
      case "every":
        return computeNextInterval(
          trigger.interval,
          lastRunAt ?? undefined,
          trigger.start_at
        );
      case "cron":
        return computeNextCron(
          trigger.expression,
          trigger.timezone,
          lastRunAt ? new Date(lastRunAt) : undefined
        );
    }
  }
}
