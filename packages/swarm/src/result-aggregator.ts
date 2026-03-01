import type { CheckpointFinding } from "@karnevil9/schemas";
import type { SwarmTaskResult } from "./types.js";

export interface AggregationEntry {
  correlation_id: string;
  expected_count: number;
  results: SwarmTaskResult[];
  created_at: number;
  timeout_ms: number;
  resolve: (findings: CheckpointFinding[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ResultAggregator {
  private pending = new Map<string, AggregationEntry>();
  private static readonly MAX_PENDING_AGGREGATIONS = 1_000;

  /**
   * Create an aggregation that waits for `expectedCount` results.
   * Returns a promise that resolves with merged findings once all results arrive
   * or rejects on timeout.
   */
  createAggregation(
    correlationId: string,
    expectedCount: number,
    timeoutMs: number,
  ): Promise<CheckpointFinding[]> {
    // Reject if too many pending aggregations to prevent unbounded memory growth
    if (this.pending.size >= ResultAggregator.MAX_PENDING_AGGREGATIONS && !this.pending.has(correlationId)) {
      return Promise.reject(new Error(`Max pending aggregations (${ResultAggregator.MAX_PENDING_AGGREGATIONS}) exceeded`));
    }
    return new Promise<CheckpointFinding[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(correlationId);
        if (entry) {
          this.pending.delete(correlationId);
          // Resolve with partial results if any arrived
          if (entry.results.length > 0) {
            resolve(this.mergeFindings(entry.results));
          } else {
            reject(new Error(`Aggregation ${correlationId} timed out with no results`));
          }
        }
      }, timeoutMs);
      timer.unref();

      this.pending.set(correlationId, {
        correlation_id: correlationId,
        expected_count: expectedCount,
        results: [],
        created_at: Date.now(),
        timeout_ms: timeoutMs,
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * Add a result to a pending aggregation. Returns true if the result
   * completed the aggregation (all expected results received).
   */
  addResult(correlationId: string, result: SwarmTaskResult): boolean {
    const entry = this.pending.get(correlationId);
    if (!entry) return false;

    entry.results.push(result);

    if (entry.results.length >= entry.expected_count) {
      clearTimeout(entry.timer);
      this.pending.delete(correlationId);
      entry.resolve(this.mergeFindings(entry.results));
      return true;
    }

    return false;
  }

  /** Get the number of pending aggregations. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Get status of a specific aggregation. */
  getStatus(correlationId: string): { received: number; expected: number; elapsed_ms: number } | undefined {
    const entry = this.pending.get(correlationId);
    if (!entry) return undefined;
    return {
      received: entry.results.length,
      expected: entry.expected_count,
      elapsed_ms: Date.now() - entry.created_at,
    };
  }

  /** Cancel all pending aggregations. */
  cancelAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Aggregation cancelled"));
    }
    this.pending.clear();
  }

  /** Merge findings from multiple task results into a single array. */
  private mergeFindings(results: SwarmTaskResult[]): CheckpointFinding[] {
    const findings: CheckpointFinding[] = [];
    for (const result of results) {
      for (const finding of result.findings) {
        findings.push({
          step_title: `[${result.peer_node_id}] ${finding.step_title}`,
          tool_name: finding.tool_name,
          status: finding.status,
          summary: finding.summary,
        });
      }
    }
    return findings;
  }
}
