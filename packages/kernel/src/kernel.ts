import { v4 as uuid } from "uuid";
import type {
  Session,
  SessionStatus,
  Task,
  Plan,
  Step,
  StepResult,
  StepStatus,
  ExecutionMode,
  SessionLimits,
  PolicyProfile,
  ToolExecutionRequest,
  Planner,
} from "@openflaw/schemas";
import { validatePlanData } from "@openflaw/schemas";
import type { Journal } from "@openflaw/journal";
import type { ToolRuntime } from "@openflaw/tools";
import type { ToolRegistry } from "@openflaw/tools";
import type { PermissionEngine } from "@openflaw/permissions";
import { TaskStateManager, WorkingMemoryManager } from "@openflaw/memory";

export interface KernelConfig {
  journal: Journal;
  toolRuntime: ToolRuntime;
  toolRegistry: ToolRegistry;
  permissions: PermissionEngine;
  planner: Planner;
  mode: ExecutionMode;
  limits: SessionLimits;
  policy: PolicyProfile;
}

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  created: ["planning"],
  planning: ["running", "failed"],
  running: ["awaiting_approval", "paused", "completed", "failed", "aborted"],
  awaiting_approval: ["running", "aborted"],
  paused: ["running", "aborted"],
  completed: [],
  failed: [],
  aborted: [],
};

export class Kernel {
  private config: KernelConfig;
  private session: Session | null = null;
  private taskState: TaskStateManager | null = null;
  private workingMemory: WorkingMemoryManager | null = null;
  private abortRequested = false;

  constructor(config: KernelConfig) { this.config = config; }

  async createSession(task: Task): Promise<Session> {
    const session: Session = {
      session_id: uuid(),
      status: "created",
      mode: this.config.mode,
      task,
      active_plan_id: null,
      limits: this.config.limits,
      policy: this.config.policy,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.session = session;
    this.taskState = new TaskStateManager(session.session_id);
    this.workingMemory = new WorkingMemoryManager(session.session_id);
    await this.config.journal.emit(session.session_id, "session.created", {
      task_id: task.task_id, task_text: task.text, mode: session.mode,
    });
    return session;
  }

  async run(): Promise<Session> {
    if (!this.session || !this.taskState) throw new Error("No session created. Call createSession first.");
    try {
      await this.transition("planning");
      await this.config.journal.emit(this.session.session_id, "session.started", {});
      const plan = await this.planPhase();
      if (!plan) { await this.transition("failed"); return this.session; }
      await this.transition("running");
      await this.executePhase(plan);
      if (this.session.status === "running") {
        await this.transition("completed");
        await this.config.journal.emit(this.session.session_id, "session.completed", {
          step_results: this.taskState.getSnapshot().step_results,
        });
      }
    } catch (err) {
      if (!["failed", "aborted"].includes(this.session.status)) {
        await this.transition("failed");
        await this.config.journal.emit(this.session.session_id, "session.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.config.permissions.clearSession();
    return this.session;
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    if (this.session && !["completed", "failed", "aborted"].includes(this.session.status)) {
      await this.transition("aborted");
      await this.config.journal.emit(this.session.session_id, "session.aborted", { reason: "User requested abort" });
    }
  }

  getSession(): Session | null { return this.session; }
  getTaskState(): TaskStateManager | null { return this.taskState; }

  private async planPhase(): Promise<Plan | null> {
    if (!this.session || !this.taskState) return null;
    await this.config.journal.emit(this.session.session_id, "planner.requested", { task_text: this.session.task.text });
    try {
      const plan = await this.config.planner.generatePlan(
        this.session.task,
        this.config.toolRegistry.getSchemasForPlanner(),
        this.taskState.getSnapshot(),
        { policy: this.session.policy, limits: this.session.limits }
      );
      const validation = validatePlanData(plan);
      if (!validation.valid) {
        await this.config.journal.emit(this.session.session_id, "planner.plan_rejected", { errors: validation.errors });
        return null;
      }
      for (const step of plan.steps) {
        if (!this.config.toolRegistry.get(step.tool_ref.name)) {
          await this.config.journal.emit(this.session.session_id, "planner.plan_rejected", {
            errors: [`Unknown tool referenced: "${step.tool_ref.name}"`],
          });
          return null;
        }
      }
      if (plan.steps.length > this.session.limits.max_steps) {
        await this.config.journal.emit(this.session.session_id, "planner.plan_rejected", {
          errors: [`Plan has ${plan.steps.length} steps, exceeds limit of ${this.session.limits.max_steps}`],
        });
        return null;
      }
      await this.config.journal.emit(this.session.session_id, "planner.plan_received", {
        plan_id: plan.plan_id, goal: plan.goal, step_count: plan.steps.length,
      });
      await this.config.journal.emit(this.session.session_id, "plan.accepted", { plan_id: plan.plan_id });
      this.taskState.setPlan(plan);
      this.session.active_plan_id = plan.plan_id;
      return plan;
    } catch (err) {
      await this.config.journal.emit(this.session.session_id, "planner.plan_rejected", {
        errors: [err instanceof Error ? err.message : String(err)],
      });
      return null;
    }
  }

  private async executePhase(plan: Plan): Promise<void> {
    if (!this.session || !this.taskState) return;
    for (const step of plan.steps) {
      if (this.abortRequested || this.session.status !== "running") break;
      await this.executeStep(step);
      const result = this.taskState.getStepResult(step.step_id);
      if (result && result.status === "failed") {
        if (step.failure_policy === "abort" || step.failure_policy === "replan") {
          await this.transition("failed");
          await this.config.journal.emit(this.session.session_id, "session.failed", {
            reason: `Step "${step.title}" failed with ${step.failure_policy} policy`,
            step_id: step.step_id,
          });
          return;
        }
      }
      this.config.permissions.clearStep();
    }
  }

  private async executeStep(step: Step): Promise<void> {
    if (!this.session || !this.taskState) return;
    const startedAt = new Date().toISOString();
    await this.config.journal.emit(this.session.session_id, "step.started", {
      step_id: step.step_id, title: step.title, tool: step.tool_ref.name,
    });
    let attempts = 0;
    let lastResult: StepResult | null = null;
    while (attempts <= step.max_retries) {
      attempts++;
      const request: ToolExecutionRequest = {
        request_id: uuid(),
        tool_name: step.tool_ref.name,
        tool_version: step.tool_ref.version_range ?? "*",
        input: step.input,
        mode: this.session.mode,
        session_id: this.session.session_id,
        step_id: step.step_id,
      };
      await this.config.journal.emit(this.session.session_id, "tool.requested", {
        request_id: request.request_id, tool_name: request.tool_name,
        step_id: step.step_id, attempt: attempts,
      });
      const toolResult = await this.config.toolRuntime.execute(request);
      const stepStatus: StepStatus = toolResult.ok ? "succeeded" : "failed";
      lastResult = {
        step_id: step.step_id, status: stepStatus,
        output: toolResult.ok ? toolResult.result : undefined,
        error: toolResult.error,
        started_at: startedAt, finished_at: new Date().toISOString(),
        attempts,
      };
      if (toolResult.ok || attempts > step.max_retries) break;
    }
    if (lastResult) {
      this.taskState.setStepResult(step.step_id, lastResult);
      await this.config.journal.emit(this.session.session_id,
        lastResult.status === "succeeded" ? "step.succeeded" : "step.failed",
        { step_id: step.step_id, status: lastResult.status, attempts: lastResult.attempts,
          output: lastResult.output, error: lastResult.error }
      );
    }
  }

  private async transition(newStatus: SessionStatus): Promise<void> {
    if (!this.session) throw new Error("No active session");
    const allowed = VALID_TRANSITIONS[this.session.status];
    if (!allowed?.includes(newStatus)) {
      throw new Error(`Invalid session transition: ${this.session.status} → ${newStatus}`);
    }
    this.session.status = newStatus;
    this.session.updated_at = new Date().toISOString();
  }
}
