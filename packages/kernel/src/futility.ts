import type { StepResult, UsageMetrics } from "@karnevil9/schemas";
import type { UsageSummary } from "./usage-accumulator.js";

export interface IterationRecord {
  iteration: number;
  planGoal: string;
  stepResults: StepResult[];
  iterationUsage?: UsageMetrics;
  cumulativeUsage?: UsageSummary;
  maxCostUsd?: number;
}

export type FutilityVerdict =
  | { action: "continue" }
  | { action: "warn"; reason: string }
  | { action: "halt"; reason: string };

export interface FutilityConfig {
  maxRepeatedErrors?: number;
  maxStagnantIterations?: number;
  maxIdenticalPlans?: number;
  maxCostWithoutProgress?: number;
  budgetBurnThreshold?: number;
}

function normalizeError(msg: string): string {
  return msg.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

export class FutilityMonitor {
  private maxRepeatedErrors: number;
  private maxStagnantIterations: number;
  private maxIdenticalPlans: number;
  private maxCostWithoutProgress: number;
  private budgetBurnThreshold: number;

  private errorHistory: string[] = [];
  private successCountHistory: number[] = [];
  private goalHistory: string[] = [];
  private costWithoutProgressCount = 0;
  private lastCumulativeSuccesses = 0;

  constructor(config?: FutilityConfig) {
    this.maxRepeatedErrors = config?.maxRepeatedErrors ?? 3;
    this.maxStagnantIterations = config?.maxStagnantIterations ?? 3;
    this.maxIdenticalPlans = config?.maxIdenticalPlans ?? 2;
    this.maxCostWithoutProgress = config?.maxCostWithoutProgress ?? Infinity;
    this.budgetBurnThreshold = config?.budgetBurnThreshold ?? 0.8;
  }

  recordIteration(record: IterationRecord): FutilityVerdict {
    // Extract the dominant error from this iteration (first failed step's error message)
    const failedStep = record.stepResults.find(r => r.status === "failed" && r.error);
    const errorMsg = failedStep?.error?.message;
    this.errorHistory.push(errorMsg ? normalizeError(errorMsg) : "");

    // Track cumulative successful steps
    const successCount = record.stepResults.filter(r => r.status === "succeeded").length;
    this.successCountHistory.push(successCount);

    // Track plan goals
    this.goalHistory.push(record.planGoal);

    // Bound history to prevent unbounded memory growth
    const MAX_HISTORY = 100;
    if (this.goalHistory.length > MAX_HISTORY) this.goalHistory.shift();
    if (this.errorHistory.length > MAX_HISTORY) this.errorHistory.shift();
    if (this.successCountHistory.length > MAX_HISTORY) this.successCountHistory.shift();

    // 1. Repeated Error Detection
    if (this.errorHistory.length >= this.maxRepeatedErrors) {
      const recent = this.errorHistory.slice(-this.maxRepeatedErrors);
      if (recent[0] !== "" && recent.every(e => e === recent[0])) {
        return {
          action: "halt",
          reason: `Same error repeated ${this.maxRepeatedErrors} consecutive iterations: "${recent[0]}"`,
        };
      }
    }

    // 2. Stagnation Detection
    // Need at least maxStagnantIterations records (baseline is first, then N stagnant)
    if (this.successCountHistory.length >= this.maxStagnantIterations + 1) {
      const window = this.successCountHistory.slice(-(this.maxStagnantIterations + 1));
      const baseline = window[0]!;
      const stagnant = window.slice(1).every(c => c <= baseline);
      if (stagnant) {
        const stuckAt = baseline === 0 ? "stuck at 0" : `stuck at ${baseline}`;
        return {
          action: "halt",
          reason: `No progress for ${this.maxStagnantIterations} consecutive iterations (successful steps ${stuckAt})`,
        };
      }
    }

    // 3. Identical Plan Detection — count consecutive identical goals (not total)
    if (this.goalHistory.length >= this.maxIdenticalPlans) {
      const currentGoal = this.goalHistory[this.goalHistory.length - 1]!;
      let consecutiveCount = 0;
      for (let i = this.goalHistory.length - 1; i >= 0; i--) {
        if (this.goalHistory[i] === currentGoal) consecutiveCount++;
        else break;
      }
      if (consecutiveCount >= this.maxIdenticalPlans) {
        return {
          action: "halt",
          reason: `Identical plan goal repeated ${consecutiveCount} consecutive times: "${currentGoal}"`,
        };
      }
    }

    // 4. Cost-per-progress: halt after N iterations spending tokens with no new successes
    if (record.iterationUsage && record.iterationUsage.total_tokens > 0) {
      if (successCount > this.lastCumulativeSuccesses) {
        this.costWithoutProgressCount = 0;
        this.lastCumulativeSuccesses = successCount;
      } else {
        this.costWithoutProgressCount++;
      }
      if (this.costWithoutProgressCount >= this.maxCostWithoutProgress) {
        return {
          action: "halt",
          reason: `Spent tokens for ${this.costWithoutProgressCount} consecutive iterations without new successful steps`,
        };
      }
    }

    // 5. Budget burn rate: halt when cost/maxCost ratio exceeds threshold with low progress
    if (record.cumulativeUsage && record.maxCostUsd && record.maxCostUsd > 0) {
      const burnRate = record.cumulativeUsage.total_cost_usd / record.maxCostUsd;
      if (burnRate >= this.budgetBurnThreshold) {
        // Calculate success ratio: proportion of steps that succeeded
        const totalSteps = record.stepResults.length;
        const successfulSteps = record.stepResults.filter(r => r.status === "succeeded").length;
        const successRatio = totalSteps > 0 ? successfulSteps / totalSteps : 0;
        // Halt if success ratio is below 50% — burning budget with mostly failures
        if (successRatio < 0.5) {
          return {
            action: "halt",
            reason: `Budget ${(burnRate * 100).toFixed(0)}% consumed ($${record.cumulativeUsage.total_cost_usd.toFixed(4)} / $${record.maxCostUsd}) with low progress (${successfulSteps}/${totalSteps} steps succeeded this iteration)`,
          };
        }
      }
    }

    return { action: "continue" };
  }
}
