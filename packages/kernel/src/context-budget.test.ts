import { describe, it, expect } from "vitest";
import { ContextBudgetMonitor, buildCheckpoint } from "./context-budget.js";
import type { ContextIteration } from "./context-budget.js";
import type { Plan, StepResult } from "@openvger/schemas";
import type { UsageSummary } from "./usage-accumulator.js";

function makeIteration(overrides: Partial<ContextIteration> = {}): ContextIteration {
  return {
    iteration: 1,
    tokensUsedThisIteration: 1000,
    cumulativeTokens: 5000,
    maxTokens: 10000,
    toolsUsed: ["test-tool"],
    planGoal: "Test goal",
    stepCount: 1,
    ...overrides,
  };
}

describe("ContextBudgetMonitor", () => {
  // ─── Delegation ───────────────────────────────────────────────────

  it("fires delegation at 70% with high-burn tools", () => {
    const monitor = new ContextBudgetMonitor({
      delegateThreshold: 0.70,
      minIterationsBeforeAction: 2,
    });

    // Iteration 1: below min iterations (low token velocity to avoid projection trigger)
    monitor.recordIteration(makeIteration({ iteration: 1, tokensUsedThisIteration: 500, cumulativeTokens: 3000, maxTokens: 10000, toolsUsed: ["browser"] }));
    // Iteration 2: below threshold, low velocity
    const v2 = monitor.recordIteration(makeIteration({ iteration: 2, tokensUsedThisIteration: 500, cumulativeTokens: 3500, maxTokens: 10000, toolsUsed: ["browser"] }));
    expect(v2.action).toBe("continue");

    // Iteration 3: at 70% with high-burn
    const v3 = monitor.recordIteration(makeIteration({ iteration: 3, tokensUsedThisIteration: 500, cumulativeTokens: 7000, maxTokens: 10000, toolsUsed: ["browser"] }));
    expect(v3.action).toBe("delegate");
    expect(v3).toHaveProperty("reason");
    expect(v3).toHaveProperty("taskDescription");
  });

  it("does not delegate without high-burn tools", () => {
    const monitor = new ContextBudgetMonitor({
      delegateThreshold: 0.70,
      minIterationsBeforeAction: 2,
    });

    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 5000, maxTokens: 10000 }));
    monitor.recordIteration(makeIteration({ iteration: 2, cumulativeTokens: 6000, maxTokens: 10000 }));
    const v3 = monitor.recordIteration(makeIteration({ iteration: 3, cumulativeTokens: 7500, maxTokens: 10000, toolsUsed: ["read-file"] }));
    expect(v3.action).toBe("continue");
  });

  // ─── Checkpoint ───────────────────────────────────────────────────

  it("fires checkpoint at 85%", () => {
    const monitor = new ContextBudgetMonitor({
      checkpointThreshold: 0.85,
      minIterationsBeforeAction: 2,
    });

    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 5000 }));
    monitor.recordIteration(makeIteration({ iteration: 2, cumulativeTokens: 7000 }));
    const v3 = monitor.recordIteration(makeIteration({ iteration: 3, cumulativeTokens: 8500, maxTokens: 10000 }));
    expect(v3.action).toBe("checkpoint");
    expect(v3).toHaveProperty("reason");
  });

  // ─── Summarize ────────────────────────────────────────────────────

  it("fires summarize at 90%", () => {
    const monitor = new ContextBudgetMonitor({
      summarizeThreshold: 0.90,
      minIterationsBeforeAction: 2,
    });

    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 5000 }));
    monitor.recordIteration(makeIteration({ iteration: 2, cumulativeTokens: 7000 }));
    const v3 = monitor.recordIteration(makeIteration({ iteration: 3, cumulativeTokens: 9000, maxTokens: 10000 }));
    expect(v3.action).toBe("summarize");
  });

  // ─── Priority ─────────────────────────────────────────────────────

  it("summarize > checkpoint > delegate (priority order)", () => {
    // At 92%, all thresholds crossed, summarize should win
    const monitor = new ContextBudgetMonitor({
      delegateThreshold: 0.70,
      checkpointThreshold: 0.85,
      summarizeThreshold: 0.90,
      minIterationsBeforeAction: 1,
    });

    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 5000 }));
    const v = monitor.recordIteration(makeIteration({
      iteration: 2,
      cumulativeTokens: 9200,
      maxTokens: 10000,
      toolsUsed: ["browser"],
    }));
    expect(v.action).toBe("summarize");
  });

  it("checkpoint beats delegate at 87%", () => {
    const monitor = new ContextBudgetMonitor({
      delegateThreshold: 0.70,
      checkpointThreshold: 0.85,
      summarizeThreshold: 0.95,
      minIterationsBeforeAction: 1,
    });

    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 5000 }));
    const v = monitor.recordIteration(makeIteration({
      iteration: 2,
      cumulativeTokens: 8700,
      maxTokens: 10000,
      toolsUsed: ["browser"],
    }));
    expect(v.action).toBe("checkpoint");
  });

  // ─── Token Velocity Projection ───────────────────────────────────

  it("velocity projection triggers early delegation", () => {
    const monitor = new ContextBudgetMonitor({
      delegateThreshold: 0.90,  // High threshold so direct delegation won't fire
      checkpointThreshold: 0.95,
      summarizeThreshold: 0.98,
      highBurnMultiplier: 2.5,
      minIterationsBeforeAction: 2,
    });

    // Build up velocity history: 3000 tokens per iteration
    monitor.recordIteration(makeIteration({ iteration: 1, tokensUsedThisIteration: 3000, cumulativeTokens: 3000, toolsUsed: ["browser"] }));
    monitor.recordIteration(makeIteration({ iteration: 2, tokensUsedThisIteration: 3000, cumulativeTokens: 6000, toolsUsed: ["browser"] }));

    // At 60%, but velocity=3000, projection = 6000 + 3000*2.5*2 = 21000 → 210% → way above checkpoint
    const v = monitor.recordIteration(makeIteration({
      iteration: 3,
      tokensUsedThisIteration: 3000,
      cumulativeTokens: 6000,
      maxTokens: 10000,
      toolsUsed: ["browser"],
    }));
    expect(v.action).toBe("delegate");
    expect((v as { reason: string }).reason).toContain("velocity");
  });

  // ─── minIterationsBeforeAction ────────────────────────────────────

  it("prevents premature verdicts with minIterationsBeforeAction", () => {
    const monitor = new ContextBudgetMonitor({
      checkpointThreshold: 0.50,
      summarizeThreshold: 0.60,
      minIterationsBeforeAction: 3,
    });

    // Iteration 1: at 90% but too early
    const v1 = monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 9000, maxTokens: 10000 }));
    expect(v1.action).toBe("continue");

    // Iteration 2: still too early
    const v2 = monitor.recordIteration(makeIteration({ iteration: 2, cumulativeTokens: 9000, maxTokens: 10000 }));
    expect(v2.action).toBe("continue");

    // Iteration 3: now eligible
    const v3 = monitor.recordIteration(makeIteration({ iteration: 3, cumulativeTokens: 9000, maxTokens: 10000 }));
    expect(v3.action).toBe("summarize");
  });

  // ─── Disabled Features ────────────────────────────────────────────

  it("respects enableDelegation=false", () => {
    const monitor = new ContextBudgetMonitor({
      delegateThreshold: 0.50,
      checkpointThreshold: 0.99,
      summarizeThreshold: 0.99,
      enableDelegation: false,
      minIterationsBeforeAction: 1,
    });

    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 3000 }));
    const v = monitor.recordIteration(makeIteration({
      iteration: 2,
      cumulativeTokens: 6000,
      maxTokens: 10000,
      toolsUsed: ["browser"],
    }));
    expect(v.action).toBe("continue");
  });

  it("respects enableCheckpoint=false", () => {
    const monitor = new ContextBudgetMonitor({
      checkpointThreshold: 0.50,
      summarizeThreshold: 0.99,
      enableCheckpoint: false,
      minIterationsBeforeAction: 1,
    });

    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 3000 }));
    const v = monitor.recordIteration(makeIteration({ iteration: 2, cumulativeTokens: 6000, maxTokens: 10000 }));
    expect(v.action).toBe("continue");
  });

  // ─── Defaults ─────────────────────────────────────────────────────

  it("uses default config values", () => {
    const monitor = new ContextBudgetMonitor();

    // At low usage → continue
    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 1000, maxTokens: 10000 }));
    const v = monitor.recordIteration(makeIteration({ iteration: 2, cumulativeTokens: 2000, maxTokens: 10000 }));
    expect(v.action).toBe("continue");
  });

  // ─── Boundary Conditions ──────────────────────────────────────────

  it("returns continue when maxTokens is 0", () => {
    const monitor = new ContextBudgetMonitor({ minIterationsBeforeAction: 0 });
    const v = monitor.recordIteration(makeIteration({ maxTokens: 0, cumulativeTokens: 99999 }));
    expect(v.action).toBe("continue");
  });

  it("handles empty toolsUsed", () => {
    const monitor = new ContextBudgetMonitor({ minIterationsBeforeAction: 1 });
    monitor.recordIteration(makeIteration({ iteration: 1 }));
    const v = monitor.recordIteration(makeIteration({
      iteration: 2,
      cumulativeTokens: 7500,
      maxTokens: 10000,
      toolsUsed: [],
    }));
    // No high-burn tools → no delegation, below checkpoint threshold
    expect(v.action).toBe("continue");
  });

  it("exact threshold boundary triggers verdict", () => {
    const monitor = new ContextBudgetMonitor({
      summarizeThreshold: 0.90,
      minIterationsBeforeAction: 1,
    });

    monitor.recordIteration(makeIteration({ iteration: 1, cumulativeTokens: 5000 }));
    // Exactly 90%
    const v = monitor.recordIteration(makeIteration({ iteration: 2, cumulativeTokens: 9000, maxTokens: 10000 }));
    expect(v.action).toBe("summarize");
  });
});

// ─── buildCheckpoint ────────────────────────────────────────────────

describe("buildCheckpoint", () => {
  const plan: Plan = {
    plan_id: "plan-1",
    schema_version: "0.1",
    goal: "Test goal",
    assumptions: [],
    steps: [
      { step_id: "s1", title: "Step 1", tool_ref: { name: "tool-a" }, input: {}, success_criteria: ["ok"], failure_policy: "abort", timeout_ms: 5000, max_retries: 0 },
      { step_id: "s2", title: "Step 2", tool_ref: { name: "tool-b" }, input: {}, success_criteria: ["ok"], failure_policy: "abort", timeout_ms: 5000, max_retries: 0 },
    ],
    created_at: new Date().toISOString(),
  };

  it("produces correct structure", () => {
    const results: StepResult[] = [
      { step_id: "s1", status: "succeeded", output: "result data", started_at: "2025-01-01T00:00:00Z", attempts: 1 },
    ];
    const usage: UsageSummary = { total_input_tokens: 100, total_output_tokens: 100, total_tokens: 200, total_cost_usd: 0.01, call_count: 1 };

    const cp = buildCheckpoint("sess-1", "Do something", plan, results, usage, 3, { key: "val" });

    expect(cp.checkpoint_id).toBeTruthy();
    expect(cp.source_session_id).toBe("sess-1");
    expect(cp.task_text).toBe("Do something");
    expect(cp.findings).toHaveLength(1);
    expect(cp.findings[0]!.step_title).toBe("Step 1");
    expect(cp.findings[0]!.tool_name).toBe("tool-a");
    expect(cp.findings[0]!.status).toBe("succeeded");
    expect(cp.next_steps).toEqual(["Step 2"]);
    expect(cp.last_plan_goal).toBe("Test goal");
    expect(cp.usage_at_checkpoint.total_tokens).toBe(200);
    expect(cp.usage_at_checkpoint.iterations_completed).toBe(3);
    expect(cp.artifacts).toEqual({ key: "val" });
    expect(cp.created_at).toBeTruthy();
  });

  it("truncates finding summaries to 500 chars", () => {
    const longOutput = "x".repeat(1000);
    const results: StepResult[] = [
      { step_id: "s1", status: "succeeded", output: longOutput, started_at: "2025-01-01T00:00:00Z", attempts: 1 },
    ];

    const cp = buildCheckpoint("sess-1", "Task", plan, results, null, 1, {});
    expect(cp.findings[0]!.summary.length).toBe(500);
  });

  it("handles null plan gracefully", () => {
    const results: StepResult[] = [
      { step_id: "s1", status: "failed", error: { code: "ERR", message: "broken" }, started_at: "2025-01-01T00:00:00Z", attempts: 1 },
    ];

    const cp = buildCheckpoint("sess-1", "Task", null, results, null, 0, {});
    expect(cp.findings[0]!.step_title).toBe("s1");
    expect(cp.findings[0]!.tool_name).toBe("unknown");
    expect(cp.findings[0]!.status).toBe("failed");
    expect(cp.findings[0]!.summary).toBe("broken");
    expect(cp.next_steps).toEqual([]);
    expect(cp.last_plan_goal).toBe("");
  });

  it("serialization round-trip", () => {
    const results: StepResult[] = [
      { step_id: "s1", status: "succeeded", output: { data: 42 }, started_at: "2025-01-01T00:00:00Z", attempts: 1 },
    ];
    const cp = buildCheckpoint("sess-1", "Task", plan, results, null, 1, {});
    const json = JSON.stringify(cp);
    const parsed = JSON.parse(json);
    expect(parsed.checkpoint_id).toBe(cp.checkpoint_id);
    expect(parsed.findings).toEqual(cp.findings);
  });
});
