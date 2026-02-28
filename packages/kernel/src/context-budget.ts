import { v4 as uuid } from "uuid";
import type { SessionCheckpointData, CheckpointFinding, Plan, StepResult } from "@karnevil9/schemas";
import type { UsageSummary } from "./usage-accumulator.js";

// ─── Config ─────────────────────────────────────────────────────────

export interface ContextBudgetConfig {
  delegateThreshold?: number;       // Default 0.70
  checkpointThreshold?: number;     // Default 0.85
  summarizeThreshold?: number;      // Default 0.90
  highBurnTools?: string[];         // Default ["browser", "http-request"]
  highBurnMultiplier?: number;      // Default 2.5
  minIterationsBeforeAction?: number; // Default 2
  enableDelegation?: boolean;       // Default true
  enableCheckpoint?: boolean;       // Default true
}

// ─── Verdicts ───────────────────────────────────────────────────────

export type ContextBudgetVerdict =
  | { action: "continue" }
  | { action: "delegate"; reason: string; taskDescription: string }
  | { action: "checkpoint"; reason: string }
  | { action: "summarize"; reason: string };

// ─── Iteration Input ────────────────────────────────────────────────

export interface ContextIteration {
  iteration: number;
  tokensUsedThisIteration: number;
  cumulativeTokens: number;
  maxTokens: number;
  toolsUsed: string[];
  planGoal: string;
  stepCount: number;
}

// ─── Monitor ────────────────────────────────────────────────────────

const VELOCITY_WINDOW = 5;

export class ContextBudgetMonitor {
  private delegateThreshold: number;
  private checkpointThreshold: number;
  private summarizeThreshold: number;
  private highBurnTools: Set<string>;
  private highBurnMultiplier: number;
  private minIterationsBeforeAction: number;
  private enableDelegation: boolean;
  private enableCheckpoint: boolean;

  private tokenHistory: number[] = [];
  private iterationCount = 0;

  constructor(config?: ContextBudgetConfig) {
    this.delegateThreshold = config?.delegateThreshold ?? 0.70;
    this.checkpointThreshold = config?.checkpointThreshold ?? 0.85;
    this.summarizeThreshold = config?.summarizeThreshold ?? 0.90;
    this.highBurnTools = new Set(config?.highBurnTools ?? ["browser", "http-request"]);
    this.highBurnMultiplier = config?.highBurnMultiplier ?? 2.5;
    this.minIterationsBeforeAction = config?.minIterationsBeforeAction ?? 2;
    this.enableDelegation = config?.enableDelegation ?? true;
    this.enableCheckpoint = config?.enableCheckpoint ?? true;
  }

  recordIteration(iter: ContextIteration): ContextBudgetVerdict {
    this.iterationCount++;
    this.tokenHistory.push(iter.tokensUsedThisIteration);
    if (this.tokenHistory.length > VELOCITY_WINDOW) {
      this.tokenHistory.shift();
    }

    if (iter.maxTokens <= 0) return { action: "continue" };

    const fraction = iter.cumulativeTokens / iter.maxTokens;
    const tooEarly = this.iterationCount < this.minIterationsBeforeAction;

    // Priority 1: Summarize (highest urgency)
    if (fraction >= this.summarizeThreshold && !tooEarly) {
      return {
        action: "summarize",
        reason: `Token usage at ${(fraction * 100).toFixed(0)}% (${iter.cumulativeTokens}/${iter.maxTokens}), approaching context limit`,
      };
    }

    // Priority 2: Checkpoint
    if (fraction >= this.checkpointThreshold && !tooEarly && this.enableCheckpoint) {
      return {
        action: "checkpoint",
        reason: `Token usage at ${(fraction * 100).toFixed(0)}% (${iter.cumulativeTokens}/${iter.maxTokens}), saving checkpoint`,
      };
    }

    // Priority 3: Delegate (requires high-burn tools)
    const hasHighBurn = iter.toolsUsed.some(t => this.highBurnTools.has(t));

    if (fraction >= this.delegateThreshold && hasHighBurn && !tooEarly && this.enableDelegation) {
      return {
        action: "delegate",
        reason: `Token usage at ${(fraction * 100).toFixed(0)}% with high-burn tools [${iter.toolsUsed.filter(t => this.highBurnTools.has(t)).join(", ")}]`,
        taskDescription: `Continue research: ${iter.planGoal}`,
      };
    }

    // Priority 4: Velocity projection → early delegation
    if (hasHighBurn && !tooEarly && this.enableDelegation && this.tokenHistory.length >= 2) {
      const velocity = this.getTokenVelocity();
      const projectedTokens = iter.cumulativeTokens + velocity * this.highBurnMultiplier * 2;
      const projectedFraction = projectedTokens / iter.maxTokens;
      if (projectedFraction >= this.checkpointThreshold) {
        return {
          action: "delegate",
          reason: `Token velocity ${velocity.toFixed(0)}/iter projects ${(projectedFraction * 100).toFixed(0)}% within 2 iterations (high-burn tools active)`,
          taskDescription: `Continue research: ${iter.planGoal}`,
        };
      }
    }

    return { action: "continue" };
  }

  private getTokenVelocity(): number {
    if (this.tokenHistory.length === 0) return 0;
    const sum = this.tokenHistory.reduce((a, b) => a + b, 0);
    const avg = sum / this.tokenHistory.length;
    return Number.isFinite(avg) ? avg : 0;
  }
}

// ─── Checkpoint Builder ─────────────────────────────────────────────

const MAX_FINDING_SUMMARY_LEN = 500;

export function buildCheckpoint(
  sessionId: string,
  taskText: string,
  plan: Plan | null,
  stepResults: StepResult[],
  usage: UsageSummary | null,
  iterationsCompleted: number,
  artifacts: Record<string, unknown>,
): SessionCheckpointData {
  const findings: CheckpointFinding[] = stepResults.map(r => {
    const step = plan?.steps.find(s => s.step_id === r.step_id);
    const rawSummary = r.status === "succeeded"
      ? (typeof r.output === "string" ? r.output : JSON.stringify(r.output ?? ""))
      : (r.error?.message ?? "unknown error");
    return {
      step_title: step?.title ?? r.step_id,
      tool_name: step?.tool_ref.name ?? "unknown",
      status: r.status === "succeeded" ? "succeeded" : "failed",
      summary: rawSummary.slice(0, MAX_FINDING_SUMMARY_LEN),
    };
  });

  return {
    checkpoint_id: uuid(),
    source_session_id: sessionId,
    task_text: taskText,
    findings,
    next_steps: plan ? plan.steps.filter(s => !stepResults.some(r => r.step_id === s.step_id)).map(s => s.title) : [],
    open_questions: [],
    last_plan_goal: plan?.goal ?? "",
    usage_at_checkpoint: {
      total_tokens: usage?.total_tokens ?? 0,
      total_cost_usd: usage?.total_cost_usd ?? 0,
      iterations_completed: iterationsCompleted,
    },
    artifacts,
    created_at: new Date().toISOString(),
  };
}
