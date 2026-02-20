import { randomUUID } from "node:crypto";
import type { CollusionReport, CollusionIndicator, BidObject } from "./types.js";

export interface CollusionDetectorConfig {
  bid_variance_threshold: number;
  reciprocal_boost_window: number;
  min_tasks_for_analysis: number;
}

export const DEFAULT_COLLUSION_CONFIG: CollusionDetectorConfig = {
  bid_variance_threshold: 0.05,
  reciprocal_boost_window: 20,
  min_tasks_for_analysis: 5,
};

interface OutcomeRecord {
  task_id: string;
  delegator: string;
  delegatee: string;
  outcome: "completed" | "failed" | "aborted";
  timestamp: number;
}

export class CollusionDetector {
  private config: CollusionDetectorConfig;
  private bids = new Map<string, BidObject[]>(); // rfq_id -> bids
  private outcomes: OutcomeRecord[] = [];
  private reports: CollusionReport[] = [];

  constructor(config?: Partial<CollusionDetectorConfig>) {
    this.config = { ...DEFAULT_COLLUSION_CONFIG, ...config };
  }

  recordBid(bid: BidObject): void {
    if (!this.bids.has(bid.rfq_id)) {
      this.bids.set(bid.rfq_id, []);
    }
    this.bids.get(bid.rfq_id)!.push(bid);
  }

  recordOutcome(
    taskId: string,
    delegator: string,
    delegatee: string,
    outcome: "completed" | "failed" | "aborted",
  ): void {
    this.outcomes.push({
      task_id: taskId,
      delegator,
      delegatee,
      outcome,
      timestamp: Date.now(),
    });

    // Cleanup old outcomes (keep last 1000)
    if (this.outcomes.length > 1000) {
      this.outcomes = this.outcomes.slice(-500);
    }
  }

  analyzeBids(rfqId: string): CollusionReport[] {
    const bids = this.bids.get(rfqId);
    if (!bids || bids.length < 2) return [];

    const newReports: CollusionReport[] = [];

    // Check bid coordination: coefficient of variation < threshold
    const costs = bids.map(b => b.estimated_cost_usd);
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    if (mean > 0) {
      const variance = costs.reduce((sum, c) => sum + (c - mean) ** 2, 0) / costs.length;
      const stddev = Math.sqrt(variance);
      const cv = stddev / mean;

      if (cv < this.config.bid_variance_threshold && bids.length >= 3) {
        const report: CollusionReport = {
          report_id: randomUUID(),
          suspect_node_ids: bids.map(b => b.bidder_node_id),
          indicator: "bid_coordination",
          confidence: Math.min(0.9, 0.5 + (1 - cv / this.config.bid_variance_threshold) * 0.4),
          evidence: {
            rfq_id: rfqId,
            bid_count: bids.length,
            coefficient_of_variation: cv,
            threshold: this.config.bid_variance_threshold,
            costs,
          },
          timestamp: new Date().toISOString(),
          action: cv < this.config.bid_variance_threshold / 2 ? "quarantine" : "flag",
        };
        newReports.push(report);
        this.reports.push(report);
      }
    }

    return newReports;
  }

  analyzeReputationPatterns(): CollusionReport[] {
    if (this.outcomes.length < this.config.min_tasks_for_analysis) return [];

    const newReports: CollusionReport[] = [];

    // Build pair success matrix
    const pairSuccess = new Map<string, { success: number; total: number }>();
    for (const outcome of this.outcomes) {
      const key = `${outcome.delegator}|${outcome.delegatee}`;
      if (!pairSuccess.has(key)) pairSuccess.set(key, { success: 0, total: 0 });
      const entry = pairSuccess.get(key)!;
      entry.total++;
      if (outcome.outcome === "completed") entry.success++;
    }

    // Check reciprocal boosting: A->B and B->A both have high success rates
    const nodes = new Set<string>();
    for (const outcome of this.outcomes) {
      nodes.add(outcome.delegator);
      nodes.add(outcome.delegatee);
    }
    const nodeArray = [...nodes];

    for (let i = 0; i < nodeArray.length; i++) {
      for (let j = i + 1; j < nodeArray.length; j++) {
        const a = nodeArray[i]!;
        const b = nodeArray[j]!;
        const abKey = `${a}|${b}`;
        const baKey = `${b}|${a}`;

        const ab = pairSuccess.get(abKey);
        const ba = pairSuccess.get(baKey);

        if (!ab || !ba) continue;
        if (ab.total < 3 || ba.total < 3) continue;

        const abRate = ab.success / ab.total;
        const baRate = ba.success / ba.total;

        // Both must have > 90% success rate and be reciprocal
        if (abRate >= 0.9 && baRate >= 0.9) {
          const report: CollusionReport = {
            report_id: randomUUID(),
            suspect_node_ids: [a, b],
            indicator: "reciprocal_boosting",
            confidence: Math.min(0.8, (abRate + baRate) / 2),
            evidence: {
              pair: [a, b],
              a_to_b: { success_rate: abRate, total: ab.total },
              b_to_a: { success_rate: baRate, total: ba.total },
            },
            timestamp: new Date().toISOString(),
            action: "flag",
          };
          newReports.push(report);
          this.reports.push(report);
        }
      }
    }

    return newReports;
  }

  getReports(): CollusionReport[] {
    return [...this.reports];
  }

  getReportsForNode(nodeId: string): CollusionReport[] {
    return this.reports.filter(r => r.suspect_node_ids.includes(nodeId));
  }
}
