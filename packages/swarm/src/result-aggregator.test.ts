import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ResultAggregator } from "./result-aggregator.js";
import type { SwarmTaskResult } from "./types.js";

function makeResult(overrides: Partial<SwarmTaskResult> = {}): SwarmTaskResult {
  return {
    task_id: overrides.task_id ?? "task-1",
    peer_node_id: overrides.peer_node_id ?? "peer-1",
    peer_session_id: overrides.peer_session_id ?? "session-1",
    status: overrides.status ?? "completed",
    findings: overrides.findings ?? [
      { step_title: "test step", tool_name: "read-file", status: "succeeded", summary: "done" },
    ],
    tokens_used: overrides.tokens_used ?? 100,
    cost_usd: overrides.cost_usd ?? 0.01,
    duration_ms: overrides.duration_ms ?? 5000,
  };
}

describe("ResultAggregator", () => {
  let aggregator: ResultAggregator;

  beforeEach(() => {
    aggregator = new ResultAggregator();
  });

  afterEach(() => {
    // Create a fresh aggregator each test — no shared cleanup needed
  });

  it("should resolve when all expected results arrive", async () => {
    const promise = aggregator.createAggregation("corr-1", 2, 5000);

    aggregator.addResult("corr-1", makeResult({ peer_node_id: "peer-1" }));
    const completed = aggregator.addResult("corr-1", makeResult({ peer_node_id: "peer-2" }));

    expect(completed).toBe(true);
    const findings = await promise;
    expect(findings).toHaveLength(2);
    expect(findings[0]!.step_title).toContain("[peer-1]");
    expect(findings[1]!.step_title).toContain("[peer-2]");
  });

  it("should return false when adding result for unknown correlation", () => {
    expect(aggregator.addResult("unknown", makeResult())).toBe(false);
  });

  it("should track pending count", async () => {
    expect(aggregator.pendingCount).toBe(0);

    const p1 = aggregator.createAggregation("corr-1", 1, 5000);
    expect(aggregator.pendingCount).toBe(1);

    aggregator.addResult("corr-1", makeResult());
    await p1;
    expect(aggregator.pendingCount).toBe(0);
  });

  it("should get aggregation status", () => {
    aggregator.createAggregation("corr-1", 3, 5000);
    aggregator.addResult("corr-1", makeResult());

    const status = aggregator.getStatus("corr-1");
    expect(status).toBeTruthy();
    expect(status!.received).toBe(1);
    expect(status!.expected).toBe(3);
    expect(status!.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("should return undefined status for unknown correlation", () => {
    expect(aggregator.getStatus("unknown")).toBeUndefined();
  });

  it("should timeout with partial results", async () => {
    const promise = aggregator.createAggregation("corr-1", 3, 50);

    aggregator.addResult("corr-1", makeResult({ peer_node_id: "peer-1" }));

    // Should resolve with partial findings on timeout
    const findings = await promise;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.step_title).toContain("[peer-1]");
  });

  it("should reject timeout with no results", async () => {
    const promise = aggregator.createAggregation("corr-1", 2, 50);

    await expect(promise).rejects.toThrow("timed out with no results");
  });

  it("should cancel all pending aggregations", async () => {
    const promise = aggregator.createAggregation("corr-1", 2, 5000);
    expect(aggregator.pendingCount).toBe(1);

    aggregator.cancelAll();
    expect(aggregator.pendingCount).toBe(0);

    await expect(promise).rejects.toThrow("cancelled");
  });

  it("should prefix findings with peer node id", async () => {
    const promise = aggregator.createAggregation("corr-1", 1, 5000);

    aggregator.addResult("corr-1", makeResult({
      peer_node_id: "my-peer",
      findings: [
        { step_title: "Read config", tool_name: "read-file", status: "succeeded", summary: "read ok" },
        { step_title: "Run tests", tool_name: "shell-exec", status: "failed", summary: "test failed" },
      ],
    }));

    const findings = await promise;
    expect(findings).toHaveLength(2);
    expect(findings[0]!.step_title).toBe("[my-peer] Read config");
    expect(findings[1]!.step_title).toBe("[my-peer] Run tests");
  });

  it("should handle single-result aggregation", async () => {
    const promise = aggregator.createAggregation("corr-1", 1, 5000);
    const completed = aggregator.addResult("corr-1", makeResult());
    expect(completed).toBe(true);
    const findings = await promise;
    expect(findings).toHaveLength(1);
  });

  it("should reject when max pending aggregations (1000) exceeded", async () => {
    // Create 1000 pending aggregations (use a long timeout so they stay pending)
    // Attach .catch() to each to prevent unhandled rejection on cancelAll()
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) {
      const p = aggregator.createAggregation(`corr-${i}`, 2, 600_000);
      p.catch(() => {}); // swallow cancellation errors
      promises.push(p);
    }
    expect(aggregator.pendingCount).toBe(1000);

    // The 1001st should be rejected
    await expect(aggregator.createAggregation("corr-overflow", 1, 5000)).rejects.toThrow(
      "Max pending aggregations",
    );
    expect(aggregator.pendingCount).toBe(1000);

    // Cleanup
    aggregator.cancelAll();
  });

  it("should not complete before expected count", () => {
    aggregator.createAggregation("corr-1", 3, 5000);
    const first = aggregator.addResult("corr-1", makeResult({ peer_node_id: "p1" }));
    const second = aggregator.addResult("corr-1", makeResult({ peer_node_id: "p2" }));
    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(aggregator.pendingCount).toBe(1);
  });
});
