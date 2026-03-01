import type { JournalEventType } from "@karnevil9/schemas";
import type { BehavioralObservation, BehavioralObservationType, BehavioralMetrics } from "./types.js";

const SCORE_WEIGHTS = {
  transparency: 0.25,
  safety: 0.30,
  protocol_compliance: 0.25,
  reasoning_clarity: 0.20,
};

const MAX_OBSERVATIONS = 100;

type MetricKey = "transparency" | "safety" | "protocol_compliance" | "reasoning_clarity";

const OBSERVATION_METRIC_MAP: Record<BehavioralObservationType, { metric: MetricKey; value: number }> = {
  transparency_high: { metric: "transparency", value: 1 },
  transparency_low: { metric: "transparency", value: 0 },
  safety_compliant: { metric: "safety", value: 1 },
  safety_violation: { metric: "safety", value: 0 },
  protocol_followed: { metric: "protocol_compliance", value: 1 },
  protocol_violated: { metric: "protocol_compliance", value: 0 },
  reasoning_clear: { metric: "reasoning_clarity", value: 1 },
  reasoning_opaque: { metric: "reasoning_clarity", value: 0 },
};

export class BehavioralScorer {
  private observations = new Map<string, BehavioralObservation[]>();
  private cachedMetrics = new Map<string, BehavioralMetrics>();
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  private static readonly MAX_TRACKED_NODES = 10_000;

  constructor(emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.emitEvent = emitEvent;
  }

  recordObservation(nodeId: string, observation: BehavioralObservation): void {
    if (!this.observations.has(nodeId)) {
      // Cap tracked nodes to prevent unbounded memory growth
      if (this.observations.size >= BehavioralScorer.MAX_TRACKED_NODES) {
        const firstKey = this.observations.keys().next().value;
        if (firstKey !== undefined) {
          this.observations.delete(firstKey);
          this.cachedMetrics.delete(firstKey);
        }
      }
      this.observations.set(nodeId, []);
    }
    const obs = this.observations.get(nodeId)!;
    obs.push(observation);

    // FIFO cap
    if (obs.length > MAX_OBSERVATIONS) {
      obs.splice(0, obs.length - MAX_OBSERVATIONS);
    }

    // Save old score before invalidating cache
    const oldScore = this.cachedMetrics.get(nodeId)?.composite_score;

    // Invalidate cache
    this.cachedMetrics.delete(nodeId);

    this.emitEvent?.("swarm.behavioral_observation_recorded" as JournalEventType, {
      node_id: nodeId,
      observation_type: observation.type,
    });

    // Recompute and check for significant change
    const newMetrics = this.computeMetrics(nodeId);
    if (oldScore !== undefined && Math.abs(newMetrics.composite_score - oldScore) > 0.02) {
      this.emitEvent?.("swarm.behavioral_score_updated" as JournalEventType, {
        node_id: nodeId,
        old_score: oldScore,
        new_score: newMetrics.composite_score,
      });
    }
  }

  getMetrics(nodeId: string): BehavioralMetrics | undefined {
    if (this.cachedMetrics.has(nodeId)) return this.cachedMetrics.get(nodeId);
    if (!this.observations.has(nodeId)) return undefined;
    return this.computeMetrics(nodeId);
  }

  computeCompositeScore(nodeId: string): number {
    const metrics = this.getMetrics(nodeId);
    return metrics?.composite_score ?? 0.5; // default neutral
  }

  inferObservationsFromResult(nodeId: string, checkpointsMissed: number, hasSafetyViolations: boolean): void {
    const now = new Date().toISOString();

    if (checkpointsMissed === 0) {
      this.recordObservation(nodeId, { type: "protocol_followed", timestamp: now });
    } else {
      this.recordObservation(nodeId, { type: "protocol_violated", timestamp: now, evidence: `${checkpointsMissed} checkpoints missed` });
    }

    if (hasSafetyViolations) {
      this.recordObservation(nodeId, { type: "safety_violation", timestamp: now });
    } else {
      this.recordObservation(nodeId, { type: "safety_compliant", timestamp: now });
    }
  }

  getObservationCount(nodeId: string): number {
    return this.observations.get(nodeId)?.length ?? 0;
  }

  private computeMetrics(nodeId: string): BehavioralMetrics {
    const obs = this.observations.get(nodeId) ?? [];

    const counts: Record<MetricKey, { sum: number; count: number }> = {
      transparency: { sum: 0, count: 0 },
      safety: { sum: 0, count: 0 },
      protocol_compliance: { sum: 0, count: 0 },
      reasoning_clarity: { sum: 0, count: 0 },
    };

    for (const o of obs) {
      const mapping = OBSERVATION_METRIC_MAP[o.type];
      if (mapping) {
        counts[mapping.metric].sum += mapping.value;
        counts[mapping.metric].count++;
      }
    }

    const transparency = counts.transparency.count > 0 ? counts.transparency.sum / counts.transparency.count : 0.5;
    const safety = counts.safety.count > 0 ? counts.safety.sum / counts.safety.count : 0.5;
    const protocol_compliance = counts.protocol_compliance.count > 0 ? counts.protocol_compliance.sum / counts.protocol_compliance.count : 0.5;
    const reasoning_clarity = counts.reasoning_clarity.count > 0 ? counts.reasoning_clarity.sum / counts.reasoning_clarity.count : 0.5;

    const composite_score =
      transparency * SCORE_WEIGHTS.transparency +
      safety * SCORE_WEIGHTS.safety +
      protocol_compliance * SCORE_WEIGHTS.protocol_compliance +
      reasoning_clarity * SCORE_WEIGHTS.reasoning_clarity;

    const metrics: BehavioralMetrics = {
      transparency,
      safety,
      protocol_compliance,
      reasoning_clarity,
      composite_score,
      observation_count: obs.length,
    };

    this.cachedMetrics.set(nodeId, metrics);
    return metrics;
  }
}
