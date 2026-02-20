import { randomUUID } from "node:crypto";
import type { JournalEventType } from "@karnevil9/schemas";
import type { FirebreakPolicy, FirebreakDecision, TaskAttribute } from "./types.js";
import { DEFAULT_FIREBREAK_POLICY } from "./types.js";

export class LiabilityFirebreak {
  private policy: FirebreakPolicy;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  constructor(policy?: Partial<FirebreakPolicy>, emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.policy = { ...DEFAULT_FIREBREAK_POLICY, ...policy };
    this.emitEvent = emitEvent;
  }

  evaluate(chainDepth: number, taskAttributes?: TaskAttribute, contractSLO?: { max_cost_usd?: number }): FirebreakDecision {
    let effectiveMaxDepth = this.policy.base_max_depth;

    // Reduce for high criticality
    if (taskAttributes?.criticality === "high") {
      effectiveMaxDepth -= this.policy.criticality_reduction;
    }

    // Reduce for low reversibility
    if (taskAttributes?.reversibility === "low") {
      effectiveMaxDepth -= this.policy.reversibility_reduction;
    }

    // Floor clamp
    effectiveMaxDepth = Math.max(effectiveMaxDepth, this.policy.min_depth);

    if (chainDepth < effectiveMaxDepth) {
      return {
        action: "allow",
        effective_max_depth: effectiveMaxDepth,
        current_depth: chainDepth,
        reason: `Depth ${chainDepth} within limit ${effectiveMaxDepth}`,
      };
    }

    // At or beyond effective depth
    const action: FirebreakDecision["action"] = this.policy.mode === "strict" ? "halt" : "request_authority";
    const reason = `Depth ${chainDepth} ${chainDepth >= effectiveMaxDepth ? "reached" : "exceeds"} effective limit ${effectiveMaxDepth}`;

    const decision: FirebreakDecision = {
      action,
      effective_max_depth: effectiveMaxDepth,
      current_depth: chainDepth,
      reason,
    };

    if (action === "halt") {
      this.emitEvent?.("swarm.firebreak_triggered" as JournalEventType, {
        chain_depth: chainDepth,
        effective_max_depth: effectiveMaxDepth,
        criticality: taskAttributes?.criticality,
        reversibility: taskAttributes?.reversibility,
      });
    } else {
      this.emitEvent?.("swarm.firebreak_authority_requested" as JournalEventType, {
        chain_depth: chainDepth,
        effective_max_depth: effectiveMaxDepth,
        criticality: taskAttributes?.criticality,
        reversibility: taskAttributes?.reversibility,
      });
    }

    return decision;
  }

  shouldFirebreak(depth: number, attrs?: TaskAttribute): boolean {
    const decision = this.evaluate(depth, attrs);
    return decision.action !== "allow";
  }

  getPolicy(): FirebreakPolicy {
    return { ...this.policy };
  }
}
