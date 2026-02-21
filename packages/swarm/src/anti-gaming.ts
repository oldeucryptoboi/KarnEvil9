import type { GamingFlag, PeerTaskProfile, TaskComplexityRecord } from "./types.js";

export interface AntiGamingConfig {
  cherry_pick_threshold: number;
  rejection_rate_threshold: number;
  min_tasks_for_evaluation: number;
  diversity_weight: number;
  complexity_weight_multiplier: { low: number; medium: number; high: number };
}

export const DEFAULT_ANTI_GAMING_CONFIG: AntiGamingConfig = {
  cherry_pick_threshold: 0.8,
  rejection_rate_threshold: 0.5,
  min_tasks_for_evaluation: 10,
  diversity_weight: 0.15,
  complexity_weight_multiplier: { low: 0.5, medium: 1.0, high: 1.5 },
};

export class AntiGamingDetector {
  private config: AntiGamingConfig;
  private completions = new Map<string, TaskComplexityRecord[]>();
  private rejections = new Map<string, TaskComplexityRecord[]>();

  constructor(config?: Partial<AntiGamingConfig>) {
    this.config = { ...DEFAULT_ANTI_GAMING_CONFIG, ...config };
  }

  recordTaskCompletion(nodeId: string, complexity: "low" | "medium" | "high", taskId?: string): void {
    if (!this.completions.has(nodeId)) this.completions.set(nodeId, []);
    this.completions.get(nodeId)!.push({
      task_id: taskId ?? `task-${Date.now()}`,
      complexity,
      completed_at: new Date().toISOString(),
    });
  }

  recordTaskRejection(nodeId: string, complexity: "low" | "medium" | "high", taskId?: string): void {
    if (!this.rejections.has(nodeId)) this.rejections.set(nodeId, []);
    this.rejections.get(nodeId)!.push({
      task_id: taskId ?? `task-${Date.now()}`,
      complexity,
      completed_at: new Date().toISOString(),
    });
  }

  evaluatePeer(nodeId: string): PeerTaskProfile {
    const completed = this.completions.get(nodeId) ?? [];
    const rejected = this.rejections.get(nodeId) ?? [];

    const tasksByComplexity = { low: 0, medium: 0, high: 0 };
    for (const t of completed) tasksByComplexity[t.complexity]++;

    const tasksRejectedByComplexity = { low: 0, medium: 0, high: 0 };
    for (const t of rejected) tasksRejectedByComplexity[t.complexity]++;

    const diversityScore = this.computeDiversityScore(tasksByComplexity);
    const gamingFlags: GamingFlag[] = [];
    const totalCompleted = completed.length;

    if (totalCompleted >= this.config.min_tasks_for_evaluation) {
      // Cherry-picking: >80% of completed tasks are low complexity
      const lowRatio = totalCompleted > 0 ? tasksByComplexity.low / totalCompleted : 0;
      if (lowRatio >= this.config.cherry_pick_threshold) {
        gamingFlags.push({
          type: "cherry_picking",
          severity: lowRatio >= 0.95 ? "high" : "medium",
          evidence: `${(lowRatio * 100).toFixed(0)}% of ${totalCompleted} completed tasks are low complexity`,
          flagged_at: new Date().toISOString(),
        });
      }

      // Complexity avoidance: >50% of high-complexity tasks rejected
      const highRejected = tasksRejectedByComplexity.high;
      const highTotal = tasksByComplexity.high + highRejected;
      if (highTotal > 0) {
        const rejectionRate = highRejected / highTotal;
        if (rejectionRate >= this.config.rejection_rate_threshold) {
          gamingFlags.push({
            type: "complexity_avoidance",
            severity: rejectionRate >= 0.8 ? "high" : "medium",
            evidence: `${(rejectionRate * 100).toFixed(0)}% of high-complexity tasks rejected (${highRejected}/${highTotal})`,
            flagged_at: new Date().toISOString(),
          });
        }
      }
    }

    return {
      node_id: nodeId,
      tasks_by_complexity: tasksByComplexity,
      tasks_rejected_by_complexity: tasksRejectedByComplexity,
      task_diversity_score: diversityScore,
      gaming_flags: gamingFlags,
      last_evaluated_at: new Date().toISOString(),
    };
  }

  computeComplexityWeightedScore(nodeId: string, baseScore: number): number {
    const completed = this.completions.get(nodeId) ?? [];
    if (completed.length < this.config.min_tasks_for_evaluation) return baseScore;

    const tasksByComplexity = { low: 0, medium: 0, high: 0 };
    for (const t of completed) tasksByComplexity[t.complexity]++;

    const total = completed.length;
    const diversityScore = this.computeDiversityScore(tasksByComplexity);
    const dw = this.config.diversity_weight;

    // Average complexity weight
    const weights = this.config.complexity_weight_multiplier;
    const avgWeight = (
      tasksByComplexity.low * weights.low +
      tasksByComplexity.medium * weights.medium +
      tasksByComplexity.high * weights.high
    ) / total;

    return baseScore * (1 - dw + dw * diversityScore) * avgWeight;
  }

  getProfile(nodeId: string): PeerTaskProfile | undefined {
    const completed = this.completions.get(nodeId);
    if (!completed) return undefined;
    return this.evaluatePeer(nodeId);
  }

  hasGamingFlags(nodeId: string): boolean {
    const profile = this.evaluatePeer(nodeId);
    return profile.gaming_flags.length > 0;
  }

  getHighSeverityFlags(nodeId: string): GamingFlag[] {
    const profile = this.evaluatePeer(nodeId);
    return profile.gaming_flags.filter(f => f.severity === "high");
  }

  /** Normalized entropy: 1.0 = uniform distribution, 0.0 = monoculture */
  private computeDiversityScore(dist: { low: number; medium: number; high: number }): number {
    const total = dist.low + dist.medium + dist.high;
    if (total === 0) return 0;

    const probs = [dist.low / total, dist.medium / total, dist.high / total];
    let entropy = 0;
    for (const p of probs) {
      if (p > 0) entropy -= p * Math.log(p);
    }
    // Normalize by max entropy (log(3))
    return entropy / Math.log(3);
  }
}
