import { randomUUID } from "node:crypto";
import type { JournalEventType } from "@karnevil9/schemas";
import type { FeedbackRecord, SabotageReport, SabotageIndicatorType } from "./types.js";
import type { CollusionDetector } from "./collusion-detector.js";

export interface SabotageDetectorConfig {
  disproportionate_threshold: number; // fraction of negative from one source (default 0.8)
  burst_window_ms: number;            // window for review bombing (default 60000)
  burst_threshold: number;            // min negatives in window to flag (default 5)
  min_feedback_count: number;         // min feedback to analyze (default 3)
}

export const DEFAULT_SABOTAGE_CONFIG: SabotageDetectorConfig = {
  disproportionate_threshold: 0.8,
  burst_window_ms: 60000,
  burst_threshold: 5,
  min_feedback_count: 3,
};

const MAX_REPORTS = 1000;
const MAX_DISCOUNTED_PAIRS = 5000;

export class SabotageDetector {
  private config: SabotageDetectorConfig;
  private feedback: FeedbackRecord[] = [];
  private reports: SabotageReport[] = [];
  private discountedPairs = new Set<string>(); // "from|to" pairs
  private collusionDetector?: CollusionDetector;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  constructor(config?: Partial<SabotageDetectorConfig>, emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.config = { ...DEFAULT_SABOTAGE_CONFIG, ...config };
    this.emitEvent = emitEvent;
  }

  setCollusionDetector(cd: CollusionDetector): void {
    this.collusionDetector = cd;
  }

  recordFeedback(record: FeedbackRecord): void {
    this.feedback.push(record);
    // Cap at 10000
    if (this.feedback.length > 10000) {
      this.feedback = this.feedback.slice(-5000);
    }
  }

  detectSabotage(targetNodeId: string): SabotageReport[] {
    const newReports: SabotageReport[] = [];
    const targetFeedback = this.feedback.filter(f => f.target_node_id === targetNodeId);

    if (targetFeedback.length < this.config.min_feedback_count) return [];

    // Heuristic 1: Disproportionate negative from one source
    const negativeFeedback = targetFeedback.filter(f => !f.positive);
    const positiveFeedback = targetFeedback.filter(f => f.positive);

    if (negativeFeedback.length > 0) {
      const sourceNegCounts = new Map<string, number>();
      for (const f of negativeFeedback) {
        sourceNegCounts.set(f.from_node_id, (sourceNegCounts.get(f.from_node_id) ?? 0) + 1);
      }

      for (const [sourceId, count] of sourceNegCounts) {
        const fraction = count / negativeFeedback.length;
        const othersPositive = positiveFeedback.some(f => f.from_node_id !== sourceId);

        if (fraction >= this.config.disproportionate_threshold && othersPositive) {
          const report: SabotageReport = {
            report_id: randomUUID(),
            indicator: "disproportionate_negative",
            suspect_node_id: sourceId,
            target_node_id: targetNodeId,
            confidence: Math.min(0.9, fraction),
            evidence: { negative_count: count, total_negative: negativeFeedback.length, fraction },
            timestamp: new Date().toISOString(),
          };
          newReports.push(report);
          this.reports.push(report);
          this.discountedPairs.add(`${sourceId}|${targetNodeId}`);
          this.emitEvent?.("swarm.sabotage_detected" as JournalEventType, {
            indicator: "disproportionate_negative",
            suspect: sourceId,
            target: targetNodeId,
            confidence: report.confidence,
          });
        }
      }
    }

    // Heuristic 2: Burst of negatives in time window (review bombing)
    const now = Date.now();
    const recentNeg = negativeFeedback.filter(f => now - new Date(f.timestamp).getTime() < this.config.burst_window_ms);
    if (recentNeg.length >= this.config.burst_threshold) {
      // Find the dominant source
      const burstSources = new Map<string, number>();
      for (const f of recentNeg) {
        burstSources.set(f.from_node_id, (burstSources.get(f.from_node_id) ?? 0) + 1);
      }
      for (const [sourceId, count] of burstSources) {
        if (count >= this.config.burst_threshold) {
          const report: SabotageReport = {
            report_id: randomUUID(),
            indicator: "review_bombing",
            suspect_node_id: sourceId,
            target_node_id: targetNodeId,
            confidence: Math.min(0.85, count / (this.config.burst_threshold * 2)),
            evidence: { burst_count: count, window_ms: this.config.burst_window_ms },
            timestamp: new Date().toISOString(),
          };
          newReports.push(report);
          this.reports.push(report);
          this.discountedPairs.add(`${sourceId}|${targetNodeId}`);
          this.emitEvent?.("swarm.sabotage_detected" as JournalEventType, {
            indicator: "review_bombing",
            suspect: sourceId,
            target: targetNodeId,
          });
        }
      }
    }

    // Heuristic 3: Cross-reference with CollusionDetector
    if (this.collusionDetector && negativeFeedback.length > 0) {
      const suspectSources = new Set(negativeFeedback.map(f => f.from_node_id));
      for (const sourceId of suspectSources) {
        const collusionReports = this.collusionDetector.getReportsForNode(sourceId);
        if (collusionReports.length > 0) {
          const report: SabotageReport = {
            report_id: randomUUID(),
            indicator: "collusion_cross_ref",
            suspect_node_id: sourceId,
            target_node_id: targetNodeId,
            confidence: 0.7,
            evidence: { collusion_reports: collusionReports.length },
            timestamp: new Date().toISOString(),
          };
          newReports.push(report);
          this.reports.push(report);
          this.discountedPairs.add(`${sourceId}|${targetNodeId}`);
          this.emitEvent?.("swarm.sabotage_detected" as JournalEventType, {
            indicator: "collusion_cross_ref",
            suspect: sourceId,
            target: targetNodeId,
          });
        }
      }
    }

    if (this.reports.length > MAX_REPORTS) {
      this.reports = this.reports.slice(-MAX_REPORTS);
    }
    if (this.discountedPairs.size > MAX_DISCOUNTED_PAIRS) {
      // Evict oldest entries (iteration order is insertion order)
      const excess = this.discountedPairs.size - MAX_DISCOUNTED_PAIRS;
      let removed = 0;
      for (const key of this.discountedPairs) {
        if (removed >= excess) break;
        this.discountedPairs.delete(key);
        removed++;
      }
    }

    return newReports;
  }

  shouldDiscount(fromNodeId: string, targetNodeId: string): boolean {
    return this.discountedPairs.has(`${fromNodeId}|${targetNodeId}`);
  }

  getReports(): SabotageReport[] {
    return [...this.reports];
  }

  getReportsForTarget(targetNodeId: string): SabotageReport[] {
    return this.reports.filter(r => r.target_node_id === targetNodeId);
  }
}
