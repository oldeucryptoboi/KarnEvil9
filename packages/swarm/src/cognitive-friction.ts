import type { JournalEventType } from "@karnevil9/schemas";
import type { FrictionConfig, FrictionAssessment, FrictionFactors, FrictionLevel, TaskAttribute } from "./types.js";
import { DEFAULT_FRICTION_CONFIG } from "./types.js";

export class CognitiveFrictionEngine {
  private config: FrictionConfig;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  private escalationTimestamps: number[] = [];

  constructor(config?: Partial<FrictionConfig>, emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.config = { ...DEFAULT_FRICTION_CONFIG, ...config };
    if (config?.weights) this.config.weights = { ...DEFAULT_FRICTION_CONFIG.weights, ...config.weights };
    if (config?.thresholds) this.config.thresholds = { ...DEFAULT_FRICTION_CONFIG.thresholds, ...config.thresholds };
    this.emitEvent = emitEvent;
  }

  assess(taskAttributes: TaskAttribute, delegationDepth: number, peerTrustScore: number, maxDepth: number): FrictionAssessment {
    const factors = this.computeFactors(taskAttributes, delegationDepth, peerTrustScore, maxDepth);
    const compositeScore = this.computeComposite(factors);
    let level = this.mapToLevel(compositeScore);

    // Anti-alarm-fatigue: if too many escalations in window, reduce (but never below mandatory_human)
    if (level !== "none" && level !== "mandatory_human") {
      level = this.applyAntiFatigue(level);
    }

    const reason = this.buildReason(level, factors, compositeScore);

    if (level === "confirm" || level === "mandatory_human") {
      this.escalationTimestamps.push(Date.now());
      this.emitEvent?.("swarm.friction_escalation_triggered" as JournalEventType, {
        level,
        composite_score: compositeScore,
        factors,
      });
    }

    this.emitEvent?.("swarm.friction_assessed" as JournalEventType, {
      level,
      composite_score: compositeScore,
    });

    return { level, composite_score: compositeScore, factors, reason };
  }

  private computeFactors(attrs: TaskAttribute, depth: number, trustScore: number, maxDepth: number): FrictionFactors {
    const critMap: Record<string, number> = { low: 0.2, medium: 0.5, high: 0.9 };
    const revMap: Record<string, number> = { low: 0.9, medium: 0.5, high: 0.1 }; // low reversibility = high irreversibility
    const verMap: Record<string, number> = { low: 0.9, medium: 0.5, high: 0.1 }; // low verifiability = high uncertainty

    return {
      criticality: critMap[attrs.criticality] ?? 0.5,
      irreversibility: revMap[attrs.reversibility] ?? 0.5,
      uncertainty: verMap[attrs.verifiability] ?? 0.5,
      depth_ratio: maxDepth > 0 ? Math.min(depth / maxDepth, 1) : 0,
      trust_deficit: Math.max(0, 1 - trustScore),
    };
  }

  private computeComposite(factors: FrictionFactors): number {
    const w = this.config.weights;
    return (
      factors.criticality * w.criticality +
      factors.irreversibility * w.irreversibility +
      factors.uncertainty * w.uncertainty +
      factors.depth_ratio * w.depth_ratio +
      factors.trust_deficit * w.trust_deficit
    );
  }

  private mapToLevel(score: number): FrictionLevel {
    if (score >= this.config.thresholds.mandatory_human) return "mandatory_human";
    if (score >= this.config.thresholds.confirm) return "confirm";
    if (score >= this.config.thresholds.info) return "info";
    return "none";
  }

  private applyAntiFatigue(level: FrictionLevel): FrictionLevel {
    const now = Date.now();
    const windowStart = now - this.config.anti_fatigue_window_ms;
    // Clean old timestamps
    this.escalationTimestamps = this.escalationTimestamps.filter(t => t > windowStart);

    if (this.escalationTimestamps.length >= this.config.anti_fatigue_max_escalations) {
      // Reduce level by one step (but never reduce mandatory_human)
      if (level === "confirm") return "info";
      if (level === "info") return "none";
    }
    return level;
  }

  private buildReason(level: FrictionLevel, factors: FrictionFactors, score: number): string {
    const parts: string[] = [];
    if (factors.criticality > 0.7) parts.push("high criticality");
    if (factors.irreversibility > 0.7) parts.push("low reversibility");
    if (factors.uncertainty > 0.7) parts.push("low verifiability");
    if (factors.depth_ratio > 0.7) parts.push("deep delegation chain");
    if (factors.trust_deficit > 0.5) parts.push("low peer trust");
    if (parts.length === 0) parts.push("within acceptable parameters");
    return `${level}: ${parts.join(", ")} (score: ${score.toFixed(3)})`;
  }

  getConfig(): FrictionConfig {
    return JSON.parse(JSON.stringify(this.config));
  }
}
