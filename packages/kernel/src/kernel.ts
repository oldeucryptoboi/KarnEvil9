import { v4 as uuid } from "uuid";
import type {
  Session,
  SessionStatus,
  Task,
  Plan,
  PlanResult,
  Step,
  StepResult,
  StepStatus,
  ExecutionMode,
  SessionLimits,
  PolicyProfile,
  ToolExecutionRequest,
  Planner,
  ModelPricing,
  UsageMetrics,
  HookName,
  HookResult,
} from "@jarvis/schemas";
import { validatePlanData } from "@jarvis/schemas";
import type { Journal } from "@jarvis/journal";
import type { ToolRuntime } from "@jarvis/tools";
import type { ToolRegistry } from "@jarvis/tools";
import type { PermissionEngine } from "@jarvis/permissions";
import { TaskStateManager, extractLesson } from "@jarvis/memory";
import type { ActiveMemory } from "@jarvis/memory";
import type { PluginRegistry } from "@jarvis/plugins";
import { mkdir, rename, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCritics } from "./critics.js";
import { FutilityMonitor } from "./futility.js";
import type { FutilityConfig } from "./futility.js";
import { UsageAccumulator } from "./usage-accumulator.js";
import { ContextBudgetMonitor, buildCheckpoint } from "./context-budget.js";
import type { ContextBudgetConfig } from "./context-budget.js";
import { runSubagent } from "./subagent.js";
import type { CheckpointFinding } from "@jarvis/schemas";

export interface KernelConfig {
  journal: Journal;
  toolRegistry: ToolRegistry;
  planner?: Planner;
  toolRuntime?: ToolRuntime;
  permissions?: PermissionEngine;
  pluginRegistry?: PluginRegistry;
  mode: ExecutionMode;
  limits: SessionLimits;
  policy: PolicyProfile;
  plannerRetries?: number;
  plannerTimeoutMs?: number;
  agentic?: boolean;
  disableCritics?: boolean;
  activeMemory?: ActiveMemory;
  futilityConfig?: FutilityConfig;
  modelPricing?: ModelPricing;
  contextBudgetConfig?: ContextBudgetConfig;
  checkpointDir?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number, baseMs = 500, maxMs = 15000): number {
  const delay = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
  const jitter = Math.random() * 500;
  return delay + jitter;
}

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  created: ["planning"],
  planning: ["running", "failed", "aborted"],
  running: ["awaiting_approval", "paused", "completed", "failed", "aborted", "planning"],
  awaiting_approval: ["running", "aborted"],
  paused: ["running", "aborted"],
  completed: [],
  failed: [],
  aborted: [],
};

const MAX_CONCURRENT_STEPS = 5;

export class Kernel {
  private config: KernelConfig;
  private session: Session | null = null;
  private taskState: TaskStateManager | null = null;
  private futilityMonitor: FutilityMonitor | null = null;
  private usageAccumulator: UsageAccumulator | null = null;
  private contextBudgetMonitor: ContextBudgetMonitor | null = null;
  private lastIterationTokens = 0;
  private lastToolsUsed: string[] = [];
  private lastPlanGoal = "";
  private subagentFindings: CheckpointFinding[] | null = null;
  private abortRequested = false;
  private running = false;
  private sessionStartTime = 0;

  constructor(config: KernelConfig) { this.config = config; }

  private async runHook(hookName: HookName, context: Record<string, unknown>): Promise<HookResult> {
    if (!this.config.pluginRegistry) return { action: "continue" };
    return this.config.pluginRegistry.getHookRunner().run(hookName, {
      session_id: this.session?.session_id ?? "",
      plugin_id: "kernel",
      ...context,
    });
  }

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
    this.usageAccumulator = new UsageAccumulator(this.config.modelPricing);
    if (this.config.agentic && this.config.futilityConfig) {
      this.futilityMonitor = new FutilityMonitor(this.config.futilityConfig);
    }
    if (this.config.agentic && this.config.contextBudgetConfig) {
      this.contextBudgetMonitor = new ContextBudgetMonitor(this.config.contextBudgetConfig);
    }

    const hookResult = await this.runHook("before_session_start", { task });
    if (hookResult.action === "block") {
      throw new Error(`Session blocked by plugin: ${(hookResult as { reason: string }).reason}`);
    }
    if (hookResult.action === "modify" && hookResult.data) {
      Object.assign(session, hookResult.data);
    }

    await this.config.journal.emit(session.session_id, "session.created", {
      task_id: task.task_id, task_text: task.text, mode: session.mode,
    });
    return session;
  }

  async run(): Promise<Session> {
    if (!this.session || !this.taskState) throw new Error("No session created. Call createSession first.");
    if (this.running) throw new Error("Kernel is already running. Concurrent run() calls are not allowed.");
    this.running = true;
    this.sessionStartTime = Date.now();
    try {
      await this.transition("planning");
      await this.config.journal.emit(this.session.session_id, "session.started", {});

      if (this.config.agentic) {
        await this.agenticPhase();
      } else {
        const planResult = await this.planPhase();
        if (!planResult) { await this.transition("failed"); return this.session; }
        await this.transition("running");
        await this.executePhase(planResult.plan);
      }

      if (this.session.status === "running") {
        await this.transition("completed");
        await this.config.journal.emit(this.session.session_id, "session.completed", {
          step_results: this.taskState.getSnapshot().step_results,
          usage: this.usageAccumulator?.getSummary(),
        });
      }
    } catch (err) {
      if (!["failed", "aborted"].includes(this.session.status)) {
        await this.transition("failed");
        await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.running = false;
      await this.runHook("after_session_end", { status: this.session.status });

      // Extract lesson for active memory
      if (this.config.activeMemory && this.taskState?.getPlan()) {
        const plan = this.taskState.getPlan()!;
        const stepResults = this.taskState.getAllStepResults();
        const lesson = extractLesson(
          this.session.task.text, plan, stepResults, this.session.status, this.session.session_id
        );
        if (lesson) {
          this.config.activeMemory.addLesson(lesson);
          await this.config.activeMemory.save();
          await this.config.journal.tryEmit(this.session.session_id, "memory.lesson_extracted", {
            lesson_id: lesson.lesson_id, outcome: lesson.outcome, lesson: lesson.lesson,
          });
        }
      }
    }
    this.config.permissions?.clearSession(this.session.session_id);
    return this.session;
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    if (this.session && !["completed", "failed", "aborted"].includes(this.session.status)) {
      await this.transition("aborted");
      await this.config.journal.tryEmit(this.session.session_id, "session.aborted", { reason: "User requested abort" });
    }
  }

  getSession(): Session | null { return this.session; }
  getTaskState(): TaskStateManager | null { return this.taskState; }
  getUsageSummary() { return this.usageAccumulator?.getSummary() ?? null; }

  private async planPhase(opts?: { allowEmptySteps?: boolean; iteration?: number }): Promise<PlanResult | null> {
    if (!this.session || !this.taskState) return null;
    if (!this.config.planner) {
      await this.config.journal.emit(this.session.session_id, "planner.plan_rejected", {
        errors: ["No planner configured — cannot generate plan"],
      });
      return null;
    }
    await this.config.journal.emit(this.session.session_id, "planner.requested", {
      task_text: this.session.task.text,
      ...(opts?.iteration != null ? { iteration: opts.iteration } : {}),
    });

    const beforePlanResult = await this.runHook("before_plan", { task: this.session.task });
    if (beforePlanResult.action === "block") {
      await this.config.journal.emit(this.session.session_id, "planner.plan_rejected", {
        errors: [`Blocked by plugin: ${(beforePlanResult as { reason: string }).reason}`],
      });
      return null;
    }

    const maxAttempts = (this.config.plannerRetries ?? 0) + 1;
    const timeoutMs = this.config.plannerTimeoutMs ?? 30000;
    let lastError: string | null = null;

    // Enrich snapshot with memory recalls and subagent findings
    const enrichedSnapshot = { ...this.taskState.getSnapshot() };
    if (this.config.activeMemory) {
      const recalled = this.config.activeMemory.search(this.session.task.text);
      if (recalled.length > 0) {
        enrichedSnapshot.relevant_memories = recalled.map(m => ({
          task: m.task_summary, outcome: m.outcome, lesson: m.lesson,
        }));
      }
    }
    if (this.subagentFindings && this.subagentFindings.length > 0) {
      enrichedSnapshot.subagent_findings = this.subagentFindings;
      this.subagentFindings = null; // Consume once
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await sleep(backoff(attempt - 1));
      }
      try {
        const planResultPromise = this.config.planner.generatePlan(
          this.session.task,
          this.config.toolRegistry.getSchemasForPlanner(),
          enrichedSnapshot,
          { policy: this.session.policy, limits: this.session.limits }
        );
        let plannerTimer: ReturnType<typeof setTimeout> | undefined;
        let planResult: PlanResult;
        try {
          planResult = timeoutMs > 0
            ? await Promise.race([
                planResultPromise,
                new Promise<never>((_, reject) => {
                  plannerTimer = setTimeout(() => reject(new Error(`Planner timed out after ${timeoutMs}ms`)), Math.max(1, timeoutMs));
                }),
              ])
            : await planResultPromise;
        } finally {
          if (plannerTimer) clearTimeout(plannerTimer);
        }

        const { plan, usage } = planResult;

        // Record usage from planner call
        if (usage && this.usageAccumulator) {
          this.usageAccumulator.record(usage);
          await this.config.journal.tryEmit(this.session.session_id, "usage.recorded", {
            ...usage,
            cumulative: this.usageAccumulator.getSummary(),
          });
        }

        // In agentic mode, empty steps = "done" signal — skip schema validation
        if (plan.steps.length === 0 && opts?.allowEmptySteps) {
          await this.config.journal.emit(this.session.session_id, "planner.plan_received", {
            plan_id: plan.plan_id, step_count: 0,
          });
          await this.config.journal.emit(this.session.session_id, "plan.accepted", { plan_id: plan.plan_id, plan });
          return planResult;
        }

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

        // Run critics if enabled
        if (!this.config.disableCritics) {
          const criticResults = runCritics(plan, {
            session: this.session,
            toolSchemas: this.config.toolRegistry.getSchemasForPlanner(),
          });
          const errors = criticResults.filter(r => !r.passed && r.severity === "error");
          if (errors.length > 0) {
            await this.config.journal.emit(this.session.session_id, "plan.criticized", {
              plan_id: plan.plan_id, critics: criticResults,
            });
            await this.config.journal.emit(this.session.session_id, "planner.plan_rejected", {
              errors: errors.map(e => `[${e.name}] ${e.message}`),
            });
            return null;
          }
        }

        const afterPlanResult = await this.runHook("after_plan", { plan });
        if (afterPlanResult.action === "block") {
          await this.config.journal.emit(this.session.session_id, "planner.plan_rejected", {
            errors: [`Plan rejected by plugin: ${(afterPlanResult as { reason: string }).reason}`],
          });
          return null;
        }

        await this.config.journal.emit(this.session.session_id, "plan.accepted", { plan_id: plan.plan_id, plan });
        this.taskState.setPlan(plan);
        this.session.active_plan_id = plan.plan_id;
        return planResult;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          await this.config.journal.tryEmit(this.session.session_id, "planner.plan_rejected", {
            errors: [lastError], attempt, retrying: true,
          });
        }
      }
    }

    // All attempts exhausted
    await this.config.journal.tryEmit(this.session.session_id, "planner.plan_rejected", {
      errors: [lastError ?? "Planner failed after all retries"],
    });
    return null;
  }

  private detectCycles(plan: Plan): string[] | null {
    const adj = new Map<string, string[]>();
    for (const step of plan.steps) {
      adj.set(step.step_id, step.depends_on ?? []);
    }
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const cycle: string[] = [];

    function dfs(node: string): boolean {
      if (inStack.has(node)) { cycle.push(node); return true; }
      if (visited.has(node)) return false;
      visited.add(node);
      inStack.add(node);
      for (const dep of adj.get(node) ?? []) {
        if (dfs(dep)) { cycle.push(node); return true; }
      }
      inStack.delete(node);
      return false;
    }

    for (const step of plan.steps) {
      if (!visited.has(step.step_id)) {
        if (dfs(step.step_id)) return cycle.reverse();
      }
    }
    return null;
  }

  private async executePhase(plan: Plan): Promise<void> {
    if (!this.session || !this.taskState) return;

    // Detect cyclic dependencies before execution
    const cycle = this.detectCycles(plan);
    if (cycle) {
      await this.transition("failed");
      await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
        reason: `Cyclic dependency detected in plan: ${cycle.join(" → ")}`,
      });
      return;
    }

    const steps = new Map<string, Step>();
    const results = new Map<string, StepResult>();
    for (const step of plan.steps) steps.set(step.step_id, step);

    const completed = new Set<string>();
    const failed = new Set<string>();

    while (completed.size + failed.size < plan.steps.length) {
      if (this.abortRequested || this.session.status !== "running") break;

      // Duration limit check
      const elapsed = Date.now() - this.sessionStartTime;
      if (elapsed >= this.session.limits.max_duration_ms) {
        await this.config.journal.tryEmit(this.session.session_id, "limit.exceeded", {
          limit: "max_duration_ms",
          value: this.session.limits.max_duration_ms,
          actual: elapsed,
        });
        await this.transition("failed");
        await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
          reason: `Duration limit exceeded: ${elapsed}ms > ${this.session.limits.max_duration_ms}ms`,
        });
        return;
      }

      const ready: Step[] = [];
      for (const step of plan.steps) {
        if (completed.has(step.step_id) || failed.has(step.step_id)) continue;
        const deps = step.depends_on ?? [];
        const allDepsCompleted = deps.every((d) => completed.has(d));
        const anyDepFailed = deps.some((d) => failed.has(d));
        if (anyDepFailed) {
          const skipResult: StepResult = {
            step_id: step.step_id,
            status: "skipped",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            attempts: 0,
          };
          this.taskState.setStepResult(step.step_id, skipResult);
          failed.add(step.step_id);
          continue;
        }
        if (allDepsCompleted) ready.push(step);
      }

      if (ready.length === 0) break;

      const batchFns = ready.map((step) => async () => {
        const resolvedStep = this.resolveInputBindings(step, results);
        await this.executeStep(resolvedStep);
        const result = this.taskState!.getStepResult(step.step_id);
        if (result) {
          results.set(step.step_id, result);
          if (result.status === "succeeded") {
            completed.add(step.step_id);
          } else {
            if (step.failure_policy === "continue" ||
                (step.failure_policy === "replan" && this.config.agentic)) {
              completed.add(step.step_id);
            } else {
              failed.add(step.step_id);
            }
          }
        }
      });

      await this.runConcurrent(batchFns, Math.min(MAX_CONCURRENT_STEPS, ready.length));

      // Emit checkpoint after batch completes
      await this.config.journal.emit(this.session.session_id, "session.checkpoint", {
        completed_step_ids: [...completed],
        failed_step_ids: [...failed],
        step_results: Object.fromEntries(results),
      });

      if (failed.size > 0) {
        const failedStep = plan.steps.find(
          (s) => failed.has(s.step_id) && s.failure_policy !== "continue" &&
                 !(s.failure_policy === "replan" && this.config.agentic)
        );
        if (failedStep) {
          // Mark remaining dependent steps as skipped
          for (const step of plan.steps) {
            if (completed.has(step.step_id) || failed.has(step.step_id)) continue;
            const deps = step.depends_on ?? [];
            if (deps.some((d) => failed.has(d))) {
              const skipResult: StepResult = {
                step_id: step.step_id,
                status: "skipped",
                started_at: new Date().toISOString(),
                finished_at: new Date().toISOString(),
                attempts: 0,
              };
              this.taskState.setStepResult(step.step_id, skipResult);
            }
          }
          await this.transition("failed");
          await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
            reason: `Step "${failedStep.title}" failed with ${failedStep.failure_policy} policy`,
            step_id: failedStep.step_id,
          });
          return;
        }
      }

      for (const step of ready) {
        if (completed.has(step.step_id) || failed.has(step.step_id)) {
          this.config.permissions?.clearStep(this.session!.session_id);
        }
      }
    }
  }

  private async agenticPhase(): Promise<void> {
    if (!this.session || !this.taskState) return;

    const maxIter = this.session.limits.max_iterations ?? 10;
    let totalStepsExecuted = 0;
    let previousPlanId: string | null = null;
    let done = false;

    for (let iteration = 0; iteration < maxIter; iteration++) {
      if (this.abortRequested || !["planning", "running"].includes(this.session.status)) break;

      // Duration limit check
      const elapsed = Date.now() - this.sessionStartTime;
      if (elapsed >= this.session.limits.max_duration_ms) {
        await this.config.journal.tryEmit(this.session.session_id, "limit.exceeded", {
          limit: "max_duration_ms", value: this.session.limits.max_duration_ms, actual: elapsed,
        });
        await this.transition("failed");
        await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
          reason: `Duration limit exceeded: ${elapsed}ms >= ${this.session.limits.max_duration_ms}ms`,
        });
        return;
      }

      // Transition to planning if currently running (after first iteration)
      if (this.session.status !== "planning") {
        await this.transition("planning");
      }

      // Context budget check (before planning to save the planner call)
      if (this.contextBudgetMonitor && this.usageAccumulator && iteration > 0) {
        const prevTokens = this.lastIterationTokens;
        const cumTokens = this.usageAccumulator.totalTokens;
        const budgetVerdict = this.contextBudgetMonitor.recordIteration({
          iteration: iteration + 1,
          tokensUsedThisIteration: prevTokens,
          cumulativeTokens: cumTokens,
          maxTokens: this.session.limits.max_tokens,
          toolsUsed: this.lastToolsUsed,
          planGoal: this.lastPlanGoal,
          stepCount: totalStepsExecuted,
        });

        await this.config.journal.tryEmit(this.session.session_id, "context.budget_assessed", {
          iteration: iteration + 1,
          fraction: this.session.limits.max_tokens > 0 ? cumTokens / this.session.limits.max_tokens : 0,
          verdict: budgetVerdict.action,
          cumulative_tokens: cumTokens,
          max_tokens: this.session.limits.max_tokens,
        });

        if (budgetVerdict.action === "delegate") {
          await this.config.journal.tryEmit(this.session.session_id, "context.delegation_started", {
            reason: budgetVerdict.reason, task: budgetVerdict.taskDescription,
          });
          try {
            const remainingTokens = Math.max(0, this.session.limits.max_tokens - cumTokens);
            const subResult = await runSubagent(
              {
                journal: this.config.journal,
                toolRegistry: this.config.toolRegistry,
                toolRuntime: this.config.toolRuntime,
                permissions: this.config.permissions,
                planner: this.config.planner,
                mode: this.config.mode,
                policy: this.session.policy,
                modelPricing: this.config.modelPricing,
              },
              {
                task_text: budgetVerdict.taskDescription,
                max_tokens: Math.floor(remainingTokens * 0.3),
                max_cost_usd: Math.max(0, this.session.limits.max_cost_usd - this.usageAccumulator.totalCostUsd) * 0.3,
                max_iterations: 5,
                max_duration_ms: Math.min(60000, this.session.limits.max_duration_ms - (Date.now() - this.sessionStartTime)),
              },
            );
            this.subagentFindings = subResult.findings;
            await this.config.journal.tryEmit(this.session.session_id, "context.delegation_completed", {
              subagent_session_id: subResult.subagent_session_id,
              status: subResult.status,
              findings_count: subResult.findings.length,
              tokens_used: subResult.tokens_used,
            });
          } catch (err) {
            await this.config.journal.tryEmit(this.session.session_id, "context.delegation_completed", {
              status: "failed", error: err instanceof Error ? err.message : String(err),
            });
          }
          // Continue to planning — findings will be injected via snapshot
        }

        if (budgetVerdict.action === "checkpoint") {
          await this.config.journal.tryEmit(this.session.session_id, "context.checkpoint_triggered", {
            reason: budgetVerdict.reason,
          });
          await this.emitCheckpoint(iteration + 1);
          // Transition to running so run() can complete normally (graceful end)
          if (this.session.status === "planning") {
            await this.transition("running");
          }
          done = true;
          break;
        }

        if (budgetVerdict.action === "summarize") {
          await this.config.journal.tryEmit(this.session.session_id, "context.summarize_triggered", {
            reason: budgetVerdict.reason,
          });
          await this.emitCheckpoint(iteration + 1);
          if (this.session.status === "planning") {
            await this.transition("running");
          }
          done = true;
          break;
        }
      }

      // Plan next steps (allow empty steps as "done" signal)
      const planResult = await this.planPhase({ allowEmptySteps: true, iteration: iteration + 1 });
      if (!planResult) {
        if (!["failed", "aborted"].includes(this.session.status)) {
          await this.transition("failed");
          await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
            reason: `Planner failed at iteration ${iteration + 1}`,
          });
        }
        return;
      }

      const { plan, usage: iterationUsage } = planResult;

      // Token limit check
      if (this.usageAccumulator && this.session.limits.max_tokens > 0) {
        if (this.usageAccumulator.totalTokens > this.session.limits.max_tokens) {
          await this.config.journal.tryEmit(this.session.session_id, "limit.exceeded", {
            limit: "max_tokens", value: this.session.limits.max_tokens,
            actual: this.usageAccumulator.totalTokens,
          });
          await this.transition("failed");
          await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
            reason: `Token limit exceeded: ${this.usageAccumulator.totalTokens} > ${this.session.limits.max_tokens}`,
          });
          return;
        }
      }

      // Cost limit check
      if (this.usageAccumulator && this.session.limits.max_cost_usd > 0) {
        if (this.usageAccumulator.totalCostUsd > this.session.limits.max_cost_usd) {
          await this.config.journal.tryEmit(this.session.session_id, "limit.exceeded", {
            limit: "max_cost_usd", value: this.session.limits.max_cost_usd,
            actual: this.usageAccumulator.totalCostUsd,
          });
          await this.transition("failed");
          await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
            reason: `Cost limit exceeded: $${this.usageAccumulator.totalCostUsd.toFixed(4)} > $${this.session.limits.max_cost_usd}`,
          });
          return;
        }
      }

      // Empty steps = planner says task is complete
      if (plan.steps.length === 0) {
        done = true;
        // Transition to running so run() can complete normally
        if (this.session.status === "planning") {
          await this.transition("running");
        }
        break;
      }

      // Emit plan.replaced for iterations after the first
      if (previousPlanId) {
        await this.config.journal.emit(this.session.session_id, "plan.replaced", {
          previous_plan_id: previousPlanId, new_plan_id: plan.plan_id, iteration: iteration + 1,
        });
      }
      previousPlanId = plan.plan_id;

      // Check cumulative step limit
      if (totalStepsExecuted + plan.steps.length > this.session.limits.max_steps) {
        await this.config.journal.tryEmit(this.session.session_id, "limit.exceeded", {
          limit: "max_steps", value: this.session.limits.max_steps,
          actual: totalStepsExecuted + plan.steps.length,
        });
        await this.transition("failed");
        await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
          reason: `Cumulative step limit exceeded: ${totalStepsExecuted + plan.steps.length} > ${this.session.limits.max_steps}`,
        });
        return;
      }

      // Execute this iteration's steps
      await this.transition("running");
      await this.executePhase(plan);
      totalStepsExecuted += plan.steps.length;

      // If execution caused failure/abort, stop
      if (this.session.status !== "running") return;

      // Futility detection
      if (this.futilityMonitor) {
        const verdict = this.futilityMonitor.recordIteration({
          iteration: iteration + 1,
          planGoal: plan.goal,
          stepResults: plan.steps.map(s => this.taskState!.getStepResult(s.step_id)).filter((r): r is StepResult => r != null),
          iterationUsage,
          cumulativeUsage: this.usageAccumulator?.getSummary(),
          maxCostUsd: this.session.limits.max_cost_usd,
        });
        if (verdict.action === "halt") {
          await this.config.journal.tryEmit(this.session.session_id, "futility.detected", {
            reason: verdict.reason, iteration: iteration + 1,
          });
          await this.transition("failed");
          await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
            reason: `Futility detected: ${verdict.reason}`,
          });
          return;
        }
      }

      // Track iteration metrics for context budget monitor
      this.lastIterationTokens = iterationUsage?.total_tokens ?? 0;
      this.lastToolsUsed = plan.steps.map(s => s.tool_ref.name);
      this.lastPlanGoal = plan.goal;
    }

    // If we exhausted iterations without a "done" signal, fail
    if (!done && !["failed", "completed", "aborted"].includes(this.session.status)) {
      await this.config.journal.tryEmit(this.session.session_id, "limit.exceeded", {
        limit: "max_iterations", value: maxIter,
      });
      await this.transition("failed");
      await this.config.journal.tryEmit(this.session.session_id, "session.failed", {
        reason: `Max iterations exceeded: ${maxIter}`,
      });
    }
  }

  private async runConcurrent<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = [];
    let index = 0;

    async function worker(): Promise<void> {
      while (index < tasks.length) {
        const currentIndex = index++;
        const result = await tasks[currentIndex]!();
        results.push(result);
      }
    }

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  private resolveInputBindings(step: Step, results: Map<string, StepResult>): Step {
    if (!step.input_from) return step;
    const resolvedInput = { ...step.input };
    for (const [inputField, binding] of Object.entries(step.input_from)) {
      const dotIndex = binding.indexOf(".");
      if (dotIndex === -1) {
        console.warn(`[kernel] Malformed input binding "${inputField}": "${binding}" (missing "." separator)`);
        continue;
      }
      const sourceStepId = binding.substring(0, dotIndex);
      const outputField = binding.substring(dotIndex + 1);
      const sourceResult = results.get(sourceStepId);
      if (sourceResult?.output && typeof sourceResult.output === "object") {
        const value = (sourceResult.output as Record<string, unknown>)[outputField];
        if (value !== undefined) resolvedInput[inputField] = value;
      }
    }
    return { ...step, input: resolvedInput };
  }

  private async executeStep(step: Step): Promise<void> {
    if (!this.session || !this.taskState) return;
    if (!this.config.toolRuntime) {
      const result: StepResult = {
        step_id: step.step_id,
        status: "failed",
        error: { code: "NO_RUNTIME", message: "No tool runtime configured" },
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        attempts: 0,
      };
      this.taskState.setStepResult(step.step_id, result);
      await this.config.journal.tryEmit(this.session.session_id, "step.failed", {
        step_id: step.step_id, status: "failed", attempts: 0, error: result.error,
      });
      return;
    }
    const startedAt = new Date().toISOString();
    await this.config.journal.emit(this.session.session_id, "step.started", {
      step_id: step.step_id, title: step.title, tool: step.tool_ref.name,
    });

    const beforeStepResult = await this.runHook("before_step", {
      step_id: step.step_id, tool: step.tool_ref.name, input: step.input,
    });
    if (beforeStepResult.action === "block") {
      const result: StepResult = {
        step_id: step.step_id, status: "failed",
        error: { code: "PLUGIN_HOOK_BLOCKED", message: `Step blocked by plugin: ${(beforeStepResult as { reason: string }).reason}` },
        started_at: startedAt, finished_at: new Date().toISOString(), attempts: 0,
      };
      this.taskState.setStepResult(step.step_id, result);
      await this.config.journal.tryEmit(this.session.session_id, "step.failed", {
        step_id: step.step_id, status: "failed", attempts: 0, error: result.error,
      });
      return;
    }
    if (beforeStepResult.action === "modify" && beforeStepResult.data) {
      if (beforeStepResult.data.input) {
        step = { ...step, input: beforeStepResult.data.input as Record<string, unknown> };
      }
    }

    let attempts = 0;
    let lastResult: StepResult | null = null;
    while (attempts <= step.max_retries) {
      if (attempts > 0 && !this.abortRequested) {
        await sleep(backoff(attempts));
      }
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

      const beforeToolResult = await this.runHook("before_tool_call", {
        step_id: step.step_id, tool_name: request.tool_name, input: request.input,
      });
      if (beforeToolResult.action === "block") {
        lastResult = {
          step_id: step.step_id, status: "failed",
          error: { code: "PLUGIN_HOOK_BLOCKED", message: `Tool call blocked by plugin: ${(beforeToolResult as { reason: string }).reason}` },
          started_at: startedAt, finished_at: new Date().toISOString(), attempts,
        };
        break;
      }
      if (beforeToolResult.action === "modify" && beforeToolResult.data) {
        if (beforeToolResult.data.input) {
          request.input = beforeToolResult.data.input as Record<string, unknown>;
        }
      }

      const toolResult = await this.config.toolRuntime.execute(request);

      const afterToolResult = await this.runHook("after_tool_call", {
        step_id: step.step_id, tool_name: request.tool_name,
        ok: toolResult.ok, result: toolResult.result, error: toolResult.error,
      });
      if (afterToolResult.action === "modify" && afterToolResult.data) {
        if (afterToolResult.data.result !== undefined) {
          toolResult.result = afterToolResult.data.result;
        }
      }

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

      await this.runHook("after_step", {
        step_id: step.step_id, status: lastResult.status,
        output: lastResult.output, error: lastResult.error,
      });
    }
  }

  async resumeSession(sessionId: string): Promise<Session | null> {
    if (this.running) throw new Error("Kernel is already running. Concurrent calls are not allowed.");
    this.running = true;
    try {
    const events = await this.config.journal.readSession(sessionId);
    if (events.length === 0) return null;

    // Check session hasn't already terminated
    const terminalTypes = new Set(["session.completed", "session.failed", "session.aborted"]);
    if (events.some((e) => terminalTypes.has(e.type))) return null;

    // Agentic sessions cannot be resumed — multi-iteration state is too complex to reconstruct
    if (events.some((e) => e.type === "plan.replaced")) return null;

    // Rebuild session from session.created event
    const createdEvent = events.find((e) => e.type === "session.created");
    if (!createdEvent) return null;

    // Rebuild plan from plan.accepted event
    const planEvent = events.find((e) => e.type === "plan.accepted");
    if (!planEvent || !planEvent.payload.plan) return null;

    const plan = planEvent.payload.plan as Plan;
    const payload = createdEvent.payload;

    this.session = {
      session_id: sessionId,
      status: "running",
      mode: (payload.mode as ExecutionMode) ?? this.config.mode,
      task: { task_id: (payload.task_id as string) ?? "", text: (payload.task_text as string) ?? "", created_at: createdEvent.timestamp },
      active_plan_id: plan.plan_id,
      limits: this.config.limits,
      policy: this.config.policy,
      created_at: createdEvent.timestamp,
      updated_at: new Date().toISOString(),
    };

    this.taskState = new TaskStateManager(sessionId);
    this.usageAccumulator = new UsageAccumulator(this.config.modelPricing);
    if (this.config.agentic && this.config.futilityConfig) {
      this.futilityMonitor = new FutilityMonitor(this.config.futilityConfig);
    }
    this.taskState.setPlan(plan);

    // Rebuild step results from step.succeeded/step.failed events
    for (const event of events) {
      if (event.type === "step.succeeded" || event.type === "step.failed") {
        const stepId = event.payload.step_id as string;
        const stepResult: StepResult = {
          step_id: stepId,
          status: event.type === "step.succeeded" ? "succeeded" : "failed",
          output: event.payload.output as unknown,
          error: event.payload.error as { code: string; message: string; data?: unknown } | undefined,
          started_at: event.timestamp,
          finished_at: event.timestamp,
          attempts: (event.payload.attempts as number) ?? 1,
        };
        this.taskState.setStepResult(stepId, stepResult);
      }
    }

    this.sessionStartTime = Date.now();

    // Emit recovery event and continue execution
    await this.config.journal.emit(sessionId, "session.started", { recovered: true });
    await this.executePhase(plan);

    if (this.session.status === "running") {
      await this.transition("completed");
      await this.config.journal.emit(sessionId, "session.completed", {
        step_results: this.taskState.getSnapshot().step_results,
      });
    }

    this.config.permissions?.clearSession(sessionId);
    return this.session;
    } finally {
      this.running = false;
    }
  }

  private async emitCheckpoint(iteration: number): Promise<void> {
    if (!this.session || !this.taskState) return;

    const checkpoint = buildCheckpoint(
      this.session.session_id,
      this.session.task.text,
      this.taskState.getPlan(),
      this.taskState.getAllStepResults(),
      this.usageAccumulator?.getSummary() ?? null,
      iteration,
      Object.fromEntries(
        Object.entries(this.taskState.getSnapshot().artifacts as Record<string, unknown> ?? {}),
      ),
    );

    // Atomic write to checkpoint dir
    const checkpointDir = this.config.checkpointDir ?? "sessions/checkpoints";
    const checkpointPath = join(checkpointDir, `${this.session.session_id}.json`);
    try {
      await mkdir(dirname(checkpointPath), { recursive: true });
      const tmpPath = checkpointPath + ".tmp";
      const fh = await open(tmpPath, "w");
      try {
        await fh.writeFile(JSON.stringify(checkpoint, null, 2), "utf-8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmpPath, checkpointPath);
    } catch {
      // Checkpoint write failure is non-fatal
    }

    await this.config.journal.tryEmit(this.session.session_id, "context.checkpoint_saved", {
      checkpoint_id: checkpoint.checkpoint_id,
      checkpoint_path: checkpointPath,
      findings_count: checkpoint.findings.length,
      usage_at_checkpoint: checkpoint.usage_at_checkpoint,
    });
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
