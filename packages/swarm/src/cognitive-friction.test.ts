import { describe, it, expect, vi, beforeEach } from "vitest";
import { CognitiveFrictionEngine } from "./cognitive-friction.js";
import type { TaskAttribute, } from "./types.js";

function makeAttrs(overrides?: Partial<TaskAttribute>): TaskAttribute {
  return {
    complexity: "medium",
    criticality: "medium",
    verifiability: "medium",
    reversibility: "medium",
    estimated_cost: "medium",
    estimated_duration: "medium",
    required_capabilities: [],
    ...overrides,
  };
}

describe("CognitiveFrictionEngine", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
  });

  // ─── Low-risk scenario → none ─────────────────────────────────────

  it("returns 'none' for low-risk attributes", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "low", reversibility: "high", verifiability: "high" });
    const result = engine.assess(attrs, 0, 1.0, 3);
    expect(result.level).toBe("none");
  });

  // ─── High-risk scenario → mandatory_human ─────────────────────────

  it("returns 'mandatory_human' for high-risk attributes", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "low" });
    const result = engine.assess(attrs, 3, 0.1, 3);
    expect(result.level).toBe("mandatory_human");
  });

  // ─── Medium attributes → info or confirm ──────────────────────────

  it("returns info or confirm for medium attributes", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs();
    const result = engine.assess(attrs, 1, 0.5, 3);
    expect(["info", "confirm"]).toContain(result.level);
  });

  // ─── Custom weights affect composite score ────────────────────────

  it("uses custom weights to compute composite", () => {
    const engine = new CognitiveFrictionEngine({
      weights: { criticality: 1.0, irreversibility: 0, uncertainty: 0, depth_ratio: 0, trust_deficit: 0 },
    }, emitEvent);
    const highCrit = makeAttrs({ criticality: "high", reversibility: "high", verifiability: "high" });
    const lowCrit = makeAttrs({ criticality: "low", reversibility: "high", verifiability: "high" });
    const highResult = engine.assess(highCrit, 0, 1.0, 3);
    const lowResult = engine.assess(lowCrit, 0, 1.0, 3);
    expect(highResult.composite_score).toBeGreaterThan(lowResult.composite_score);
  });

  // ─── Threshold boundary: just below info ──────────────────────────

  it("returns 'none' when score is just below info threshold", () => {
    // With default thresholds: info=0.3
    // All low-risk factors should produce score < 0.3
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "low", reversibility: "high", verifiability: "high" });
    const result = engine.assess(attrs, 0, 1.0, 3);
    expect(result.composite_score).toBeLessThan(0.3);
    expect(result.level).toBe("none");
  });

  // ─── Threshold boundary: at info ──────────────────────────────────

  it("returns 'info' when score equals info threshold", () => {
    const engine = new CognitiveFrictionEngine({
      thresholds: { info: 0.3, confirm: 0.6, mandatory_human: 0.85 },
    }, emitEvent);
    // Medium attrs: crit=0.5, irrev=0.5, unc=0.5
    // With default weights: 0.5*0.3 + 0.5*0.25 + 0.5*0.2 + depthRatio*0.15 + trustDeficit*0.1
    // = 0.15 + 0.125 + 0.1 + depthRatio*0.15 + trustDeficit*0.1
    // Need score >= 0.3
    // With depth=1, maxDepth=3 -> depth_ratio = 0.333, trustScore=0.7 -> deficit=0.3
    // = 0.375 + 0.333*0.15 + 0.3*0.1 = 0.375 + 0.05 + 0.03 = 0.455
    const attrs = makeAttrs();
    const result = engine.assess(attrs, 1, 0.7, 3);
    expect(result.level).toBe("info");
    expect(result.composite_score).toBeGreaterThanOrEqual(0.3);
    expect(result.composite_score).toBeLessThan(0.6);
  });

  // ─── Threshold boundary: at confirm ───────────────────────────────

  it("returns 'confirm' when score reaches confirm threshold", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "medium" });
    // crit=0.9, irrev=0.9, unc=0.5, depth_ratio will vary, trust_deficit varies
    // 0.9*0.3 + 0.9*0.25 + 0.5*0.2 + depthRatio*0.15 + deficit*0.1
    // = 0.27 + 0.225 + 0.1 = 0.595 base, need a tiny bit more for confirm at 0.6
    const result = engine.assess(attrs, 1, 0.9, 3);
    // 0.595 + (1/3)*0.15 + 0.1*0.1 = 0.595 + 0.05 + 0.01 = 0.655
    expect(result.level).toBe("confirm");
  });

  // ─── Threshold boundary: at mandatory_human ───────────────────────

  it("returns 'mandatory_human' when score reaches mandatory_human threshold", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "low" });
    // crit=0.9, irrev=0.9, unc=0.9
    // 0.9*0.3 + 0.9*0.25 + 0.9*0.2 + depthRatio*0.15 + deficit*0.1
    // = 0.27 + 0.225 + 0.18 = 0.675 base
    // depth=3, maxDepth=3 -> depth_ratio=1 -> +0.15 = 0.825
    // trust=0.0 -> deficit=1 -> +0.1 = 0.925 >= 0.85
    const result = engine.assess(attrs, 3, 0.0, 3);
    expect(result.level).toBe("mandatory_human");
    expect(result.composite_score).toBeGreaterThanOrEqual(0.85);
  });

  // ─── Anti-fatigue: confirm downgrades to info ─────────────────────

  it("downgrades confirm to info after max escalations", () => {
    const engine = new CognitiveFrictionEngine({
      anti_fatigue_max_escalations: 2,
      anti_fatigue_window_ms: 60000,
    }, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "medium" });
    // First two calls should register escalation timestamps
    engine.assess(attrs, 1, 0.9, 3); // confirm
    engine.assess(attrs, 1, 0.9, 3); // confirm
    // Third call: anti-fatigue triggers, downgrades confirm -> info
    const result = engine.assess(attrs, 1, 0.9, 3);
    expect(result.level).toBe("info");
  });

  // ─── Anti-fatigue: mandatory_human is never downgraded ────────────

  it("does not downgrade mandatory_human even with anti-fatigue", () => {
    const engine = new CognitiveFrictionEngine({
      anti_fatigue_max_escalations: 1,
      anti_fatigue_window_ms: 60000,
    }, emitEvent);
    const highAttrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "low" });
    // First call triggers escalation
    engine.assess(highAttrs, 3, 0.0, 3); // mandatory_human
    // Second call: still mandatory_human (never downgraded)
    const result = engine.assess(highAttrs, 3, 0.0, 3);
    expect(result.level).toBe("mandatory_human");
  });

  // ─── Anti-fatigue: old escalations outside window don't count ─────

  it("does not count escalations outside the anti-fatigue window", () => {
    const engine = new CognitiveFrictionEngine({
      anti_fatigue_max_escalations: 2,
      anti_fatigue_window_ms: 100, // very short window
    }, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "medium" });
    engine.assess(attrs, 1, 0.9, 3); // confirm escalation #1
    engine.assess(attrs, 1, 0.9, 3); // confirm escalation #2
    // Wait for window to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = engine.assess(attrs, 1, 0.9, 3);
        // Escalations have expired, so no anti-fatigue
        expect(result.level).toBe("confirm");
        resolve();
      }, 150);
    });
  });

  // ─── Event emission: friction_assessed always ─────────────────────

  it("always emits friction_assessed event", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "low", reversibility: "high", verifiability: "high" });
    engine.assess(attrs, 0, 1.0, 3);
    expect(emitEvent).toHaveBeenCalledWith("swarm.friction_assessed", expect.objectContaining({
      level: "none",
    }));
  });

  // ─── Event emission: escalation on confirm ────────────────────────

  it("emits friction_escalation_triggered on confirm", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "medium" });
    engine.assess(attrs, 1, 0.9, 3);
    expect(emitEvent).toHaveBeenCalledWith("swarm.friction_escalation_triggered", expect.objectContaining({
      level: "confirm",
    }));
  });

  // ─── Event emission: escalation on mandatory_human ────────────────

  it("emits friction_escalation_triggered on mandatory_human", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "low" });
    engine.assess(attrs, 3, 0.0, 3);
    expect(emitEvent).toHaveBeenCalledWith("swarm.friction_escalation_triggered", expect.objectContaining({
      level: "mandatory_human",
    }));
  });

  // ─── No escalation event for none or info ─────────────────────────

  it("does not emit escalation event for 'none'", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "low", reversibility: "high", verifiability: "high" });
    engine.assess(attrs, 0, 1.0, 3);
    const escalationCalls = emitEvent.mock.calls.filter(
      (c: [string, unknown]) => c[0] === "swarm.friction_escalation_triggered"
    );
    expect(escalationCalls).toHaveLength(0);
  });

  it("does not emit escalation event for 'info'", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs(); // medium everything
    const result = engine.assess(attrs, 1, 0.7, 3);
    if (result.level === "info") {
      const escalationCalls = emitEvent.mock.calls.filter(
        (c: [string, unknown]) => c[0] === "swarm.friction_escalation_triggered"
      );
      expect(escalationCalls).toHaveLength(0);
    }
  });

  // ─── getConfig returns a copy ─────────────────────────────────────

  it("getConfig returns a deep copy", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const config = engine.getConfig();
    config.weights.criticality = 999;
    config.thresholds.info = 999;
    const fresh = engine.getConfig();
    expect(fresh.weights.criticality).toBe(0.3);
    expect(fresh.thresholds.info).toBe(0.3);
  });

  // ─── Factor computation: depth_ratio = 0 when maxDepth = 0 ───────

  it("returns depth_ratio 0 when maxDepth is 0", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs();
    const result = engine.assess(attrs, 5, 0.5, 0);
    expect(result.factors.depth_ratio).toBe(0);
  });

  // ─── Factor computation: trust_deficit = 0 when trust >= 1 ───────

  it("returns trust_deficit 0 when trustScore is 1.0", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs();
    const result = engine.assess(attrs, 0, 1.0, 3);
    expect(result.factors.trust_deficit).toBe(0);
  });

  // ─── Different criticality levels → expected factor values ────────

  it("maps criticality levels to expected factor values", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);

    const low = engine.assess(makeAttrs({ criticality: "low" }), 0, 1.0, 3);
    const med = engine.assess(makeAttrs({ criticality: "medium" }), 0, 1.0, 3);
    const high = engine.assess(makeAttrs({ criticality: "high" }), 0, 1.0, 3);

    expect(low.factors.criticality).toBe(0.2);
    expect(med.factors.criticality).toBe(0.5);
    expect(high.factors.criticality).toBe(0.9);
  });

  // ─── Custom thresholds change level mapping ───────────────────────

  it("uses custom thresholds to change level mapping", () => {
    const engine = new CognitiveFrictionEngine({
      thresholds: { info: 0.01, confirm: 0.02, mandatory_human: 0.03 },
    }, emitEvent);
    const attrs = makeAttrs({ criticality: "low", reversibility: "high", verifiability: "high" });
    // Even low-risk will exceed these thresholds (score > 0.03)
    const result = engine.assess(attrs, 0, 1.0, 3);
    // score = 0.2*0.3 + 0.1*0.25 + 0.1*0.2 + 0*0.15 + 0*0.1 = 0.06 + 0.025 + 0.02 = 0.105
    expect(result.level).toBe("mandatory_human");
  });

  // ─── Composite score is deterministic ─────────────────────────────

  it("produces deterministic composite scores for same inputs", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low" });
    const r1 = engine.assess(attrs, 2, 0.5, 3);
    const r2 = engine.assess(attrs, 2, 0.5, 3);
    expect(r1.composite_score).toBe(r2.composite_score);
  });

  // ─── Reason string contains factor descriptions ───────────────────

  it("includes relevant factor descriptions in reason", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low", verifiability: "low" });
    const result = engine.assess(attrs, 3, 0.0, 3);
    expect(result.reason).toContain("high criticality");
    expect(result.reason).toContain("low reversibility");
    expect(result.reason).toContain("low verifiability");
  });

  // ─── Irreversibility factor mapping ───────────────────────────────

  it("maps reversibility levels to irreversibility factors correctly", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);

    const lowRev = engine.assess(makeAttrs({ reversibility: "low" }), 0, 1.0, 3);
    const medRev = engine.assess(makeAttrs({ reversibility: "medium" }), 0, 1.0, 3);
    const highRev = engine.assess(makeAttrs({ reversibility: "high" }), 0, 1.0, 3);

    expect(lowRev.factors.irreversibility).toBe(0.9);
    expect(medRev.factors.irreversibility).toBe(0.5);
    expect(highRev.factors.irreversibility).toBe(0.1);
  });

  // ─── Depth ratio clamped to 1 when depth > maxDepth ───────────────

  it("clamps depth_ratio to 1 when depth exceeds maxDepth", () => {
    const engine = new CognitiveFrictionEngine(undefined, emitEvent);
    const attrs = makeAttrs();
    const result = engine.assess(attrs, 10, 0.5, 3);
    expect(result.factors.depth_ratio).toBe(1);
  });
});
