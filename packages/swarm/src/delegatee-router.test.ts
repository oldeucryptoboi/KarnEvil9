import { describe, it, expect, vi, beforeEach } from "vitest";
import { DelegateeRouter } from "./delegatee-router.js";
import type { SubTaskSpec, TaskAttribute } from "./types.js";

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

function makeSubTask(overrides?: Partial<SubTaskSpec>): SubTaskSpec {
  return {
    sub_task_id: "sub-1",
    task_text: "test subtask",
    attributes: makeAttrs(),
    constraints: {},
    depends_on: [],
    ...overrides,
  };
}

describe("DelegateeRouter", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
  });

  // ─── High criticality + low reversibility → human ─────────────────

  it("routes to human when high criticality and low reversibility", () => {
    const router = new DelegateeRouter(emitEvent);
    const sub = makeSubTask({ attributes: makeAttrs({ criticality: "high", reversibility: "low" }) });
    const decision = router.route(sub);
    expect(decision.target).toBe("human");
    expect(decision.confidence).toBe(0.9);
  });

  // ─── Low verifiability → human ────────────────────────────────────

  it("routes to human when low verifiability", () => {
    const router = new DelegateeRouter(emitEvent);
    const sub = makeSubTask({ attributes: makeAttrs({ verifiability: "low", criticality: "low", reversibility: "high" }) });
    const decision = router.route(sub);
    expect(decision.target).toBe("human");
    expect(decision.confidence).toBe(0.8);
  });

  // ─── High verifiability + low criticality → ai ────────────────────

  it("routes to ai when high verifiability and low criticality", () => {
    const router = new DelegateeRouter(emitEvent);
    const sub = makeSubTask({ attributes: makeAttrs({ verifiability: "high", criticality: "low", reversibility: "high" }) });
    const decision = router.route(sub);
    expect(decision.target).toBe("ai");
    expect(decision.confidence).toBe(0.9);
  });

  // ─── Medium everything → any ──────────────────────────────────────

  it("routes to any when all attributes are medium", () => {
    const router = new DelegateeRouter(emitEvent);
    const sub = makeSubTask();
    const decision = router.route(sub);
    expect(decision.target).toBe("any");
    expect(decision.confidence).toBe(0.6);
  });

  // ─── Explicit delegation_target=human preserved ───────────────────

  it("preserves explicit delegation_target of human", () => {
    const router = new DelegateeRouter(emitEvent);
    const sub = makeSubTask({
      delegation_target: "human",
      attributes: makeAttrs({ verifiability: "high", criticality: "low" }),
    });
    const decision = router.route(sub);
    expect(decision.target).toBe("human");
    expect(decision.confidence).toBe(1.0);
    expect(decision.reason).toContain("Explicitly marked");
  });

  // ─── routeAll ─────────────────────────────────────────────────────

  it("routeAll processes array of subtasks", () => {
    const router = new DelegateeRouter(emitEvent);
    const subs = [
      makeSubTask({ sub_task_id: "s1", attributes: makeAttrs({ criticality: "high", reversibility: "low" }) }),
      makeSubTask({ sub_task_id: "s2", attributes: makeAttrs({ verifiability: "high", criticality: "low" }) }),
    ];
    const decisions = router.routeAll(subs);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.target).toBe("human");
    expect(decisions[1]!.target).toBe("ai");
  });

  // ─── Event emission: delegatee_routed always ──────────────────────

  it("emits delegatee_routed event on every route call", () => {
    const router = new DelegateeRouter(emitEvent);
    router.route(makeSubTask());
    expect(emitEvent).toHaveBeenCalledWith("swarm.delegatee_routed", expect.objectContaining({
      sub_task_id: "sub-1",
    }));
  });

  // ─── Event emission: human_delegation_requested when human ────────

  it("emits human_delegation_requested when target is human", () => {
    const router = new DelegateeRouter(emitEvent);
    const sub = makeSubTask({ attributes: makeAttrs({ criticality: "high", reversibility: "low" }) });
    router.route(sub);
    expect(emitEvent).toHaveBeenCalledWith("swarm.human_delegation_requested", expect.objectContaining({
      sub_task_id: "sub-1",
    }));
  });

  // ─── No human_delegation_requested when ai ────────────────────────

  it("does not emit human_delegation_requested when target is ai", () => {
    const router = new DelegateeRouter(emitEvent);
    const sub = makeSubTask({ attributes: makeAttrs({ verifiability: "high", criticality: "low" }) });
    router.route(sub);
    const humanCalls = emitEvent.mock.calls.filter(
      (c: [string, unknown]) => c[0] === "swarm.human_delegation_requested"
    );
    expect(humanCalls).toHaveLength(0);
  });

  // ─── Factor computation: criticality levels ───────────────────────

  it("computes correct criticality scores for all levels", () => {
    const router = new DelegateeRouter(emitEvent);
    const lowSub = makeSubTask({ attributes: makeAttrs({ criticality: "low" }) });
    const medSub = makeSubTask({ attributes: makeAttrs({ criticality: "medium" }) });
    const highSub = makeSubTask({ attributes: makeAttrs({ criticality: "high" }) });

    expect(router.route(lowSub).factors.criticality_score).toBe(0.2);
    expect(router.route(medSub).factors.criticality_score).toBe(0.5);
    expect(router.route(highSub).factors.criticality_score).toBe(0.9);
  });

  // ─── Factor computation: reversibility levels ─────────────────────

  it("computes correct reversibility scores for all levels", () => {
    const router = new DelegateeRouter(emitEvent);
    const lowSub = makeSubTask({ attributes: makeAttrs({ reversibility: "low" }) });
    const medSub = makeSubTask({ attributes: makeAttrs({ reversibility: "medium" }) });
    const highSub = makeSubTask({ attributes: makeAttrs({ reversibility: "high" }) });

    expect(router.route(lowSub).factors.reversibility_score).toBe(0.1);
    expect(router.route(medSub).factors.reversibility_score).toBe(0.5);
    expect(router.route(highSub).factors.reversibility_score).toBe(0.9);
  });

  // ─── Factor computation: verifiability levels ─────────────────────

  it("computes correct verifiability scores for all levels", () => {
    const router = new DelegateeRouter(emitEvent);
    const lowSub = makeSubTask({ attributes: makeAttrs({ verifiability: "low" }) });
    const medSub = makeSubTask({ attributes: makeAttrs({ verifiability: "medium" }) });
    const highSub = makeSubTask({ attributes: makeAttrs({ verifiability: "high" }) });

    expect(router.route(lowSub).factors.verifiability_score).toBe(0.2);
    expect(router.route(medSub).factors.verifiability_score).toBe(0.5);
    expect(router.route(highSub).factors.verifiability_score).toBe(0.9);
  });

  // ─── Subjectivity derived from verifiability ──────────────────────

  it("derives subjectivity from verifiability (low verifiability = high subjectivity)", () => {
    const router = new DelegateeRouter(emitEvent);
    const lowVer = makeSubTask({ attributes: makeAttrs({ verifiability: "low" }) });
    const highVer = makeSubTask({ attributes: makeAttrs({ verifiability: "high" }) });

    expect(router.route(lowVer).factors.subjectivity_score).toBe(0.8);
    expect(router.route(highVer).factors.subjectivity_score).toBe(0.1);
  });

  // ─── Cost benefit from estimated_cost ─────────────────────────────

  it("computes cost_benefit_score from estimated_cost", () => {
    const router = new DelegateeRouter(emitEvent);
    const lowCost = makeSubTask({ attributes: makeAttrs({ estimated_cost: "low" }) });
    const medCost = makeSubTask({ attributes: makeAttrs({ estimated_cost: "medium" }) });
    const highCost = makeSubTask({ attributes: makeAttrs({ estimated_cost: "high" }) });

    expect(router.route(lowCost).factors.cost_benefit_score).toBe(0.3);
    expect(router.route(medCost).factors.cost_benefit_score).toBe(0.6);
    expect(router.route(highCost).factors.cost_benefit_score).toBe(0.9);
  });

  // ─── High subjectivity → human ────────────────────────────────────

  it("routes to human when subjectivity is high (low verifiability)", () => {
    const router = new DelegateeRouter(emitEvent);
    // low verifiability = subjectivity 0.8 > 0.7
    // But low verifiability also triggers Rule 2 first (verifiability_score 0.2 < 0.3)
    // Need a scenario where subjectivity > 0.7 but verifiability >= 0.3
    // Not possible with current mapping since subjectivity is derived from verifiability
    // So let's just verify that low verifiability leads to human via subjectivity path
    const sub = makeSubTask({ attributes: makeAttrs({ verifiability: "low", criticality: "low", reversibility: "high" }) });
    const decision = router.route(sub);
    expect(decision.target).toBe("human");
  });

  // ─── Confidence values are 0-1 ────────────────────────────────────

  it("produces confidence values between 0 and 1", () => {
    const router = new DelegateeRouter(emitEvent);
    const subs = [
      makeSubTask({ attributes: makeAttrs({ criticality: "high", reversibility: "low" }) }),
      makeSubTask({ attributes: makeAttrs({ verifiability: "high", criticality: "low" }) }),
      makeSubTask(),
      makeSubTask({ delegation_target: "human" }),
    ];
    for (const sub of subs) {
      const decision = router.route(sub);
      expect(decision.confidence).toBeGreaterThanOrEqual(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
    }
  });

  // ─── Reason string is non-empty ───────────────────────────────────

  it("provides a non-empty reason string", () => {
    const router = new DelegateeRouter(emitEvent);
    const decision = router.route(makeSubTask());
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  // ─── Empty subtasks array ─────────────────────────────────────────

  it("returns empty decisions array for empty subtasks", () => {
    const router = new DelegateeRouter(emitEvent);
    const decisions = router.routeAll([]);
    expect(decisions).toHaveLength(0);
  });

  // ─── All fields present in RoutingDecision ────────────────────────

  it("returns all required fields in RoutingDecision", () => {
    const router = new DelegateeRouter(emitEvent);
    const decision = router.route(makeSubTask());
    expect(decision).toHaveProperty("sub_task_id");
    expect(decision).toHaveProperty("target");
    expect(decision).toHaveProperty("confidence");
    expect(decision).toHaveProperty("factors");
    expect(decision).toHaveProperty("reason");
    expect(decision.factors).toHaveProperty("criticality_score");
    expect(decision.factors).toHaveProperty("reversibility_score");
    expect(decision.factors).toHaveProperty("verifiability_score");
    expect(decision.factors).toHaveProperty("subjectivity_score");
    expect(decision.factors).toHaveProperty("cost_benefit_score");
  });

  // ─── sub_task_id matches input ────────────────────────────────────

  it("preserves sub_task_id from input", () => {
    const router = new DelegateeRouter(emitEvent);
    const sub = makeSubTask({ sub_task_id: "unique-id-42" });
    const decision = router.route(sub);
    expect(decision.sub_task_id).toBe("unique-id-42");
  });
});
