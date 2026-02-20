import { v4 as uuid } from "uuid";
import type {
  AnomalyType,
  AnomalyReport,
  SwarmTaskResult,
  DelegationContract,
  PeerReputation,
  TaskCheckpointStatus,
} from "./types.js";

export interface AnomalyDetectorConfig {
  cost_spike_threshold?: number;          // multiplier over contract SLO (default 1.5)
  duration_spike_threshold?: number;      // multiplier over contract SLO (default 2.0)
  failure_rate_window?: number;           // recent tasks to consider (default 10)
  failure_rate_threshold?: number;        // fraction failures to trigger (default 0.5)
  auto_quarantine_severity?: "high" | "critical"; // auto-quarantine at this severity
}

export class AnomalyDetector {
  private config: Required<AnomalyDetectorConfig>;
  private quarantinedPeers = new Set<string>();
  private recentReports: AnomalyReport[] = [];

  constructor(config?: AnomalyDetectorConfig) {
    this.config = {
      cost_spike_threshold: config?.cost_spike_threshold ?? 1.5,
      duration_spike_threshold: config?.duration_spike_threshold ?? 2.0,
      failure_rate_window: config?.failure_rate_window ?? 10,
      failure_rate_threshold: config?.failure_rate_threshold ?? 0.5,
      auto_quarantine_severity: config?.auto_quarantine_severity ?? "critical",
    };
  }

  analyzeResult(params: {
    result: SwarmTaskResult;
    contract?: DelegationContract;
    peerReputation?: PeerReputation;
    peerCapabilities?: string[];
  }): AnomalyReport[] {
    const reports: AnomalyReport[] = [];
    const { result, contract, peerReputation, peerCapabilities } = params;

    // 1. Cost spike
    if (contract && result.cost_usd > contract.slo.max_cost_usd * this.config.cost_spike_threshold) {
      reports.push(this.createReport({
        task_id: result.task_id,
        peer_node_id: result.peer_node_id,
        type: "cost_spike",
        severity: result.cost_usd > contract.slo.max_cost_usd * 3 ? "critical" : "high",
        description: `Cost ${result.cost_usd} exceeds ${this.config.cost_spike_threshold}x SLO max ${contract.slo.max_cost_usd}`,
        evidence: { cost_usd: result.cost_usd, slo_max: contract.slo.max_cost_usd, multiplier: result.cost_usd / contract.slo.max_cost_usd },
      }));
    }

    // 2. Duration spike
    if (contract && result.duration_ms > contract.slo.max_duration_ms * this.config.duration_spike_threshold) {
      reports.push(this.createReport({
        task_id: result.task_id,
        peer_node_id: result.peer_node_id,
        type: "duration_spike",
        severity: result.duration_ms > contract.slo.max_duration_ms * 4 ? "critical" : "high",
        description: `Duration ${result.duration_ms}ms exceeds ${this.config.duration_spike_threshold}x SLO max ${contract.slo.max_duration_ms}ms`,
        evidence: { duration_ms: result.duration_ms, slo_max: contract.slo.max_duration_ms, multiplier: result.duration_ms / contract.slo.max_duration_ms },
      }));
    }

    // 3. Suspicious findings — tools not in contract allowlist
    if (contract?.permission_boundary?.tool_allowlist?.length) {
      const allowlist = new Set(contract.permission_boundary.tool_allowlist);
      const suspiciousTools = result.findings
        .map((f) => f.tool_name)
        .filter((t) => !allowlist.has(t));
      if (suspiciousTools.length > 0) {
        reports.push(this.createReport({
          task_id: result.task_id,
          peer_node_id: result.peer_node_id,
          type: "suspicious_findings",
          severity: "high",
          description: `Findings reference tools not in allowlist: ${suspiciousTools.join(", ")}`,
          evidence: { suspicious_tools: suspiciousTools, allowlist: [...allowlist] },
        }));
      }
    }

    // 4. Capability mismatch — peer used capabilities it doesn't advertise
    if (peerCapabilities && peerCapabilities.length > 0) {
      const capSet = new Set(peerCapabilities);
      const usedTools = new Set(result.findings.map((f) => f.tool_name));
      const mismatched = [...usedTools].filter((t) => !capSet.has(t));
      if (mismatched.length > 0) {
        reports.push(this.createReport({
          task_id: result.task_id,
          peer_node_id: result.peer_node_id,
          type: "capability_mismatch",
          severity: "medium",
          description: `Peer used tools not in its capabilities: ${mismatched.join(", ")}`,
          evidence: { mismatched_tools: mismatched, peer_capabilities: peerCapabilities },
        }));
      }
    }

    // 5. Repeated failures
    if (peerReputation) {
      const total = peerReputation.tasks_completed + peerReputation.tasks_failed + peerReputation.tasks_aborted;
      const window = Math.min(total, this.config.failure_rate_window);
      if (window > 0) {
        const failureRate = (peerReputation.tasks_failed + peerReputation.tasks_aborted) / total;
        if (failureRate >= this.config.failure_rate_threshold) {
          reports.push(this.createReport({
            task_id: result.task_id,
            peer_node_id: result.peer_node_id,
            type: "repeated_failures",
            severity: failureRate >= 0.8 ? "critical" : "high",
            description: `Peer failure rate ${(failureRate * 100).toFixed(1)}% exceeds threshold ${(this.config.failure_rate_threshold * 100).toFixed(1)}%`,
            evidence: {
              failure_rate: failureRate,
              tasks_completed: peerReputation.tasks_completed,
              tasks_failed: peerReputation.tasks_failed,
              tasks_aborted: peerReputation.tasks_aborted,
            },
          }));
        }
      }
    }

    // Auto-quarantine if any report meets severity threshold
    for (const report of reports) {
      const severityOrder = ["low", "medium", "high", "critical"];
      const reportIdx = severityOrder.indexOf(report.severity);
      const thresholdIdx = severityOrder.indexOf(this.config.auto_quarantine_severity);
      if (reportIdx >= thresholdIdx) {
        report.auto_action = "quarantine";
        this.quarantinePeer(result.peer_node_id);
      }
    }

    this.recentReports.push(...reports);
    return reports;
  }

  analyzeCheckpoint(params: {
    checkpoint: TaskCheckpointStatus;
    contract?: DelegationContract;
    elapsed_ms: number;
  }): AnomalyReport[] {
    const reports: AnomalyReport[] = [];
    const { checkpoint, contract, elapsed_ms } = params;

    // Duration already exceeding SLO while task is still running
    if (contract && elapsed_ms > contract.slo.max_duration_ms * this.config.duration_spike_threshold) {
      reports.push(this.createReport({
        task_id: checkpoint.task_id,
        peer_node_id: "unknown",
        type: "duration_spike",
        severity: "high",
        description: `Task still running after ${elapsed_ms}ms, exceeds ${this.config.duration_spike_threshold}x SLO max ${contract.slo.max_duration_ms}ms`,
        evidence: { elapsed_ms, slo_max: contract.slo.max_duration_ms },
      }));
    }

    this.recentReports.push(...reports);
    return reports;
  }

  getQuarantinedPeers(): Set<string> {
    return new Set(this.quarantinedPeers);
  }

  quarantinePeer(nodeId: string): void {
    this.quarantinedPeers.add(nodeId);
  }

  unquarantinePeer(nodeId: string): void {
    this.quarantinedPeers.delete(nodeId);
  }

  isQuarantined(nodeId: string): boolean {
    return this.quarantinedPeers.has(nodeId);
  }

  getRecentReports(limit = 100): AnomalyReport[] {
    return this.recentReports.slice(-limit);
  }

  // ─── Internal ────────────────────────────────────────────────────

  private createReport(params: {
    task_id: string;
    peer_node_id: string;
    type: AnomalyType;
    severity: AnomalyReport["severity"];
    description: string;
    evidence: Record<string, unknown>;
  }): AnomalyReport {
    return {
      anomaly_id: uuid(),
      task_id: params.task_id,
      peer_node_id: params.peer_node_id,
      type: params.type,
      severity: params.severity,
      description: params.description,
      evidence: params.evidence,
      timestamp: new Date().toISOString(),
      auto_action: "none",
    };
  }
}
