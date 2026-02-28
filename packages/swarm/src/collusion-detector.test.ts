import { describe, it, expect, beforeEach } from "vitest";
import { CollusionDetector } from "./collusion-detector.js";
import type { BidObject } from "./types.js";

function makeBid(overrides: Partial<BidObject> = {}): BidObject {
  return {
    bid_id: "bid-1",
    rfq_id: "rfq-1",
    bidder_node_id: "bidder-1",
    estimated_cost_usd: 1.0,
    estimated_duration_ms: 10000,
    estimated_tokens: 500,
    capabilities_offered: ["read-file", "shell-exec"],
    expiry: new Date(Date.now() + 60000).toISOString(),
    round: 1,
    timestamp: new Date().toISOString(),
    nonce: "nonce-1",
    ...overrides,
  };
}

describe("CollusionDetector", () => {
  let detector: CollusionDetector;

  beforeEach(() => {
    detector = new CollusionDetector();
  });

  // ─── No Collusion (Varied Bids) ─────────────────────────────────

  it("should return no reports for bids with varied costs", () => {
    detector.recordBid(makeBid({ bid_id: "b1", bidder_node_id: "peer-a", estimated_cost_usd: 0.5 }));
    detector.recordBid(makeBid({ bid_id: "b2", bidder_node_id: "peer-b", estimated_cost_usd: 1.5 }));
    detector.recordBid(makeBid({ bid_id: "b3", bidder_node_id: "peer-c", estimated_cost_usd: 3.0 }));
    const reports = detector.analyzeBids("rfq-1");
    expect(reports).toHaveLength(0);
  });

  it("should return no reports when only one bid exists", () => {
    detector.recordBid(makeBid({ bid_id: "b1", bidder_node_id: "peer-a", estimated_cost_usd: 1.0 }));
    const reports = detector.analyzeBids("rfq-1");
    expect(reports).toHaveLength(0);
  });

  it("should return no reports for unknown rfq_id", () => {
    const reports = detector.analyzeBids("rfq-nonexistent");
    expect(reports).toHaveLength(0);
  });

  // ─── Bid Coordination Detection ────────────────────────────────

  it("should detect bid coordination when costs are nearly identical", () => {
    detector.recordBid(makeBid({ bid_id: "b1", bidder_node_id: "peer-a", estimated_cost_usd: 1.00 }));
    detector.recordBid(makeBid({ bid_id: "b2", bidder_node_id: "peer-b", estimated_cost_usd: 1.00 }));
    detector.recordBid(makeBid({ bid_id: "b3", bidder_node_id: "peer-c", estimated_cost_usd: 1.00 }));
    const reports = detector.analyzeBids("rfq-1");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.indicator).toBe("bid_coordination");
    expect(reports[0]!.suspect_node_ids).toContain("peer-a");
    expect(reports[0]!.suspect_node_ids).toContain("peer-b");
    expect(reports[0]!.suspect_node_ids).toContain("peer-c");
    expect(reports[0]!.confidence).toBeGreaterThan(0.5);
  });

  it("should detect coordination with very low variance but non-identical costs", () => {
    // CV needs to be < 0.05 (default threshold)
    // Mean = 1.0, costs within 1% variance
    detector.recordBid(makeBid({ bid_id: "b1", bidder_node_id: "peer-a", estimated_cost_usd: 1.002 }));
    detector.recordBid(makeBid({ bid_id: "b2", bidder_node_id: "peer-b", estimated_cost_usd: 1.001 }));
    detector.recordBid(makeBid({ bid_id: "b3", bidder_node_id: "peer-c", estimated_cost_usd: 0.999 }));
    const reports = detector.analyzeBids("rfq-1");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.indicator).toBe("bid_coordination");
  });

  it("should escalate to quarantine when CV is very low (< threshold/2)", () => {
    detector.recordBid(makeBid({ bid_id: "b1", bidder_node_id: "peer-a", estimated_cost_usd: 1.0 }));
    detector.recordBid(makeBid({ bid_id: "b2", bidder_node_id: "peer-b", estimated_cost_usd: 1.0 }));
    detector.recordBid(makeBid({ bid_id: "b3", bidder_node_id: "peer-c", estimated_cost_usd: 1.0 }));
    const reports = detector.analyzeBids("rfq-1");
    expect(reports).toHaveLength(1);
    // CV = 0, which is < 0.05/2 = 0.025
    expect(reports[0]!.action).toBe("quarantine");
  });

  // ─── No Coordination With Only 2 Bids ──────────────────────────

  it("should not flag coordination with only 2 bids even if costs match", () => {
    detector.recordBid(makeBid({ bid_id: "b1", bidder_node_id: "peer-a", estimated_cost_usd: 1.0 }));
    detector.recordBid(makeBid({ bid_id: "b2", bidder_node_id: "peer-b", estimated_cost_usd: 1.0 }));
    const reports = detector.analyzeBids("rfq-1");
    expect(reports).toHaveLength(0);
  });

  // ─── Reciprocal Boosting Detection ──────────────────────────────

  it("should detect reciprocal boosting between two nodes", () => {
    // A delegates to B: 3 completions
    for (let i = 0; i < 3; i++) {
      detector.recordOutcome(`task-ab-${i}`, "node-A", "node-B", "completed");
    }
    // B delegates to A: 3 completions
    for (let i = 0; i < 3; i++) {
      detector.recordOutcome(`task-ba-${i}`, "node-B", "node-A", "completed");
    }
    const reports = detector.analyzeReputationPatterns();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.indicator).toBe("reciprocal_boosting");
    expect(reports[0]!.suspect_node_ids).toContain("node-A");
    expect(reports[0]!.suspect_node_ids).toContain("node-B");
    expect(reports[0]!.action).toBe("flag");
  });

  it("should detect boosting even with some failures if rate >= 90%", () => {
    // A -> B: 9 completed, 1 failed (90% rate)
    for (let i = 0; i < 9; i++) {
      detector.recordOutcome(`task-ab-${i}`, "node-A", "node-B", "completed");
    }
    detector.recordOutcome("task-ab-fail", "node-A", "node-B", "failed");

    // B -> A: 9 completed, 1 failed (90% rate)
    for (let i = 0; i < 9; i++) {
      detector.recordOutcome(`task-ba-${i}`, "node-B", "node-A", "completed");
    }
    detector.recordOutcome("task-ba-fail", "node-B", "node-A", "failed");

    const reports = detector.analyzeReputationPatterns();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.indicator).toBe("reciprocal_boosting");
  });

  // ─── No Boosting (One Direction Only) ───────────────────────────

  it("should not flag when delegation is only in one direction", () => {
    // A delegates to B many times, but B never delegates to A
    for (let i = 0; i < 5; i++) {
      detector.recordOutcome(`task-${i}`, "node-A", "node-B", "completed");
    }
    const reports = detector.analyzeReputationPatterns();
    expect(reports).toHaveLength(0);
  });

  it("should not flag when reciprocal success rate is below 90%", () => {
    // A -> B: 3 completed, 1 failed (75% rate)
    for (let i = 0; i < 3; i++) {
      detector.recordOutcome(`task-ab-${i}`, "node-A", "node-B", "completed");
    }
    detector.recordOutcome("task-ab-fail", "node-A", "node-B", "failed");

    // B -> A: 3 completed, 1 failed (75% rate)
    for (let i = 0; i < 3; i++) {
      detector.recordOutcome(`task-ba-${i}`, "node-B", "node-A", "completed");
    }
    detector.recordOutcome("task-ba-fail", "node-B", "node-A", "failed");

    const reports = detector.analyzeReputationPatterns();
    expect(reports).toHaveLength(0);
  });

  it("should not flag when pair has fewer than 3 interactions each way", () => {
    // A -> B: 2 completions (below 3 threshold)
    detector.recordOutcome("task-ab-1", "node-A", "node-B", "completed");
    detector.recordOutcome("task-ab-2", "node-A", "node-B", "completed");

    // B -> A: 2 completions (below 3 threshold)
    detector.recordOutcome("task-ba-1", "node-B", "node-A", "completed");
    detector.recordOutcome("task-ba-2", "node-B", "node-A", "completed");

    // Need enough total outcomes to pass min_tasks_for_analysis (5)
    detector.recordOutcome("task-extra", "node-C", "node-D", "completed");

    const reports = detector.analyzeReputationPatterns();
    expect(reports).toHaveLength(0);
  });

  // ─── min_tasks_for_analysis Threshold ───────────────────────────

  it("should not analyze reputation when below min_tasks_for_analysis", () => {
    // Only 4 outcomes (default min is 5)
    for (let i = 0; i < 2; i++) {
      detector.recordOutcome(`task-ab-${i}`, "node-A", "node-B", "completed");
      detector.recordOutcome(`task-ba-${i}`, "node-B", "node-A", "completed");
    }
    const reports = detector.analyzeReputationPatterns();
    expect(reports).toHaveLength(0);
  });

  // ─── getReportsForNode ──────────────────────────────────────────

  it("should return only reports involving the specified node", () => {
    // Create bid coordination report involving peer-a, peer-b, peer-c
    detector.recordBid(makeBid({ bid_id: "b1", rfq_id: "rfq-1", bidder_node_id: "peer-a", estimated_cost_usd: 1.0 }));
    detector.recordBid(makeBid({ bid_id: "b2", rfq_id: "rfq-1", bidder_node_id: "peer-b", estimated_cost_usd: 1.0 }));
    detector.recordBid(makeBid({ bid_id: "b3", rfq_id: "rfq-1", bidder_node_id: "peer-c", estimated_cost_usd: 1.0 }));
    detector.analyzeBids("rfq-1");

    expect(detector.getReportsForNode("peer-a")).toHaveLength(1);
    expect(detector.getReportsForNode("peer-b")).toHaveLength(1);
    expect(detector.getReportsForNode("peer-unknown")).toHaveLength(0);
  });

  // ─── getReports ────────────────────────────────────────────────

  it("should accumulate reports from both bid and reputation analysis", () => {
    // Bid coordination
    detector.recordBid(makeBid({ bid_id: "b1", rfq_id: "rfq-1", bidder_node_id: "peer-a", estimated_cost_usd: 1.0 }));
    detector.recordBid(makeBid({ bid_id: "b2", rfq_id: "rfq-1", bidder_node_id: "peer-b", estimated_cost_usd: 1.0 }));
    detector.recordBid(makeBid({ bid_id: "b3", rfq_id: "rfq-1", bidder_node_id: "peer-c", estimated_cost_usd: 1.0 }));
    detector.analyzeBids("rfq-1");

    // Reciprocal boosting
    for (let i = 0; i < 3; i++) {
      detector.recordOutcome(`task-xy-${i}`, "node-X", "node-Y", "completed");
      detector.recordOutcome(`task-yx-${i}`, "node-Y", "node-X", "completed");
    }
    detector.analyzeReputationPatterns();

    const allReports = detector.getReports();
    expect(allReports).toHaveLength(2);
    expect(allReports.map(r => r.indicator)).toContain("bid_coordination");
    expect(allReports.map(r => r.indicator)).toContain("reciprocal_boosting");
  });

  // ─── Custom Config ─────────────────────────────────────────────

  it("should respect custom bid_variance_threshold", () => {
    const d = new CollusionDetector({ bid_variance_threshold: 0.2 });
    // Costs with CV ~0.15 (below custom 0.2 threshold)
    d.recordBid(makeBid({ bid_id: "b1", bidder_node_id: "peer-a", estimated_cost_usd: 1.0 }));
    d.recordBid(makeBid({ bid_id: "b2", bidder_node_id: "peer-b", estimated_cost_usd: 1.1 }));
    d.recordBid(makeBid({ bid_id: "b3", bidder_node_id: "peer-c", estimated_cost_usd: 0.9 }));
    const reports = d.analyzeBids("rfq-1");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.indicator).toBe("bid_coordination");
  });

  it("should respect custom min_tasks_for_analysis", () => {
    const d = new CollusionDetector({ min_tasks_for_analysis: 2 });
    // Only 2 total outcomes, but custom threshold is 2
    d.recordOutcome("t1", "A", "B", "completed");
    d.recordOutcome("t2", "B", "A", "completed");
    // Still won't trigger because each direction has < 3 interactions
    // but at least the analysis runs (doesn't short-circuit)
    const reports = d.analyzeReputationPatterns();
    expect(reports).toHaveLength(0);
  });
});
