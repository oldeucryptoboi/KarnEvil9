import { readFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { PeerReputation, SwarmTaskResult } from "./types.js";
import type { BehavioralScorer } from "./behavioral-scorer.js";
import type { SabotageDetector } from "./sabotage-detector.js";

export class ReputationStore {
  private reputations = new Map<string, PeerReputation>();
  private filePath: string;
  private behavioralScorer?: BehavioralScorer;
  private sabotageDetector?: SabotageDetector;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  setBehavioralScorer(scorer: BehavioralScorer): void {
    this.behavioralScorer = scorer;
  }

  setSabotageDetector(detector: SabotageDetector): void {
    this.sabotageDetector = detector;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      this.reputations.clear();
      for (const line of lines) {
        try {
          const rep = JSON.parse(line) as PeerReputation;
          this.reputations.set(rep.node_id, rep);
        } catch {
          // Skip corrupted lines rather than losing all reputations
        }
      }
    } catch {
      this.reputations.clear();
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = [...this.reputations.values()];
    const content = entries.map(r => JSON.stringify(r)).join("\n") + (entries.length > 0 ? "\n" : "");
    const tmpPath = this.filePath + ".tmp";
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(content, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }

  recordOutcome(nodeId: string, result: SwarmTaskResult): void {
    let rep = this.reputations.get(nodeId);
    if (!rep) {
      rep = {
        node_id: nodeId,
        tasks_completed: 0,
        tasks_failed: 0,
        tasks_aborted: 0,
        total_duration_ms: 0,
        total_tokens_used: 0,
        total_cost_usd: 0,
        avg_latency_ms: 0,
        consecutive_successes: 0,
        consecutive_failures: 0,
        last_outcome_at: new Date().toISOString(),
        trust_score: 0.5,
      };
    }

    rep.total_duration_ms += result.duration_ms;
    rep.total_tokens_used += result.tokens_used;
    rep.total_cost_usd += result.cost_usd;
    rep.last_outcome_at = new Date().toISOString();

    if (result.status === "completed") {
      rep.tasks_completed++;
      rep.consecutive_successes++;
      rep.consecutive_failures = 0;
    } else if (result.status === "failed") {
      rep.tasks_failed++;
      rep.consecutive_failures++;
      rep.consecutive_successes = 0;
    } else {
      rep.tasks_aborted++;
      rep.consecutive_failures++;
      rep.consecutive_successes = 0;
    }

    const totalTasks = rep.tasks_completed + rep.tasks_failed + rep.tasks_aborted;
    rep.avg_latency_ms = rep.total_duration_ms / totalTasks;

    // Behavioral scorer integration (Gap 5)
    if (this.behavioralScorer) {
      const hasSafetyViolations = result.status !== "completed";
      this.behavioralScorer.inferObservationsFromResult(nodeId, 0, hasSafetyViolations);
      const metrics = this.behavioralScorer.getMetrics(nodeId);
      if (metrics) {
        rep.behavioral_metrics = metrics;
      }
    }

    rep.trust_score = this.computeTrustScore(rep);
    this.reputations.set(nodeId, rep);
  }

  getTrustScore(nodeId: string): number {
    return this.reputations.get(nodeId)?.trust_score ?? 0.5;
  }

  getReputation(nodeId: string): PeerReputation | undefined {
    return this.reputations.get(nodeId);
  }

  getAllReputations(): PeerReputation[] {
    return [...this.reputations.values()];
  }

  decay(factor: number = 0.05): void {
    for (const rep of this.reputations.values()) {
      // Move trust_score toward 0.5 by factor
      rep.trust_score = rep.trust_score + (0.5 - rep.trust_score) * factor;
    }
  }

  reset(nodeId: string): void {
    this.reputations.delete(nodeId);
  }

  get size(): number {
    return this.reputations.size;
  }

  private computeTrustScore(rep: PeerReputation): number {
    const total = rep.tasks_completed + rep.tasks_failed + rep.tasks_aborted;
    const base = rep.tasks_completed / (total + 1);
    const latencyPenalty = Math.max(0, Math.min(1, 1 - rep.avg_latency_ms / 300000));
    const streakBonus = Math.min(rep.consecutive_successes * 0.02, 0.1);
    const streakPenalty = Math.min(rep.consecutive_failures * 0.05, 0.3);
    let score = Math.max(0, Math.min(1, base * 0.7 + latencyPenalty * 0.2 + streakBonus - streakPenalty + 0.1));

    // Behavioral metrics multiplier (Gap 5): blend 70% base + 30% behavioral
    if (rep.behavioral_metrics) {
      score = score * (0.7 + 0.3 * rep.behavioral_metrics.composite_score);
    }

    return Math.max(0, Math.min(1, score));
  }
}
