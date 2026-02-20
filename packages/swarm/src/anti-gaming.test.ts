import { describe, it, expect, beforeEach } from "vitest";
import { AntiGamingDetector, DEFAULT_ANTI_GAMING_CONFIG } from "./anti-gaming.js";

describe("AntiGamingDetector", () => {
  let detector: AntiGamingDetector;

  beforeEach(() => {
    detector = new AntiGamingDetector();
  });

  // ─── Constructor Defaults ───────────────────────────────────────────

  it("should use default config values", () => {
    expect(DEFAULT_ANTI_GAMING_CONFIG).toEqual({
      cherry_pick_threshold: 0.8,
      rejection_rate_threshold: 0.5,
      min_tasks_for_evaluation: 10,
      diversity_weight: 0.15,
      complexity_weight_multiplier: { low: 0.5, medium: 1.0, high: 1.5 },
    });
  });

  // ─── recordTaskCompletion / recordTaskRejection ─────────────────────

  it("should track task completions by complexity", () => {
    detector.recordTaskCompletion("peer-1", "low", "t-1");
    detector.recordTaskCompletion("peer-1", "medium", "t-2");
    detector.recordTaskCompletion("peer-1", "high", "t-3");

    const profile = detector.evaluatePeer("peer-1");
    expect(profile.tasks_by_complexity).toEqual({ low: 1, medium: 1, high: 1 });
  });

  it("should track task rejections by complexity", () => {
    detector.recordTaskCompletion("peer-1", "low"); // need at least one completion for getProfile
    detector.recordTaskRejection("peer-1", "high", "t-r1");
    detector.recordTaskRejection("peer-1", "high", "t-r2");
    detector.recordTaskRejection("peer-1", "medium", "t-r3");

    const profile = detector.evaluatePeer("peer-1");
    expect(profile.tasks_rejected_by_complexity).toEqual({ low: 0, medium: 1, high: 2 });
  });

  // ─── evaluatePeer ──────────────────────────────────────────────────

  it("should return profile with zero counts for peer with no completions", () => {
    const profile = detector.evaluatePeer("unknown-peer");
    expect(profile.node_id).toBe("unknown-peer");
    expect(profile.tasks_by_complexity).toEqual({ low: 0, medium: 0, high: 0 });
    expect(profile.tasks_rejected_by_complexity).toEqual({ low: 0, medium: 0, high: 0 });
    expect(profile.gaming_flags).toEqual([]);
  });

  it("should not flag gaming when below min_tasks_for_evaluation threshold", () => {
    // Record 5 all-low completions (below default min of 10)
    for (let i = 0; i < 5; i++) {
      detector.recordTaskCompletion("peer-1", "low");
    }

    const profile = detector.evaluatePeer("peer-1");
    expect(profile.gaming_flags).toHaveLength(0);
    expect(profile.tasks_by_complexity.low).toBe(5);
  });

  it("should not flag gaming for uniform distribution above threshold", () => {
    // 4 low + 3 medium + 3 high = 10 tasks, all completions
    for (let i = 0; i < 4; i++) detector.recordTaskCompletion("peer-1", "low");
    for (let i = 0; i < 3; i++) detector.recordTaskCompletion("peer-1", "medium");
    for (let i = 0; i < 3; i++) detector.recordTaskCompletion("peer-1", "high");

    const profile = detector.evaluatePeer("peer-1");
    expect(profile.gaming_flags).toHaveLength(0);
  });

  it("should flag cherry_picking with medium severity when >80% low tasks", () => {
    // 9 low + 1 medium = 10 tasks, 90% low (>80%, <95%)
    for (let i = 0; i < 9; i++) detector.recordTaskCompletion("peer-1", "low");
    detector.recordTaskCompletion("peer-1", "medium");

    const profile = detector.evaluatePeer("peer-1");
    expect(profile.gaming_flags).toHaveLength(1);
    expect(profile.gaming_flags[0]!.type).toBe("cherry_picking");
    expect(profile.gaming_flags[0]!.severity).toBe("medium");
    expect(profile.gaming_flags[0]!.evidence).toContain("90%");
  });

  it("should flag cherry_picking with high severity when >=95% low tasks", () => {
    // 19 low + 1 medium = 20 tasks, 95% low
    for (let i = 0; i < 19; i++) detector.recordTaskCompletion("peer-1", "low");
    detector.recordTaskCompletion("peer-1", "medium");

    const profile = detector.evaluatePeer("peer-1");
    const cpFlag = profile.gaming_flags.find(f => f.type === "cherry_picking");
    expect(cpFlag).toBeDefined();
    expect(cpFlag!.severity).toBe("high");
    expect(cpFlag!.evidence).toContain("95%");
  });

  it("should flag complexity_avoidance when >50% high-complexity tasks rejected", () => {
    // 10 low completions to meet threshold, plus 1 high completion + 2 high rejections
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "low");
    detector.recordTaskCompletion("peer-1", "high");
    detector.recordTaskRejection("peer-1", "high");
    detector.recordTaskRejection("peer-1", "high");

    // high total = 1 completed + 2 rejected = 3; rejection rate = 2/3 = 66.7%
    const profile = detector.evaluatePeer("peer-1");
    const caFlag = profile.gaming_flags.find(f => f.type === "complexity_avoidance");
    expect(caFlag).toBeDefined();
    expect(caFlag!.type).toBe("complexity_avoidance");
    expect(caFlag!.severity).toBe("medium");
    expect(caFlag!.evidence).toContain("67%");
  });

  it("should flag complexity_avoidance with high severity when >=80% high-complexity rejected", () => {
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "low");
    detector.recordTaskCompletion("peer-1", "high");
    // 4 high rejections => 4/5 = 80% rejected
    for (let i = 0; i < 4; i++) detector.recordTaskRejection("peer-1", "high");

    const profile = detector.evaluatePeer("peer-1");
    const caFlag = profile.gaming_flags.find(f => f.type === "complexity_avoidance");
    expect(caFlag).toBeDefined();
    expect(caFlag!.severity).toBe("high");
  });

  // ─── computeComplexityWeightedScore ─────────────────────────────────

  it("should return base score when below min tasks", () => {
    detector.recordTaskCompletion("peer-1", "low");
    const score = detector.computeComplexityWeightedScore("peer-1", 0.8);
    expect(score).toBe(0.8);
  });

  it("should return base score when peer has no completions at all", () => {
    const score = detector.computeComplexityWeightedScore("unknown", 0.7);
    expect(score).toBe(0.7);
  });

  it("should adjust score for uniform task distribution", () => {
    // Uniform: 4 low + 3 medium + 3 high = 10
    for (let i = 0; i < 4; i++) detector.recordTaskCompletion("peer-1", "low");
    for (let i = 0; i < 3; i++) detector.recordTaskCompletion("peer-1", "medium");
    for (let i = 0; i < 3; i++) detector.recordTaskCompletion("peer-1", "high");

    const score = detector.computeComplexityWeightedScore("peer-1", 1.0);
    // avgWeight = (4*0.5 + 3*1.0 + 3*1.5) / 10 = (2 + 3 + 4.5) / 10 = 0.95
    // diversity near 1.0 (not perfectly uniform but close)
    // result = 1.0 * (1 - 0.15 + 0.15 * diversity) * 0.95
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1.0);
  });

  it("should reduce score for skewed (all-low) task distribution", () => {
    // All low: 10 low tasks
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "low");

    const score = detector.computeComplexityWeightedScore("peer-1", 1.0);
    // avgWeight = 0.5, diversity = 0 (monoculture)
    // result = 1.0 * (1 - 0.15 + 0.15 * 0) * 0.5 = 0.85 * 0.5 = 0.425
    expect(score).toBeCloseTo(0.425, 3);
  });

  it("should boost score for all-high complexity tasks", () => {
    // All high: 10 high tasks
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "high");

    const score = detector.computeComplexityWeightedScore("peer-1", 1.0);
    // avgWeight = 1.5, diversity = 0 (monoculture)
    // result = 1.0 * (1 - 0.15 + 0.15 * 0) * 1.5 = 0.85 * 1.5 = 1.275
    expect(score).toBeCloseTo(1.275, 3);
  });

  // ─── task_diversity_score ───────────────────────────────────────────

  it("should have diversity score 0.0 for monoculture (single complexity)", () => {
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "low");

    const profile = detector.evaluatePeer("peer-1");
    expect(profile.task_diversity_score).toBeCloseTo(0.0, 5);
  });

  it("should have diversity score 1.0 for perfectly uniform distribution", () => {
    // Perfectly equal: same count for each complexity
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "low");
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "medium");
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "high");

    const profile = detector.evaluatePeer("peer-1");
    expect(profile.task_diversity_score).toBeCloseTo(1.0, 5);
  });

  it("should have diversity score between 0 and 1 for mixed distribution", () => {
    // Skewed but not monoculture: 7 low + 2 medium + 1 high
    for (let i = 0; i < 7; i++) detector.recordTaskCompletion("peer-1", "low");
    for (let i = 0; i < 2; i++) detector.recordTaskCompletion("peer-1", "medium");
    detector.recordTaskCompletion("peer-1", "high");

    const profile = detector.evaluatePeer("peer-1");
    expect(profile.task_diversity_score).toBeGreaterThan(0);
    expect(profile.task_diversity_score).toBeLessThan(1);
  });

  it("should have diversity score 0.0 for peer with no completions", () => {
    const profile = detector.evaluatePeer("empty-peer");
    expect(profile.task_diversity_score).toBe(0);
  });

  // ─── hasGamingFlags ─────────────────────────────────────────────────

  it("should return false when peer has no gaming flags", () => {
    for (let i = 0; i < 4; i++) detector.recordTaskCompletion("peer-1", "low");
    for (let i = 0; i < 3; i++) detector.recordTaskCompletion("peer-1", "medium");
    for (let i = 0; i < 3; i++) detector.recordTaskCompletion("peer-1", "high");

    expect(detector.hasGamingFlags("peer-1")).toBe(false);
  });

  it("should return true when peer has gaming flags", () => {
    for (let i = 0; i < 10; i++) detector.recordTaskCompletion("peer-1", "low");

    expect(detector.hasGamingFlags("peer-1")).toBe(true);
  });

  // ─── getHighSeverityFlags ───────────────────────────────────────────

  it("should return empty array when no high severity flags", () => {
    // 9 low + 1 medium -> cherry_picking medium severity only
    for (let i = 0; i < 9; i++) detector.recordTaskCompletion("peer-1", "low");
    detector.recordTaskCompletion("peer-1", "medium");

    const highFlags = detector.getHighSeverityFlags("peer-1");
    expect(highFlags).toHaveLength(0);
  });

  it("should return only high severity flags", () => {
    // 19 low + 1 medium -> 95% low => cherry_picking high severity
    for (let i = 0; i < 19; i++) detector.recordTaskCompletion("peer-1", "low");
    detector.recordTaskCompletion("peer-1", "medium");

    const highFlags = detector.getHighSeverityFlags("peer-1");
    expect(highFlags).toHaveLength(1);
    expect(highFlags[0]!.type).toBe("cherry_picking");
    expect(highFlags[0]!.severity).toBe("high");
  });

  // ─── getProfile ─────────────────────────────────────────────────────

  it("should return undefined for unknown node with no completions", () => {
    expect(detector.getProfile("unknown-node")).toBeUndefined();
  });

  it("should return profile for node with completions", () => {
    detector.recordTaskCompletion("peer-1", "medium");

    const profile = detector.getProfile("peer-1");
    expect(profile).toBeDefined();
    expect(profile!.node_id).toBe("peer-1");
    expect(profile!.tasks_by_complexity.medium).toBe(1);
    expect(profile!.last_evaluated_at).toBeDefined();
  });

  // ─── Custom Config ──────────────────────────────────────────────────

  it("should respect custom cherry_pick_threshold", () => {
    const custom = new AntiGamingDetector({
      cherry_pick_threshold: 0.6,
      min_tasks_for_evaluation: 5,
    });

    // 4 low + 1 medium = 5 tasks, 80% low (above custom 60% threshold)
    for (let i = 0; i < 4; i++) custom.recordTaskCompletion("peer-1", "low");
    custom.recordTaskCompletion("peer-1", "medium");

    const profile = custom.evaluatePeer("peer-1");
    const cpFlag = profile.gaming_flags.find(f => f.type === "cherry_picking");
    expect(cpFlag).toBeDefined();
    expect(cpFlag!.evidence).toContain("80%");
  });

  it("should respect custom rejection_rate_threshold", () => {
    const custom = new AntiGamingDetector({
      rejection_rate_threshold: 0.3,
      min_tasks_for_evaluation: 5,
    });

    for (let i = 0; i < 5; i++) custom.recordTaskCompletion("peer-1", "low");
    custom.recordTaskCompletion("peer-1", "high");
    custom.recordTaskRejection("peer-1", "high");

    // high total = 1 + 1 = 2; rejection rate = 1/2 = 50% (above custom 30%)
    const profile = custom.evaluatePeer("peer-1");
    const caFlag = profile.gaming_flags.find(f => f.type === "complexity_avoidance");
    expect(caFlag).toBeDefined();
  });
});
