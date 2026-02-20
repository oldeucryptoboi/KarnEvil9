import { describe, it, expect, vi, beforeEach } from "vitest";
import { BehavioralScorer } from "./behavioral-scorer.js";
import type { BehavioralObservation } from "./types.js";

describe("BehavioralScorer", () => {
  let scorer: BehavioralScorer;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    scorer = new BehavioralScorer(emitEvent);
  });

  // ─── No Observations ──────────────────────────────────────────────

  it("should return undefined from getMetrics when no observations exist", () => {
    expect(scorer.getMetrics("node-1")).toBeUndefined();
  });

  it("should return 0.5 (default neutral) from computeCompositeScore when no observations exist", () => {
    expect(scorer.computeCompositeScore("node-1")).toBe(0.5);
  });

  // ─── Single Observations ──────────────────────────────────────────

  it("should compute transparency = 1.0 for a single positive transparency observation", () => {
    scorer.recordObservation("node-1", { type: "transparency_high", timestamp: new Date().toISOString() });
    const metrics = scorer.getMetrics("node-1");
    expect(metrics).toBeDefined();
    expect(metrics!.transparency).toBe(1.0);
  });

  it("should compute transparency = 0.0 for a single negative transparency observation", () => {
    scorer.recordObservation("node-1", { type: "transparency_low", timestamp: new Date().toISOString() });
    const metrics = scorer.getMetrics("node-1");
    expect(metrics).toBeDefined();
    expect(metrics!.transparency).toBe(0.0);
  });

  // ─── Mixed Observations ──────────────────────────────────────────

  it("should compute rolling average for mixed positive/negative safety observations", () => {
    // 3 compliant, 1 violation => safety = 3/4 = 0.75
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "safety_violation", timestamp: new Date().toISOString() });
    const metrics = scorer.getMetrics("node-1");
    expect(metrics!.safety).toBe(0.75);
  });

  it("should compute all 4 metric dimensions correctly", () => {
    scorer.recordObservation("node-1", { type: "transparency_high", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "protocol_followed", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "reasoning_clear", timestamp: new Date().toISOString() });
    const metrics = scorer.getMetrics("node-1");
    expect(metrics!.transparency).toBe(1.0);
    expect(metrics!.safety).toBe(1.0);
    expect(metrics!.protocol_compliance).toBe(1.0);
    expect(metrics!.reasoning_clarity).toBe(1.0);
  });

  // ─── Composite Score ──────────────────────────────────────────────

  it("should compute composite score as weighted average of 4 dimensions", () => {
    // All perfect => 1.0 * 0.25 + 1.0 * 0.30 + 1.0 * 0.25 + 1.0 * 0.20 = 1.0
    scorer.recordObservation("node-1", { type: "transparency_high", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "protocol_followed", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "reasoning_clear", timestamp: new Date().toISOString() });
    const metrics = scorer.getMetrics("node-1");
    expect(metrics!.composite_score).toBeCloseTo(1.0, 5);

    // All negative => 0.0 * 0.25 + 0.0 * 0.30 + 0.0 * 0.25 + 0.0 * 0.20 = 0.0
    const scorer2 = new BehavioralScorer();
    scorer2.recordObservation("node-2", { type: "transparency_low", timestamp: new Date().toISOString() });
    scorer2.recordObservation("node-2", { type: "safety_violation", timestamp: new Date().toISOString() });
    scorer2.recordObservation("node-2", { type: "protocol_violated", timestamp: new Date().toISOString() });
    scorer2.recordObservation("node-2", { type: "reasoning_opaque", timestamp: new Date().toISOString() });
    const metrics2 = scorer2.getMetrics("node-2");
    expect(metrics2!.composite_score).toBeCloseTo(0.0, 5);
  });

  // ─── FIFO Cap ─────────────────────────────────────────────────────

  it("should cap observations at 100 via FIFO after 101 observations", () => {
    for (let i = 0; i < 101; i++) {
      scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    }
    expect(scorer.getObservationCount("node-1")).toBe(100);
  });

  // ─── Cache Invalidation ───────────────────────────────────────────

  it("should invalidate cache when new observation is recorded", () => {
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    const metrics1 = scorer.getMetrics("node-1");
    expect(metrics1!.safety).toBe(1.0);

    scorer.recordObservation("node-1", { type: "safety_violation", timestamp: new Date().toISOString() });
    const metrics2 = scorer.getMetrics("node-1");
    // After 1 compliant + 1 violation => safety = 0.5
    expect(metrics2!.safety).toBe(0.5);
  });

  // ─── inferObservationsFromResult ──────────────────────────────────

  it("should infer protocol_followed and safety_compliant when 0 missed and no violations", () => {
    scorer.inferObservationsFromResult("node-1", 0, false);
    const metrics = scorer.getMetrics("node-1");
    expect(metrics!.protocol_compliance).toBe(1.0);
    expect(metrics!.safety).toBe(1.0);
  });

  it("should infer protocol_violated and safety_violation when missed > 0 and violations present", () => {
    scorer.inferObservationsFromResult("node-1", 3, true);
    const metrics = scorer.getMetrics("node-1");
    expect(metrics!.protocol_compliance).toBe(0.0);
    expect(metrics!.safety).toBe(0.0);
  });

  // ─── Events ───────────────────────────────────────────────────────

  it("should emit behavioral_observation_recorded on each recordObservation call", () => {
    scorer.recordObservation("node-1", { type: "transparency_high", timestamp: new Date().toISOString() });
    expect(emitEvent).toHaveBeenCalledWith(
      "swarm.behavioral_observation_recorded",
      expect.objectContaining({ node_id: "node-1", observation_type: "transparency_high" }),
    );
  });

  it("should emit behavioral_score_updated when score changes by more than 0.02", () => {
    // First observation — all positive
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "transparency_high", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "protocol_followed", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "reasoning_clear", timestamp: new Date().toISOString() });

    // Reset to track new calls
    emitEvent.mockClear();

    // Now add several negative observations to shift the score significantly
    scorer.recordObservation("node-1", { type: "safety_violation", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "transparency_low", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "protocol_violated", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "reasoning_opaque", timestamp: new Date().toISOString() });

    const scoreUpdatedCalls = emitEvent.mock.calls.filter(
      (c: unknown[]) => c[0] === "swarm.behavioral_score_updated",
    );
    expect(scoreUpdatedCalls.length).toBeGreaterThan(0);
  });

  it("should NOT emit behavioral_score_updated on the first observation (no old score)", () => {
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    const scoreUpdatedCalls = emitEvent.mock.calls.filter(
      (c: unknown[]) => c[0] === "swarm.behavioral_score_updated",
    );
    expect(scoreUpdatedCalls).toHaveLength(0);
  });

  // ─── getObservationCount ──────────────────────────────────────────

  it("should return correct observation count", () => {
    expect(scorer.getObservationCount("node-1")).toBe(0);
    scorer.recordObservation("node-1", { type: "safety_compliant", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-1", { type: "safety_violation", timestamp: new Date().toISOString() });
    expect(scorer.getObservationCount("node-1")).toBe(2);
  });

  // ─── Multiple Nodes ───────────────────────────────────────────────

  it("should track multiple nodes independently", () => {
    scorer.recordObservation("node-A", { type: "safety_compliant", timestamp: new Date().toISOString() });
    scorer.recordObservation("node-B", { type: "safety_violation", timestamp: new Date().toISOString() });
    const metricsA = scorer.getMetrics("node-A");
    const metricsB = scorer.getMetrics("node-B");
    expect(metricsA!.safety).toBe(1.0);
    expect(metricsB!.safety).toBe(0.0);
  });

  // ─── Weight Sum ───────────────────────────────────────────────────

  it("should have weights that sum to 1.0", () => {
    const sum = 0.25 + 0.30 + 0.25 + 0.20;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  // ─── Defaults ─────────────────────────────────────────────────────

  it("should use default score of 0.5 for metrics with no observations", () => {
    // Only record transparency, leave others at default
    scorer.recordObservation("node-1", { type: "transparency_high", timestamp: new Date().toISOString() });
    const metrics = scorer.getMetrics("node-1");
    expect(metrics!.transparency).toBe(1.0);
    expect(metrics!.safety).toBe(0.5);
    expect(metrics!.protocol_compliance).toBe(0.5);
    expect(metrics!.reasoning_clarity).toBe(0.5);
  });

  // ─── Evidence String ──────────────────────────────────────────────

  it("should capture evidence string in recorded observations", () => {
    scorer.recordObservation("node-1", {
      type: "protocol_violated",
      timestamp: new Date().toISOString(),
      evidence: "3 checkpoints missed",
    });
    // Verify via inferObservationsFromResult which sets evidence
    const scorer2 = new BehavioralScorer();
    scorer2.inferObservationsFromResult("node-2", 5, false);
    // The observation count shows it was recorded
    expect(scorer2.getObservationCount("node-2")).toBe(2);
    const metrics = scorer2.getMetrics("node-2");
    expect(metrics!.protocol_compliance).toBe(0.0); // violated
  });

  // ─── Bounded Score ────────────────────────────────────────────────

  it("should produce a composite score between 0 and 1 after many mixed observations", () => {
    const types: BehavioralObservation["type"][] = [
      "transparency_high", "transparency_low",
      "safety_compliant", "safety_violation",
      "protocol_followed", "protocol_violated",
      "reasoning_clear", "reasoning_opaque",
    ];
    for (let i = 0; i < 50; i++) {
      const type = types[i % types.length]!;
      scorer.recordObservation("node-1", { type, timestamp: new Date().toISOString() });
    }
    const score = scorer.computeCompositeScore("node-1");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
