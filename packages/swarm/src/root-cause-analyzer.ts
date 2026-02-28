import type {
  RootCause,
  DiagnosedResponse,
  RootCauseDiagnosis,
  AnomalyReport,
  TaskAttribute,
} from "./types.js";
import type { ReputationStore } from "./reputation-store.js";
import type { MeshManager } from "./mesh-manager.js";

export interface RootCauseAnalyzerConfig {
  overload_latency_ratio: number;
  partition_miss_threshold: number;
  malicious_anomaly_count: number;
  complexity_mismatch_failures: number;
}

export const DEFAULT_ROOT_CAUSE_CONFIG: RootCauseAnalyzerConfig = {
  overload_latency_ratio: 3.0,
  partition_miss_threshold: 3,
  malicious_anomaly_count: 2,
  complexity_mismatch_failures: 2,
};

export class RootCauseAnalyzer {
  private config: RootCauseAnalyzerConfig;
  private reputationStore?: ReputationStore;
  private meshManager: MeshManager;

  constructor(params: {
    meshManager: MeshManager;
    reputationStore?: ReputationStore;
    config?: Partial<RootCauseAnalyzerConfig>;
  }) {
    this.meshManager = params.meshManager;
    this.reputationStore = params.reputationStore;
    this.config = { ...DEFAULT_ROOT_CAUSE_CONFIG, ...params.config };
  }

  diagnose(params: {
    task_id: string;
    peer_node_id: string;
    checkpoint_misses: number;
    anomaly_reports: AnomalyReport[];
    failure_count: number;
    task_attributes?: TaskAttribute;
  }): RootCauseDiagnosis {
    const { task_id, peer_node_id, checkpoint_misses, anomaly_reports, failure_count, task_attributes } = params;
    const evidence: string[] = [];

    // 1. Malicious behavior
    const maliciousAnomalies = anomaly_reports.filter(
      a => a.type === "suspicious_findings" || a.type === "data_access_violation"
    );
    if (maliciousAnomalies.length >= this.config.malicious_anomaly_count) {
      for (const a of maliciousAnomalies) evidence.push(`Anomaly: ${a.type} (${a.severity})`);
      return this.buildDiagnosis({
        task_id, peer_node_id, evidence,
        root_cause: "malicious_behavior",
        confidence: 0.9,
        recommended_response: "quarantine_and_redelegate",
        alternative_responses: ["abort_task", "escalate_to_human"],
      });
    }

    // 2. Network partition
    const peer = this.meshManager.getPeer(peer_node_id);
    const peerSuspected = peer && (peer.status === "suspected" || peer.status === "unreachable");
    if (peerSuspected && checkpoint_misses >= this.config.partition_miss_threshold) {
      evidence.push(`Peer status: ${peer.status}`);
      evidence.push(`Checkpoint misses: ${checkpoint_misses}`);
      return this.buildDiagnosis({
        task_id, peer_node_id, evidence,
        root_cause: "network_partition",
        confidence: 0.7,
        recommended_response: "wait_and_retry",
        alternative_responses: ["redelegate_to_alternative", "escalate_to_human"],
      });
    }

    // 3. Peer overload
    const rep = this.reputationStore?.getReputation(peer_node_id);
    if (rep && peer) {
      const avgLatency = rep.avg_latency_ms;
      const currentLatency = peer.last_latency_ms;
      if (avgLatency > 0 && currentLatency / avgLatency >= this.config.overload_latency_ratio) {
        evidence.push(`Current latency ${currentLatency}ms vs avg ${avgLatency.toFixed(0)}ms (${(currentLatency / avgLatency).toFixed(1)}x)`);
        const durationSpike = anomaly_reports.some(a => a.type === "duration_spike");
        if (durationSpike) evidence.push("Duration spike detected");
        return this.buildDiagnosis({
          task_id, peer_node_id, evidence,
          root_cause: "peer_overload",
          confidence: durationSpike ? 0.8 : 0.7,
          recommended_response: "redelegate_to_alternative",
          alternative_responses: ["wait_and_retry", "escalate_to_human"],
        });
      }
    }

    // 4. Task complexity mismatch
    if (task_attributes && task_attributes.complexity === "high" && failure_count >= this.config.complexity_mismatch_failures) {
      evidence.push(`High complexity task failed ${failure_count} times`);
      return this.buildDiagnosis({
        task_id, peer_node_id, evidence,
        root_cause: "task_complexity_mismatch",
        confidence: 0.7,
        recommended_response: "decompose_and_redelegate",
        alternative_responses: ["redelegate_to_alternative", "escalate_to_human"],
      });
    }

    // 5. Resource exhaustion
    const costSpike = anomaly_reports.some(a => a.type === "cost_spike");
    if (costSpike) {
      evidence.push("Cost spike anomaly detected");
      return this.buildDiagnosis({
        task_id, peer_node_id, evidence,
        root_cause: "resource_exhaustion",
        confidence: 0.7,
        recommended_response: "escalate_to_human",
        alternative_responses: ["redelegate_to_alternative", "abort_task"],
      });
    }

    // 6. Transient failure
    if (failure_count === 1 && anomaly_reports.length === 0) {
      evidence.push("Single failure with no anomalies");
      return this.buildDiagnosis({
        task_id, peer_node_id, evidence,
        root_cause: "transient_failure",
        confidence: 0.5,
        recommended_response: "redelegate_to_alternative",
        alternative_responses: ["wait_and_retry"],
      });
    }

    // 7. Unknown
    evidence.push(`Failures: ${failure_count}, Anomalies: ${anomaly_reports.length}, Checkpoint misses: ${checkpoint_misses}`);
    return this.buildDiagnosis({
      task_id, peer_node_id, evidence,
      root_cause: "unknown",
      confidence: 0.3,
      recommended_response: "escalate_to_human",
      alternative_responses: ["redelegate_to_alternative", "abort_task"],
    });
  }

  selectResponse(diagnosis: RootCauseDiagnosis, taskAttributes?: TaskAttribute): DiagnosedResponse {
    if (!taskAttributes) return diagnosis.recommended_response;

    // Refine using reversibility
    if (taskAttributes.reversibility === "low") {
      if (diagnosis.root_cause === "malicious_behavior") return "abort_task";
      return "escalate_to_human";
    }

    if (taskAttributes.criticality === "high" && taskAttributes.reversibility !== "high") {
      return "escalate_to_human";
    }

    return diagnosis.recommended_response;
  }

  private buildDiagnosis(params: {
    task_id: string;
    peer_node_id: string;
    root_cause: RootCause;
    confidence: number;
    evidence: string[];
    recommended_response: DiagnosedResponse;
    alternative_responses: DiagnosedResponse[];
  }): RootCauseDiagnosis {
    return {
      task_id: params.task_id,
      peer_node_id: params.peer_node_id,
      root_cause: params.root_cause,
      confidence: params.confidence,
      evidence: params.evidence,
      recommended_response: params.recommended_response,
      alternative_responses: params.alternative_responses,
      diagnosed_at: new Date().toISOString(),
    };
  }
}
