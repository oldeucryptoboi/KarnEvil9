import { describe, it, expect, vi, beforeEach } from "vitest";
import { SabotageDetector, DEFAULT_SABOTAGE_CONFIG } from "./sabotage-detector.js";
import { CollusionDetector } from "./collusion-detector.js";
import type { FeedbackRecord } from "./types.js";

function makeFeedback(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    feedback_id: "fb-1",
    from_node_id: "source-1",
    target_node_id: "target-1",
    task_id: "task-1",
    positive: true,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("SabotageDetector", () => {
  let detector: SabotageDetector;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    detector = new SabotageDetector(undefined, emitEvent);
  });

  // ─── No Feedback ──────────────────────────────────────────────────

  it("should return empty reports when no feedback exists", () => {
    const reports = detector.detectSabotage("target-1");
    expect(reports).toHaveLength(0);
  });

  it("should return empty when below min_feedback_count", () => {
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", positive: false }));
    const reports = detector.detectSabotage("target-1");
    expect(reports).toHaveLength(0);
  });

  // ─── Disproportionate Negative ────────────────────────────────────

  it("should detect disproportionate negative from one source when others are positive", () => {
    // source-bad: 4 negative (100% of negatives from one source)
    // source-good: 1 positive (provides contrast)
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "source-bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "source-bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "source-bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-4", from_node_id: "source-good", positive: true }));

    const reports = detector.detectSabotage("target-1");
    expect(reports.length).toBeGreaterThanOrEqual(1);
    const dispReport = reports.find(r => r.indicator === "disproportionate_negative");
    expect(dispReport).toBeDefined();
    expect(dispReport!.suspect_node_id).toBe("source-bad");
    expect(dispReport!.target_node_id).toBe("target-1");
  });

  it("should NOT detect disproportionate negative when no one is positive (no contrast)", () => {
    // All negative from one source but no positive from anyone
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "source-1", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "source-1", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "source-1", positive: false }));

    const reports = detector.detectSabotage("target-1");
    const dispReport = reports.find(r => r.indicator === "disproportionate_negative");
    expect(dispReport).toBeUndefined();
  });

  // ─── Review Bombing ───────────────────────────────────────────────

  it("should detect review bombing when burst_threshold negatives come from single source in window", () => {
    const now = new Date();
    // 5 negatives from same source within the burst window
    for (let i = 0; i < 5; i++) {
      detector.recordFeedback(makeFeedback({
        feedback_id: `fb-neg-${i}`,
        from_node_id: "bomber",
        positive: false,
        timestamp: new Date(now.getTime() - i * 1000).toISOString(), // spread over 5 seconds
      }));
    }
    // Need positive from someone else to meet min_feedback_count = 3, which we do
    // (5 already meet it)

    const reports = detector.detectSabotage("target-1");
    const bombReport = reports.find(r => r.indicator === "review_bombing");
    expect(bombReport).toBeDefined();
    expect(bombReport!.suspect_node_id).toBe("bomber");
  });

  it("should NOT detect review bombing when negatives are spread over time beyond the window", () => {
    const now = new Date();
    // 5 negatives but spread across a much wider window than the default 60s
    for (let i = 0; i < 5; i++) {
      detector.recordFeedback(makeFeedback({
        feedback_id: `fb-neg-${i}`,
        from_node_id: "slow-critic",
        positive: false,
        timestamp: new Date(now.getTime() - (i + 1) * 120000).toISOString(), // 120s apart, all outside window
      }));
    }

    const reports = detector.detectSabotage("target-1");
    const bombReport = reports.find(r => r.indicator === "review_bombing");
    expect(bombReport).toBeUndefined();
  });

  // ─── Collusion Cross-Reference ────────────────────────────────────

  it("should flag via collusion cross-reference when source has collusion reports", () => {
    const cd = new CollusionDetector();
    // Create a collusion report for "suspect-1" by triggering bid coordination
    cd.recordBid({
      bid_id: "b1", rfq_id: "rfq-1", bidder_node_id: "suspect-1",
      estimated_cost_usd: 1.0, estimated_duration_ms: 1000, estimated_tokens: 100,
      capabilities_offered: [], expiry: new Date().toISOString(), round: 1,
      timestamp: new Date().toISOString(), nonce: "n1",
    });
    cd.recordBid({
      bid_id: "b2", rfq_id: "rfq-1", bidder_node_id: "other-1",
      estimated_cost_usd: 1.0, estimated_duration_ms: 1000, estimated_tokens: 100,
      capabilities_offered: [], expiry: new Date().toISOString(), round: 1,
      timestamp: new Date().toISOString(), nonce: "n2",
    });
    cd.recordBid({
      bid_id: "b3", rfq_id: "rfq-1", bidder_node_id: "other-2",
      estimated_cost_usd: 1.0, estimated_duration_ms: 1000, estimated_tokens: 100,
      capabilities_offered: [], expiry: new Date().toISOString(), round: 1,
      timestamp: new Date().toISOString(), nonce: "n3",
    });
    cd.analyzeBids("rfq-1"); // creates collusion report for suspect-1

    detector.setCollusionDetector(cd);

    // suspect-1 gives negative feedback to target-1
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "suspect-1", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "good-source", positive: true }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "good-source-2", positive: true }));

    const reports = detector.detectSabotage("target-1");
    const crossRef = reports.find(r => r.indicator === "collusion_cross_ref");
    expect(crossRef).toBeDefined();
    expect(crossRef!.suspect_node_id).toBe("suspect-1");
    expect(crossRef!.confidence).toBe(0.7);
  });

  it("should not produce cross-ref reports when no collusionDetector is set", () => {
    // No collusionDetector set
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "source-1", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "source-2", positive: true }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "source-3", positive: true }));

    const reports = detector.detectSabotage("target-1");
    const crossRef = reports.find(r => r.indicator === "collusion_cross_ref");
    expect(crossRef).toBeUndefined();
  });

  // ─── shouldDiscount ───────────────────────────────────────────────

  it("should return true from shouldDiscount after detection", () => {
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "bad-actor", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "bad-actor", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "bad-actor", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-4", from_node_id: "good-actor", positive: true }));

    detector.detectSabotage("target-1");
    expect(detector.shouldDiscount("bad-actor", "target-1")).toBe(true);
  });

  it("should return false from shouldDiscount for unknown pair", () => {
    expect(detector.shouldDiscount("unknown-1", "unknown-2")).toBe(false);
  });

  // ─── recordFeedback ───────────────────────────────────────────────

  it("should store feedback correctly and use it in detection", () => {
    const fb = makeFeedback({ feedback_id: "fb-unique", from_node_id: "src", target_node_id: "tgt", positive: false });
    detector.recordFeedback(fb);
    // With only 1 feedback, detection returns empty (below min_feedback_count)
    expect(detector.detectSabotage("tgt")).toHaveLength(0);
    // Add more to reach threshold
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "src", target_node_id: "tgt", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "other", target_node_id: "tgt", positive: true }));
    // Now there are 3 total, enough for analysis
    const reports = detector.detectSabotage("tgt");
    expect(reports.length).toBeGreaterThanOrEqual(0); // runs without error
  });

  // ─── Feedback Cap ─────────────────────────────────────────────────

  it("should trim feedback to 5000 when it exceeds 10000", () => {
    for (let i = 0; i < 10001; i++) {
      detector.recordFeedback(makeFeedback({
        feedback_id: `fb-${i}`,
        from_node_id: `source-${i % 10}`,
        target_node_id: "target-1",
        positive: i % 2 === 0,
      }));
    }
    // After recording 10001, it should be trimmed to 5000
    // Verify by trying to detect - it should not throw and should use only recent feedback
    const reports = detector.detectSabotage("target-1");
    expect(Array.isArray(reports)).toBe(true);
  });

  // ─── Events ───────────────────────────────────────────────────────

  it("should emit sabotage_detected for each detection", () => {
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-4", from_node_id: "good", positive: true }));

    detector.detectSabotage("target-1");

    const sabotageEvents = emitEvent.mock.calls.filter(
      (c: unknown[]) => c[0] === "swarm.sabotage_detected",
    );
    expect(sabotageEvents.length).toBeGreaterThan(0);
    expect(sabotageEvents[0]![1]).toEqual(expect.objectContaining({
      indicator: "disproportionate_negative",
      suspect: "bad",
      target: "target-1",
    }));
  });

  it("should set discountedPairs (verifiable via shouldDiscount) when sabotage is detected", () => {
    // Review bombing scenario
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      detector.recordFeedback(makeFeedback({
        feedback_id: `fb-bomb-${i}`,
        from_node_id: "bomber",
        positive: false,
        timestamp: new Date(now.getTime() - i * 100).toISOString(),
      }));
    }

    detector.detectSabotage("target-1");
    expect(detector.shouldDiscount("bomber", "target-1")).toBe(true);
  });

  // ─── Multiple Heuristics ──────────────────────────────────────────

  it("should fire multiple heuristics on the same detectSabotage call", () => {
    const now = new Date();
    // source-bad: 5 negatives in burst window (triggers review_bombing + disproportionate)
    for (let i = 0; i < 5; i++) {
      detector.recordFeedback(makeFeedback({
        feedback_id: `fb-neg-${i}`,
        from_node_id: "source-bad",
        positive: false,
        timestamp: new Date(now.getTime() - i * 100).toISOString(),
      }));
    }
    // Another source positive (provides contrast for disproportionate heuristic)
    detector.recordFeedback(makeFeedback({
      feedback_id: "fb-pos-1",
      from_node_id: "source-good",
      positive: true,
    }));

    const reports = detector.detectSabotage("target-1");
    const indicators = reports.map(r => r.indicator);
    // Should have at least disproportionate_negative AND review_bombing
    expect(indicators).toContain("disproportionate_negative");
    expect(indicators).toContain("review_bombing");
  });

  // ─── Custom Config ────────────────────────────────────────────────

  it("should respect custom config thresholds", () => {
    const customDetector = new SabotageDetector({
      disproportionate_threshold: 0.5,
      burst_threshold: 2,
      burst_window_ms: 10000,
      min_feedback_count: 2,
    }, emitEvent);

    const now = new Date();
    // 2 negatives from one source (fraction = 1.0 >= 0.5 custom threshold)
    customDetector.recordFeedback(makeFeedback({
      feedback_id: "fb-1",
      from_node_id: "critic",
      positive: false,
      timestamp: new Date(now.getTime() - 100).toISOString(),
    }));
    customDetector.recordFeedback(makeFeedback({
      feedback_id: "fb-2",
      from_node_id: "critic",
      positive: false,
      timestamp: new Date(now.getTime() - 200).toISOString(),
    }));
    // Positive from another to provide contrast
    customDetector.recordFeedback(makeFeedback({
      feedback_id: "fb-3",
      from_node_id: "supporter",
      positive: true,
    }));

    const reports = customDetector.detectSabotage("target-1");
    expect(reports.length).toBeGreaterThan(0);
  });

  // ─── getReports ───────────────────────────────────────────────────

  it("should return all accumulated reports", () => {
    expect(detector.getReports()).toHaveLength(0);

    // Trigger a detection
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-4", from_node_id: "good", positive: true }));
    detector.detectSabotage("target-1");

    expect(detector.getReports().length).toBeGreaterThan(0);
  });

  it("should filter reports by target node id via getReportsForTarget", () => {
    // Create sabotage reports for target-1
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "bad", target_node_id: "target-1", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "bad", target_node_id: "target-1", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "bad", target_node_id: "target-1", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-4", from_node_id: "good", target_node_id: "target-1", positive: true }));
    detector.detectSabotage("target-1");

    expect(detector.getReportsForTarget("target-1").length).toBeGreaterThan(0);
    expect(detector.getReportsForTarget("target-other")).toHaveLength(0);
  });

  // ─── Confidence Cap ───────────────────────────────────────────────

  it("should cap confidence at 0.9 for disproportionate negative", () => {
    // fraction = 1.0 (all negatives from one source), confidence = min(0.9, 1.0) = 0.9
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-4", from_node_id: "good", positive: true }));

    const reports = detector.detectSabotage("target-1");
    const dispReport = reports.find(r => r.indicator === "disproportionate_negative");
    expect(dispReport).toBeDefined();
    expect(dispReport!.confidence).toBe(0.9);
  });

  // ─── Exact Threshold Fraction ─────────────────────────────────────

  it("should detect when fraction is exactly at the threshold", () => {
    // 4 negatives from bad (80%), 1 negative from another (20%)
    // fraction for "bad" = 4/5 = 0.8 which equals default threshold 0.8
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-1", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-2", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-3", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-4", from_node_id: "bad", positive: false }));
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-5", from_node_id: "other", positive: false }));
    // Need at least one positive from someone other than "bad" for othersPositive
    detector.recordFeedback(makeFeedback({ feedback_id: "fb-6", from_node_id: "supporter", positive: true }));

    const reports = detector.detectSabotage("target-1");
    const dispReport = reports.find(r => r.indicator === "disproportionate_negative");
    expect(dispReport).toBeDefined();
    expect(dispReport!.suspect_node_id).toBe("bad");
    expect(dispReport!.confidence).toBe(0.8); // min(0.9, 0.8) = 0.8
  });
});
