import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiabilityFirebreak } from "./liability-firebreak.js";
import type { TaskAttribute } from "./types.js";

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

describe("LiabilityFirebreak", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
  });

  // ─── Default policy (base_max_depth=3, strict mode) ─────────────

  it("allows depth 0 with default policy", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const decision = fb.evaluate(0);
    expect(decision.action).toBe("allow");
    expect(decision.current_depth).toBe(0);
    expect(decision.effective_max_depth).toBe(3);
  });

  it("allows depth 1 with default policy", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const decision = fb.evaluate(1);
    expect(decision.action).toBe("allow");
  });

  it("allows depth 2 with default policy", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const decision = fb.evaluate(2);
    expect(decision.action).toBe("allow");
  });

  it("halts at depth 3 with default policy (strict mode)", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const decision = fb.evaluate(3);
    expect(decision.action).toBe("halt");
    expect(decision.current_depth).toBe(3);
    expect(decision.effective_max_depth).toBe(3);
  });

  // ─── High criticality reduces effective depth by 1 ───────────────

  it("reduces effective max depth by 1 for high criticality", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high" });
    const decision = fb.evaluate(2, attrs);
    expect(decision.action).toBe("halt");
    expect(decision.effective_max_depth).toBe(2);
  });

  // ─── Low reversibility reduces effective depth by 1 ──────────────

  it("reduces effective max depth by 1 for low reversibility", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const attrs = makeAttrs({ reversibility: "low" });
    const decision = fb.evaluate(2, attrs);
    expect(decision.action).toBe("halt");
    expect(decision.effective_max_depth).toBe(2);
  });

  // ─── Both reductions clamped to min_depth ─────────────────────────

  it("clamps to min_depth when both high criticality and low reversibility", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low" });
    // base 3 - 1 (crit) - 1 (rev) = 1, which equals min_depth
    const decision = fb.evaluate(1, attrs);
    expect(decision.action).toBe("halt");
    expect(decision.effective_max_depth).toBe(1);
  });

  // ─── Permissive mode returns request_authority ────────────────────

  it("returns request_authority in permissive mode", () => {
    const fb = new LiabilityFirebreak({ mode: "permissive" }, emitEvent);
    const decision = fb.evaluate(3);
    expect(decision.action).toBe("request_authority");
  });

  // ─── shouldFirebreak ──────────────────────────────────────────────

  it("shouldFirebreak returns false when allowed", () => {
    const fb = new LiabilityFirebreak();
    expect(fb.shouldFirebreak(0)).toBe(false);
  });

  it("shouldFirebreak returns true when halted", () => {
    const fb = new LiabilityFirebreak();
    expect(fb.shouldFirebreak(3)).toBe(true);
  });

  // ─── Event emission ──────────────────────────────────────────────

  it("emits firebreak_triggered on halt", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    fb.evaluate(3);
    expect(emitEvent).toHaveBeenCalledWith("swarm.firebreak_triggered", expect.objectContaining({
      chain_depth: 3,
      effective_max_depth: 3,
    }));
  });

  it("emits firebreak_authority_requested in permissive mode", () => {
    const fb = new LiabilityFirebreak({ mode: "permissive" }, emitEvent);
    fb.evaluate(3);
    expect(emitEvent).toHaveBeenCalledWith("swarm.firebreak_authority_requested", expect.objectContaining({
      chain_depth: 3,
      effective_max_depth: 3,
    }));
  });

  it("does not emit events when action is allow", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    fb.evaluate(0);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  // ─── Custom policy ───────────────────────────────────────────────

  it("uses custom base_max_depth", () => {
    const fb = new LiabilityFirebreak({ base_max_depth: 5 }, emitEvent);
    const decision = fb.evaluate(4);
    expect(decision.action).toBe("allow");
    expect(decision.effective_max_depth).toBe(5);
  });

  it("respects custom min_depth floor clamp", () => {
    const fb = new LiabilityFirebreak({ base_max_depth: 3, min_depth: 2 }, emitEvent);
    const attrs = makeAttrs({ criticality: "high", reversibility: "low" });
    // base 3 - 1 - 1 = 1 but min_depth = 2
    const decision = fb.evaluate(2, attrs);
    expect(decision.action).toBe("halt");
    expect(decision.effective_max_depth).toBe(2);
  });

  // ─── Medium criticality does NOT reduce ───────────────────────────

  it("does not reduce depth for medium criticality", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const attrs = makeAttrs({ criticality: "medium" });
    const decision = fb.evaluate(2, attrs);
    expect(decision.action).toBe("allow");
    expect(decision.effective_max_depth).toBe(3);
  });

  // ─── High reversibility does NOT reduce ───────────────────────────

  it("does not reduce depth for high reversibility", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const attrs = makeAttrs({ reversibility: "high" });
    const decision = fb.evaluate(2, attrs);
    expect(decision.action).toBe("allow");
    expect(decision.effective_max_depth).toBe(3);
  });

  // ─── Edge: depth exactly at limit ─────────────────────────────────

  it("halts when depth equals effective limit", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const decision = fb.evaluate(3);
    expect(decision.action).toBe("halt");
    expect(decision.reason).toContain("reached");
  });

  // ─── Edge: depth far beyond limit ─────────────────────────────────

  it("halts when depth far exceeds limit", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const decision = fb.evaluate(100);
    expect(decision.action).toBe("halt");
    expect(decision.current_depth).toBe(100);
  });

  // ─── getPolicy returns a copy ─────────────────────────────────────

  it("getPolicy returns a copy that does not affect internal state", () => {
    const fb = new LiabilityFirebreak(undefined, emitEvent);
    const policy = fb.getPolicy();
    policy.base_max_depth = 999;
    expect(fb.getPolicy().base_max_depth).toBe(3);
  });
});
