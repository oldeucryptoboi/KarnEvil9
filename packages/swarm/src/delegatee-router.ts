import type { JournalEventType } from "@karnevil9/schemas";
import type { TaskAttribute, SubTaskSpec, RoutingFactors, RoutingDecision } from "./types.js";

export class DelegateeRouter {
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  constructor(emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.emitEvent = emitEvent;
  }

  route(subTask: SubTaskSpec): RoutingDecision {
    const factors = this.computeFactors(subTask.attributes);
    const { target, confidence, reason } = this.decide(factors, subTask);

    const decision: RoutingDecision = {
      sub_task_id: subTask.sub_task_id,
      target,
      confidence,
      factors,
      reason,
    };

    this.emitEvent?.("swarm.delegatee_routed" as JournalEventType, {
      sub_task_id: subTask.sub_task_id,
      target,
      confidence,
    });

    if (target === "human") {
      this.emitEvent?.("swarm.human_delegation_requested" as JournalEventType, {
        sub_task_id: subTask.sub_task_id,
        reason,
      });
    }

    return decision;
  }

  routeAll(subTasks: SubTaskSpec[]): RoutingDecision[] {
    return subTasks.map(st => this.route(st));
  }

  private computeFactors(attrs: TaskAttribute): RoutingFactors {
    const critMap: Record<string, number> = { low: 0.2, medium: 0.5, high: 0.9 };
    const revMap: Record<string, number> = { low: 0.1, medium: 0.5, high: 0.9 };
    const verMap: Record<string, number> = { low: 0.2, medium: 0.5, high: 0.9 };
    // Subjectivity: if verifiability is low, subjectivity is likely high
    const subjMap: Record<string, number> = { low: 0.8, medium: 0.4, high: 0.1 };
    const costMap: Record<string, number> = { low: 0.3, medium: 0.6, high: 0.9 };

    return {
      criticality_score: critMap[attrs.criticality] ?? 0.5,
      reversibility_score: revMap[attrs.reversibility] ?? 0.5,
      verifiability_score: verMap[attrs.verifiability] ?? 0.5,
      subjectivity_score: subjMap[attrs.verifiability] ?? 0.5,
      cost_benefit_score: costMap[attrs.estimated_cost] ?? 0.5,
    };
  }

  private decide(factors: RoutingFactors, subTask: SubTaskSpec): { target: "ai" | "human" | "any"; confidence: number; reason: string } {
    // If the subtask already has an explicit delegation_target set, preserve it
    if (subTask.delegation_target === "human") {
      return { target: "human", confidence: 1.0, reason: "Explicitly marked for human delegation" };
    }

    // Rule 1: High criticality + low reversibility -> human
    if (factors.criticality_score > 0.7 && factors.reversibility_score < 0.3) {
      return { target: "human", confidence: 0.9, reason: "High criticality with low reversibility requires human judgment" };
    }

    // Rule 2: Low verifiability -> human
    if (factors.verifiability_score < 0.3) {
      return { target: "human", confidence: 0.8, reason: "Low verifiability — outcome hard to verify automatically" };
    }

    // Rule 3: High subjectivity -> human
    if (factors.subjectivity_score > 0.7) {
      return { target: "human", confidence: 0.75, reason: "Highly subjective task requires human judgment" };
    }

    // Rule 4: High verifiability + low criticality -> AI
    if (factors.verifiability_score > 0.7 && factors.criticality_score < 0.5) {
      return { target: "ai", confidence: 0.9, reason: "Verifiable and low-criticality — suitable for AI delegation" };
    }

    // Default: any
    return { target: "any", confidence: 0.6, reason: "No strong signal for human or AI — either can handle" };
  }
}
