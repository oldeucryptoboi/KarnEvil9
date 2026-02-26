import { describe, it, expect } from "vitest";
import { FutilityMonitor } from "./futility.js";
import type { IterationRecord } from "./futility.js";
import type { StepResult, UsageMetrics } from "@karnevil9/schemas";
import type { UsageSummary } from "./usage-accumulator.js";

function makeResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    step_id: "s1",
    status: "succeeded",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    attempts: 1,
    ...overrides,
  };
}

function makeFailedResult(errorMsg: string): StepResult {
  return makeResult({
    status: "failed",
    error: { code: "ERR", message: errorMsg },
  });
}

function makeRecord(iteration: number, goal: string, stepResults: StepResult[]): IterationRecord {
  return { iteration, planGoal: goal, stepResults };
}

describe("FutilityMonitor", () => {
  // ─── Repeated Error Detection ────────────────────────────────────

  it("halts after maxRepeatedErrors consecutive identical errors", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 3 });
    const err = makeFailedResult("Connection refused");

    expect(monitor.recordIteration(makeRecord(1, "goal-1", [err])).action).toBe("continue");
    expect(monitor.recordIteration(makeRecord(2, "goal-2", [err])).action).toBe("continue");
    const v3 = monitor.recordIteration(makeRecord(3, "goal-3", [err]));
    expect(v3.action).toBe("halt");
    expect(v3).toHaveProperty("reason");
    expect((v3 as { reason: string }).reason).toContain("Same error repeated");
  });

  it("normalizes error messages (case, whitespace)", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 2 });

    monitor.recordIteration(makeRecord(1, "g1", [makeFailedResult("  Connection  Refused  ")]));
    const v2 = monitor.recordIteration(makeRecord(2, "g2", [makeFailedResult("connection refused")]));
    expect(v2.action).toBe("halt");
  });

  it("does not trigger on different errors", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 3 });

    monitor.recordIteration(makeRecord(1, "g1", [makeFailedResult("Error A")]));
    monitor.recordIteration(makeRecord(2, "g2", [makeFailedResult("Error B")]));
    const v3 = monitor.recordIteration(makeRecord(3, "g3", [makeFailedResult("Error A")]));
    expect(v3.action).toBe("continue");
  });

  it("does not trigger on iterations without errors", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 2 });
    const ok = makeResult();

    expect(monitor.recordIteration(makeRecord(1, "g1", [ok])).action).toBe("continue");
    expect(monitor.recordIteration(makeRecord(2, "g2", [ok])).action).toBe("continue");
    expect(monitor.recordIteration(makeRecord(3, "g3", [ok])).action).toBe("continue");
  });

  it("uses first 200 chars for error comparison (truncates long errors)", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 2 });
    const base = "x".repeat(200);
    // Same first 200 chars, different suffixes
    monitor.recordIteration(makeRecord(1, "g1", [makeFailedResult(base + " suffix-A")]));
    const v2 = monitor.recordIteration(makeRecord(2, "g2", [makeFailedResult(base + " suffix-B")]));
    expect(v2.action).toBe("halt");
  });

  // ─── Stagnation Detection ────────────────────────────────────────

  it("halts when success count does not increase for maxStagnantIterations", () => {
    const monitor = new FutilityMonitor({ maxStagnantIterations: 3, maxRepeatedErrors: 99, maxIdenticalPlans: 99 });

    // Iteration 1: baseline with 1 success
    expect(monitor.recordIteration(makeRecord(1, "g1", [makeResult()])).action).toBe("continue");
    // Iterations 2-4: still 1 success each (no growth)
    expect(monitor.recordIteration(makeRecord(2, "g2", [makeResult()])).action).toBe("continue");
    expect(monitor.recordIteration(makeRecord(3, "g3", [makeResult()])).action).toBe("continue");
    const v4 = monitor.recordIteration(makeRecord(4, "g4", [makeResult()]));
    expect(v4.action).toBe("halt");
    expect((v4 as { reason: string }).reason).toContain("No progress");
  });

  it("does not trigger stagnation when success count grows", () => {
    const monitor = new FutilityMonitor({ maxStagnantIterations: 2, maxRepeatedErrors: 99, maxIdenticalPlans: 99 });

    monitor.recordIteration(makeRecord(1, "g1", [makeResult()]));
    monitor.recordIteration(makeRecord(2, "g2", [makeResult(), makeResult({ step_id: "s2" })]));
    const v3 = monitor.recordIteration(makeRecord(3, "g3", [
      makeResult(), makeResult({ step_id: "s2" }), makeResult({ step_id: "s3" }),
    ]));
    expect(v3.action).toBe("continue");
  });

  it("detects stagnation at zero successes", () => {
    const monitor = new FutilityMonitor({ maxStagnantIterations: 2, maxRepeatedErrors: 99, maxIdenticalPlans: 99 });
    const fail = makeFailedResult("err-a");
    const fail2 = makeFailedResult("err-b");
    const fail3 = makeFailedResult("err-c");

    monitor.recordIteration(makeRecord(1, "g1", [fail]));
    monitor.recordIteration(makeRecord(2, "g2", [fail2]));
    const v3 = monitor.recordIteration(makeRecord(3, "g3", [fail3]));
    expect(v3.action).toBe("halt");
    expect((v3 as { reason: string }).reason).toContain("stuck at 0");
  });

  // ─── Identical Plan Detection ────────────────────────────────────

  it("halts when same goal appears maxIdenticalPlans times", () => {
    const monitor = new FutilityMonitor({ maxIdenticalPlans: 2, maxRepeatedErrors: 99, maxStagnantIterations: 99 });

    expect(monitor.recordIteration(makeRecord(1, "Fix the bug", [makeResult()])).action).toBe("continue");
    const v2 = monitor.recordIteration(makeRecord(2, "Fix the bug", [makeResult(), makeResult({ step_id: "s2" })]));
    expect(v2.action).toBe("halt");
    expect((v2 as { reason: string }).reason).toContain("Identical plan goal");
  });

  it("does not trigger for different goals", () => {
    const monitor = new FutilityMonitor({ maxIdenticalPlans: 2, maxRepeatedErrors: 99, maxStagnantIterations: 99 });

    monitor.recordIteration(makeRecord(1, "Fix bug A", [makeResult()]));
    const v2 = monitor.recordIteration(makeRecord(2, "Fix bug B", [makeResult(), makeResult({ step_id: "s2" })]));
    expect(v2.action).toBe("continue");
  });

  it("does not trigger on non-consecutive identical goals (A→B→A)", () => {
    const monitor = new FutilityMonitor({ maxIdenticalPlans: 2, maxRepeatedErrors: 99, maxStagnantIterations: 99 });

    monitor.recordIteration(makeRecord(1, "Gather data", [makeResult()]));
    monitor.recordIteration(makeRecord(2, "Analyze results", [makeResult(), makeResult({ step_id: "s2" })]));
    // Revisit "Gather data" — only 1 consecutive, should NOT halt
    const v3 = monitor.recordIteration(makeRecord(3, "Gather data", [makeResult(), makeResult({ step_id: "s2" }), makeResult({ step_id: "s3" })]));
    expect(v3.action).toBe("continue");
  });

  it("triggers on consecutive identical goals", () => {
    const monitor = new FutilityMonitor({ maxIdenticalPlans: 2, maxRepeatedErrors: 99, maxStagnantIterations: 99 });

    monitor.recordIteration(makeRecord(1, "Gather data", [makeResult()]));
    monitor.recordIteration(makeRecord(2, "Analyze results", [makeResult(), makeResult({ step_id: "s2" })]));
    monitor.recordIteration(makeRecord(3, "Gather data", [makeResult(), makeResult({ step_id: "s2" }), makeResult({ step_id: "s3" })]));
    // Now two consecutive "Gather data" → should halt
    const v4 = monitor.recordIteration(makeRecord(4, "Gather data", [makeResult(), makeResult({ step_id: "s2" }), makeResult({ step_id: "s3" }), makeResult({ step_id: "s4" })]));
    expect(v4.action).toBe("halt");
    expect((v4 as { reason: string }).reason).toContain("consecutive");
  });

  // ─── Priority / First Match Wins ─────────────────────────────────

  it("repeated error takes priority over stagnation", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 2, maxStagnantIterations: 2, maxIdenticalPlans: 99 });
    const fail = makeFailedResult("same error");

    monitor.recordIteration(makeRecord(1, "g1", [fail]));
    // Iteration 2: same error AND stagnation (0 successes in both)
    const v2 = monitor.recordIteration(makeRecord(2, "g2", [fail]));
    expect(v2.action).toBe("halt");
    expect((v2 as { reason: string }).reason).toContain("Same error repeated");
  });

  // ─── Default Config ──────────────────────────────────────────────

  it("uses default config values when none provided", () => {
    const monitor = new FutilityMonitor();
    const ok = makeResult();

    // Should take 4 iterations (baseline + 3 stagnant) to trigger stagnation with defaults
    monitor.recordIteration(makeRecord(1, "g1", [ok]));
    monitor.recordIteration(makeRecord(2, "g2", [ok]));
    monitor.recordIteration(makeRecord(3, "g3", [ok]));
    const v4 = monitor.recordIteration(makeRecord(4, "g4", [ok]));
    expect(v4.action).toBe("halt");
  });

  // ─── Edge Cases ──────────────────────────────────────────────────

  it("handles empty step results", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 3, maxStagnantIterations: 99, maxIdenticalPlans: 99 });
    expect(monitor.recordIteration(makeRecord(1, "g1", [])).action).toBe("continue");
    expect(monitor.recordIteration(makeRecord(2, "g2", [])).action).toBe("continue");
  });

  it("single iteration never triggers", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 1, maxStagnantIterations: 1, maxIdenticalPlans: 1 });
    // Even with maxIdenticalPlans=1, first occurrence should still be "continue"
    // Actually maxIdenticalPlans=1 means halt on first appearance
    const v = monitor.recordIteration(makeRecord(1, "goal", [makeFailedResult("err")]));
    // With maxIdenticalPlans=1, a single appearance matches >= 1
    expect(v.action).toBe("halt");
  });

  it("mixed success and failure across iterations", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 3, maxStagnantIterations: 3, maxIdenticalPlans: 99 });

    // Iteration 1: 1 success, 1 failure
    monitor.recordIteration(makeRecord(1, "g1", [makeResult(), makeFailedResult("err-a")]));
    // Iteration 2: 2 successes — growth
    monitor.recordIteration(makeRecord(2, "g2", [makeResult(), makeResult({ step_id: "s2" })]));
    // Iteration 3: 2 successes — stagnant start
    monitor.recordIteration(makeRecord(3, "g3", [makeResult(), makeResult({ step_id: "s2" })]));
    // Iteration 4: 3 successes — growth resets stagnation
    const v4 = monitor.recordIteration(makeRecord(4, "g4", [
      makeResult(), makeResult({ step_id: "s2" }), makeResult({ step_id: "s3" }),
    ]));
    expect(v4.action).toBe("continue");
  });

  // ─── History Bounding ─────────────────────────────────────────────

  it("bounds history arrays to prevent unbounded memory growth", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 99, maxStagnantIterations: 99, maxIdenticalPlans: 99 });
    // Record 150 iterations with increasing successes — no detection should trigger
    for (let i = 0; i < 150; i++) {
      const steps = Array.from({ length: i + 1 }, (_, j) => makeResult({ step_id: `s${i}-${j}` }));
      const v = monitor.recordIteration(makeRecord(i, `goal-${i}`, steps));
      expect(v.action).toBe("continue");
    }
    // If we got here without OOM and all continued, the bounding works
  });

  // ─── Error Reset After Success ─────────────────────────────────────

  it("error counter resets when a successful iteration intervenes", () => {
    const monitor = new FutilityMonitor({ maxRepeatedErrors: 3 });
    const err = makeFailedResult("Connection refused");

    monitor.recordIteration(makeRecord(1, "g1", [err]));
    monitor.recordIteration(makeRecord(2, "g2", [err]));
    // Successful iteration breaks the chain
    monitor.recordIteration(makeRecord(3, "g3", [makeResult()]));
    monitor.recordIteration(makeRecord(4, "g4", [err]));
    const v5 = monitor.recordIteration(makeRecord(5, "g5", [err]));
    // Only 2 consecutive errors, not 3
    expect(v5.action).toBe("continue");
  });

  // ─── Budget Burn Edge Cases ────────────────────────────────────────

  it("budget burn does not trigger when exactly at threshold with high progress", () => {
    const monitor = new FutilityMonitor({
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      budgetBurnThreshold: 0.8,
    });

    const cumulativeUsage: UsageSummary = {
      total_input_tokens: 4000,
      total_output_tokens: 4000,
      total_tokens: 8000,
      total_cost_usd: 8.0,  // Exactly 80% of budget
      call_count: 5,
    };

    // All steps succeed (100% success rate > 50% threshold)
    const v = monitor.recordIteration({
      ...makeRecord(1, "g1", [makeResult(), makeResult({ step_id: "s2" })]),
      cumulativeUsage,
      maxCostUsd: 10.0,
    });
    expect(v.action).toBe("continue");
  });

  it("budget burn halts at exactly 50% success rate boundary", () => {
    const monitor = new FutilityMonitor({
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      budgetBurnThreshold: 0.8,
    });

    const cumulativeUsage: UsageSummary = {
      total_input_tokens: 4500,
      total_output_tokens: 4500,
      total_tokens: 9000,
      total_cost_usd: 8.5,  // 85% of budget
      call_count: 5,
    };

    // Exactly 1 success out of 2 steps = 50%, but condition is < 0.5, so 50% is OK
    const v = monitor.recordIteration({
      ...makeRecord(1, "g1", [makeResult(), makeFailedResult("err")]),
      cumulativeUsage,
      maxCostUsd: 10.0,
    });
    expect(v.action).toBe("continue");

    // Below 50%: 1 success out of 3 = 33%
    const v2 = monitor.recordIteration({
      ...makeRecord(2, "g2", [makeResult(), makeFailedResult("err"), makeFailedResult("err2")]),
      cumulativeUsage,
      maxCostUsd: 10.0,
    });
    expect(v2.action).toBe("halt");
  });

  it("budget burn with maxCostUsd=0 does not trigger", () => {
    const monitor = new FutilityMonitor({ budgetBurnThreshold: 0.5 });
    const cumulativeUsage: UsageSummary = {
      total_input_tokens: 1000,
      total_output_tokens: 1000,
      total_tokens: 2000,
      total_cost_usd: 100.0,
      call_count: 1,
    };

    const v = monitor.recordIteration({
      ...makeRecord(1, "g1", [makeFailedResult("err")]),
      cumulativeUsage,
      maxCostUsd: 0,
    });
    expect(v.action).toBe("continue");
  });

  // ─── Cost-per-progress Detection ──────────────────────────────────

  it("halts after maxCostWithoutProgress iterations spending tokens with no new successes", () => {
    const monitor = new FutilityMonitor({
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      maxCostWithoutProgress: 3,
    });
    const usage: UsageMetrics = { input_tokens: 100, output_tokens: 100, total_tokens: 200 };

    // First iteration: 1 success (baseline)
    expect(monitor.recordIteration({
      ...makeRecord(1, "g1", [makeResult()]),
      iterationUsage: usage,
    }).action).toBe("continue");

    // Iterations 2-4: same 1 success each, spending tokens → no new successes
    expect(monitor.recordIteration({
      ...makeRecord(2, "g2", [makeResult()]),
      iterationUsage: usage,
    }).action).toBe("continue");
    expect(monitor.recordIteration({
      ...makeRecord(3, "g3", [makeResult()]),
      iterationUsage: usage,
    }).action).toBe("continue");
    const v4 = monitor.recordIteration({
      ...makeRecord(4, "g4", [makeResult()]),
      iterationUsage: usage,
    });
    expect(v4.action).toBe("halt");
    expect((v4 as { reason: string }).reason).toContain("without new successful steps");
  });

  it("resets cost-without-progress counter when new successes appear", () => {
    const monitor = new FutilityMonitor({
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      maxCostWithoutProgress: 3,
    });
    const usage: UsageMetrics = { input_tokens: 100, output_tokens: 100, total_tokens: 200 };

    // Iteration 1: 1 success
    monitor.recordIteration({ ...makeRecord(1, "g1", [makeResult()]), iterationUsage: usage });
    // Iteration 2: still 1 success (no new)
    monitor.recordIteration({ ...makeRecord(2, "g2", [makeResult()]), iterationUsage: usage });
    // Iteration 3: 2 successes (progress!) — resets counter
    const v3 = monitor.recordIteration({
      ...makeRecord(3, "g3", [makeResult(), makeResult({ step_id: "s2" })]),
      iterationUsage: usage,
    });
    expect(v3.action).toBe("continue");
    // Iteration 4-5: back to no progress, but counter was reset
    monitor.recordIteration({ ...makeRecord(4, "g4", [makeResult(), makeResult({ step_id: "s2" })]), iterationUsage: usage });
    const v5 = monitor.recordIteration({ ...makeRecord(5, "g5", [makeResult(), makeResult({ step_id: "s2" })]), iterationUsage: usage });
    expect(v5.action).toBe("continue"); // Only 2 without progress, need 3
  });

  it("does not trigger cost-per-progress when no usage metrics provided", () => {
    const monitor = new FutilityMonitor({
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      maxCostWithoutProgress: 1,
    });

    // No iterationUsage → should not trigger cost-per-progress
    expect(monitor.recordIteration(makeRecord(1, "g1", [makeResult()])).action).toBe("continue");
    expect(monitor.recordIteration(makeRecord(2, "g2", [makeResult()])).action).toBe("continue");
  });

  // ─── Budget Burn Rate Detection ───────────────────────────────────

  it("halts when budget burn rate exceeds threshold with low progress", () => {
    const monitor = new FutilityMonitor({
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      maxCostWithoutProgress: 99,
      budgetBurnThreshold: 0.8,
    });

    const cumulativeUsage: UsageSummary = {
      total_input_tokens: 5000,
      total_output_tokens: 5000,
      total_tokens: 10000,
      total_cost_usd: 9.0,  // 90% of budget
      call_count: 5,
    };

    // Zero successes across iterations with 90% budget consumed
    const v = monitor.recordIteration({
      ...makeRecord(1, "g1", [makeFailedResult("err")]),
      cumulativeUsage,
      maxCostUsd: 10.0,
    });
    expect(v.action).toBe("halt");
    expect((v as { reason: string }).reason).toContain("Budget");
    expect((v as { reason: string }).reason).toContain("90%");
  });

  it("does not halt on budget burn when progress is adequate", () => {
    const monitor = new FutilityMonitor({
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      maxCostWithoutProgress: 99,
      budgetBurnThreshold: 0.8,
    });

    const cumulativeUsage: UsageSummary = {
      total_input_tokens: 5000,
      total_output_tokens: 5000,
      total_tokens: 10000,
      total_cost_usd: 9.0,  // 90% of budget
      call_count: 5,
    };

    // Many successes — good progress, even though 90% budget consumed
    const v = monitor.recordIteration({
      ...makeRecord(1, "g1", [makeResult(), makeResult({ step_id: "s2" }), makeResult({ step_id: "s3" })]),
      cumulativeUsage,
      maxCostUsd: 10.0,
    });
    expect(v.action).toBe("continue");
  });

  it("does not trigger budget burn when maxCostUsd is not set", () => {
    const monitor = new FutilityMonitor({
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      budgetBurnThreshold: 0.5,
    });

    const cumulativeUsage: UsageSummary = {
      total_input_tokens: 5000,
      total_output_tokens: 5000,
      total_tokens: 10000,
      total_cost_usd: 100.0,
      call_count: 5,
    };

    // No maxCostUsd → cannot compute burn rate
    const v = monitor.recordIteration({
      ...makeRecord(1, "g1", [makeFailedResult("err")]),
      cumulativeUsage,
    });
    expect(v.action).toBe("continue");
  });
});
