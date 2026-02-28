import { describe, it, expect, vi, beforeEach } from "vitest";
import { RootCauseAnalyzer, } from "./root-cause-analyzer.js";
import type { MeshManager } from "./mesh-manager.js";
import type { ReputationStore } from "./reputation-store.js";
import type { AnomalyReport, PeerEntry, PeerReputation, TaskAttribute } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function makePeerEntry(overrides?: Partial<PeerEntry>): PeerEntry {
  return {
    identity: {
      node_id: "peer-1",
      display_name: "Peer One",
      api_url: "http://peer-1:3000",
      capabilities: ["read-file"],
      version: "0.1.0",
    },
    status: "active",
    last_heartbeat_at: new Date().toISOString(),
    last_latency_ms: 100,
    consecutive_failures: 0,
    joined_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeReputation(overrides?: Partial<PeerReputation>): PeerReputation {
  return {
    node_id: "peer-1",
    tasks_completed: 10,
    tasks_failed: 1,
    tasks_aborted: 0,
    total_duration_ms: 50000,
    total_tokens_used: 5000,
    total_cost_usd: 5.0,
    avg_latency_ms: 100,
    consecutive_successes: 5,
    consecutive_failures: 0,
    last_outcome_at: new Date().toISOString(),
    trust_score: 0.8,
    ...overrides,
  };
}

function makeAnomaly(overrides?: Partial<AnomalyReport>): AnomalyReport {
  return {
    anomaly_id: "anom-1",
    task_id: "task-1",
    peer_node_id: "peer-1",
    type: "suspicious_findings",
    severity: "high",
    description: "Suspicious behavior detected",
    evidence: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskAttributes(overrides?: Partial<TaskAttribute>): TaskAttribute {
  return {
    complexity: "medium",
    criticality: "medium",
    verifiability: "medium",
    reversibility: "medium",
    estimated_cost: "medium",
    estimated_duration: "medium",
    required_capabilities: [],
    ...overrides,
  };
}

function createMocks() {
  const mockMeshManager = {
    getPeer: vi.fn(),
  } as unknown as MeshManager;

  const mockReputationStore = {
    getReputation: vi.fn(),
  } as unknown as ReputationStore;

  return { mockMeshManager, mockReputationStore };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("RootCauseAnalyzer", () => {
  let mockMeshManager: MeshManager;
  let mockReputationStore: ReputationStore;
  let analyzer: RootCauseAnalyzer;

  beforeEach(() => {
    const mocks = createMocks();
    mockMeshManager = mocks.mockMeshManager;
    mockReputationStore = mocks.mockReputationStore;
    analyzer = new RootCauseAnalyzer({
      meshManager: mockMeshManager,
      reputationStore: mockReputationStore,
    });
  });

  describe("constructor", () => {
    it("uses default config when none provided", () => {
      const a = new RootCauseAnalyzer({ meshManager: mockMeshManager });
      // Verify it works with defaults by exercising a diagnosis
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(undefined);
      const result = a.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      expect(result.root_cause).toBe("transient_failure");
    });

    it("merges partial config with defaults", () => {
      const a = new RootCauseAnalyzer({
        meshManager: mockMeshManager,
        config: { malicious_anomaly_count: 5 },
      });
      // With count threshold raised to 5, two anomalies should NOT trigger malicious
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(undefined);
      const result = a.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [
          makeAnomaly({ type: "suspicious_findings" }),
          makeAnomaly({ type: "data_access_violation", anomaly_id: "anom-2" }),
        ],
        failure_count: 0,
      });
      expect(result.root_cause).not.toBe("malicious_behavior");
    });
  });

  describe("diagnose", () => {
    // ─── Priority 1: Malicious behavior ─────────────────────────────

    it("diagnoses malicious_behavior with 2+ suspicious/violation anomalies", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [
          makeAnomaly({ type: "suspicious_findings", anomaly_id: "anom-1" }),
          makeAnomaly({ type: "data_access_violation", anomaly_id: "anom-2" }),
        ],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("malicious_behavior");
      expect(result.confidence).toBe(0.9);
      expect(result.recommended_response).toBe("quarantine_and_redelegate");
      expect(result.alternative_responses).toContain("abort_task");
      expect(result.alternative_responses).toContain("escalate_to_human");
      expect(result.evidence.length).toBe(2);
      expect(result.task_id).toBe("task-1");
      expect(result.peer_node_id).toBe("peer-1");
      expect(result.diagnosed_at).toBeDefined();
    });

    it("diagnoses malicious_behavior with only data_access_violation anomalies", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      const result = analyzer.diagnose({
        task_id: "task-2",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [
          makeAnomaly({ type: "data_access_violation", anomaly_id: "anom-1" }),
          makeAnomaly({ type: "data_access_violation", anomaly_id: "anom-2" }),
          makeAnomaly({ type: "data_access_violation", anomaly_id: "anom-3" }),
        ],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("malicious_behavior");
      expect(result.confidence).toBe(0.9);
    });

    it("does not diagnose malicious with only 1 suspicious anomaly", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [
          makeAnomaly({ type: "suspicious_findings" }),
        ],
        failure_count: 1,
      });
      expect(result.root_cause).not.toBe("malicious_behavior");
    });

    it("malicious takes priority over all other diagnoses", () => {
      // Set up conditions that would match network_partition and peer_overload too
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "unreachable", last_latency_ms: 9000 })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(
        makeReputation({ avg_latency_ms: 100 })
      );
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 10,
        anomaly_reports: [
          makeAnomaly({ type: "suspicious_findings", anomaly_id: "anom-1" }),
          makeAnomaly({ type: "data_access_violation", anomaly_id: "anom-2" }),
          makeAnomaly({ type: "cost_spike", anomaly_id: "anom-3" }),
        ],
        failure_count: 5,
        task_attributes: makeTaskAttributes({ complexity: "high" }),
      });
      expect(result.root_cause).toBe("malicious_behavior");
    });

    // ─── Priority 2: Network partition ──────────────────────────────

    it("diagnoses network_partition when peer is suspected with enough checkpoint misses", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "suspected" })
      );
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 3,
        anomaly_reports: [],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("network_partition");
      expect(result.confidence).toBe(0.7);
      expect(result.recommended_response).toBe("wait_and_retry");
      expect(result.evidence).toContain("Peer status: suspected");
      expect(result.evidence).toContain("Checkpoint misses: 3");
    });

    it("diagnoses network_partition when peer is unreachable", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "unreachable" })
      );
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 5,
        anomaly_reports: [],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("network_partition");
      expect(result.evidence).toContain("Peer status: unreachable");
    });

    it("does not diagnose network_partition when peer is active", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "active" })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 10,
        anomaly_reports: [],
        failure_count: 1,
      });
      expect(result.root_cause).not.toBe("network_partition");
    });

    it("does not diagnose network_partition with insufficient checkpoint misses", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "suspected" })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 2,
        anomaly_reports: [],
        failure_count: 1,
      });
      expect(result.root_cause).not.toBe("network_partition");
    });

    // ─── Priority 3: Peer overload ──────────────────────────────────

    it("diagnoses peer_overload when latency ratio >= 3.0", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "active", last_latency_ms: 300 })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(
        makeReputation({ avg_latency_ms: 100 })
      );
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("peer_overload");
      expect(result.confidence).toBe(0.7);
      expect(result.recommended_response).toBe("redelegate_to_alternative");
    });

    it("increases peer_overload confidence to 0.8 with duration_spike anomaly", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "active", last_latency_ms: 500 })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(
        makeReputation({ avg_latency_ms: 100 })
      );
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [
          makeAnomaly({ type: "duration_spike", anomaly_id: "anom-1" }),
        ],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("peer_overload");
      expect(result.confidence).toBe(0.8);
      expect(result.evidence.some(e => e.includes("Duration spike"))).toBe(true);
    });

    it("does not diagnose peer_overload when latency ratio < 3.0", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "active", last_latency_ms: 200 })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(
        makeReputation({ avg_latency_ms: 100 })
      );
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      expect(result.root_cause).not.toBe("peer_overload");
    });

    it("does not diagnose peer_overload without reputation store", () => {
      const analyzerNoRep = new RootCauseAnalyzer({ meshManager: mockMeshManager });
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "active", last_latency_ms: 500 })
      );
      const result = analyzerNoRep.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      expect(result.root_cause).not.toBe("peer_overload");
    });

    it("does not diagnose peer_overload when avg_latency_ms is 0", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "active", last_latency_ms: 500 })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(
        makeReputation({ avg_latency_ms: 0 })
      );
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      expect(result.root_cause).not.toBe("peer_overload");
    });

    // ─── Priority 4: Task complexity mismatch ───────────────────────

    it("diagnoses task_complexity_mismatch with high complexity and enough failures", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 2,
        task_attributes: makeTaskAttributes({ complexity: "high" }),
      });
      expect(result.root_cause).toBe("task_complexity_mismatch");
      expect(result.confidence).toBe(0.7);
      expect(result.recommended_response).toBe("decompose_and_redelegate");
      expect(result.evidence[0]).toContain("High complexity task failed 2 times");
    });

    it("does not diagnose complexity mismatch for medium complexity", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 5,
        task_attributes: makeTaskAttributes({ complexity: "medium" }),
      });
      expect(result.root_cause).not.toBe("task_complexity_mismatch");
    });

    it("does not diagnose complexity mismatch with insufficient failures", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
        task_attributes: makeTaskAttributes({ complexity: "high" }),
      });
      expect(result.root_cause).not.toBe("task_complexity_mismatch");
    });

    // ─── Priority 5: Resource exhaustion ────────────────────────────

    it("diagnoses resource_exhaustion on cost_spike anomaly", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [
          makeAnomaly({ type: "cost_spike", anomaly_id: "anom-cost" }),
        ],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("resource_exhaustion");
      expect(result.confidence).toBe(0.7);
      expect(result.recommended_response).toBe("escalate_to_human");
      expect(result.alternative_responses).toContain("redelegate_to_alternative");
      expect(result.alternative_responses).toContain("abort_task");
    });

    // ─── Priority 6: Transient failure ──────────────────────────────

    it("diagnoses transient_failure for single failure with no anomalies", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      expect(result.root_cause).toBe("transient_failure");
      expect(result.confidence).toBe(0.5);
      expect(result.recommended_response).toBe("redelegate_to_alternative");
      expect(result.alternative_responses).toContain("wait_and_retry");
      expect(result.evidence[0]).toBe("Single failure with no anomalies");
    });

    it("does not diagnose transient_failure for multiple failures", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 2,
      });
      expect(result.root_cause).not.toBe("transient_failure");
    });

    // ─── Priority 7: Unknown ────────────────────────────────────────

    it("diagnoses unknown when no other conditions match", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 1,
        anomaly_reports: [],
        failure_count: 3,
      });
      expect(result.root_cause).toBe("unknown");
      expect(result.confidence).toBe(0.3);
      expect(result.recommended_response).toBe("escalate_to_human");
      expect(result.alternative_responses).toContain("redelegate_to_alternative");
      expect(result.alternative_responses).toContain("abort_task");
      expect(result.evidence[0]).toContain("Failures: 3");
      expect(result.evidence[0]).toContain("Anomalies: 0");
      expect(result.evidence[0]).toContain("Checkpoint misses: 1");
    });

    it("diagnoses unknown when peer is not found and no anomalies with multiple failures", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(undefined);
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-unknown",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 4,
      });
      expect(result.root_cause).toBe("unknown");
      expect(result.peer_node_id).toBe("peer-unknown");
    });

    // ─── diagnosed_at field ─────────────────────────────────────────

    it("includes a valid ISO timestamp in diagnosed_at", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      const result = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      const parsed = new Date(result.diagnosed_at);
      expect(parsed.getTime()).not.toBeNaN();
    });
  });

  describe("selectResponse", () => {
    it("returns recommended_response when no taskAttributes provided", () => {
      const diagnosis = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      const response = analyzer.selectResponse(diagnosis);
      expect(response).toBe(diagnosis.recommended_response);
    });

    it("returns abort_task for low reversibility + malicious behavior", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      const diagnosis = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [
          makeAnomaly({ type: "suspicious_findings", anomaly_id: "anom-1" }),
          makeAnomaly({ type: "data_access_violation", anomaly_id: "anom-2" }),
        ],
        failure_count: 0,
      });
      expect(diagnosis.root_cause).toBe("malicious_behavior");
      const response = analyzer.selectResponse(
        diagnosis,
        makeTaskAttributes({ reversibility: "low" })
      );
      expect(response).toBe("abort_task");
    });

    it("returns escalate_to_human for low reversibility + non-malicious cause", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const diagnosis = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      expect(diagnosis.root_cause).toBe("transient_failure");
      const response = analyzer.selectResponse(
        diagnosis,
        makeTaskAttributes({ reversibility: "low" })
      );
      expect(response).toBe("escalate_to_human");
    });

    it("returns escalate_to_human for high criticality + medium reversibility", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const diagnosis = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      const response = analyzer.selectResponse(
        diagnosis,
        makeTaskAttributes({ criticality: "high", reversibility: "medium" })
      );
      expect(response).toBe("escalate_to_human");
    });

    it("returns recommended_response for high criticality + high reversibility", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const diagnosis = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      const response = analyzer.selectResponse(
        diagnosis,
        makeTaskAttributes({ criticality: "high", reversibility: "high" })
      );
      expect(response).toBe(diagnosis.recommended_response);
    });

    it("returns recommended_response for medium criticality + high reversibility", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "active", last_latency_ms: 500 })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(
        makeReputation({ avg_latency_ms: 100 })
      );
      const diagnosis = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 0,
      });
      expect(diagnosis.root_cause).toBe("peer_overload");
      const response = analyzer.selectResponse(
        diagnosis,
        makeTaskAttributes({ criticality: "medium", reversibility: "high" })
      );
      expect(response).toBe("redelegate_to_alternative");
    });

    it("low reversibility overrides high criticality path (checked first)", () => {
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(makePeerEntry());
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(makeReputation());
      const diagnosis = analyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 1,
      });
      // Both low reversibility and high criticality -- low reversibility takes priority
      const response = analyzer.selectResponse(
        diagnosis,
        makeTaskAttributes({ criticality: "high", reversibility: "low" })
      );
      expect(response).toBe("escalate_to_human");
    });
  });

  describe("custom config", () => {
    it("respects custom partition_miss_threshold", () => {
      const customAnalyzer = new RootCauseAnalyzer({
        meshManager: mockMeshManager,
        config: { partition_miss_threshold: 1 },
      });
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "suspected" })
      );
      const result = customAnalyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 1,
        anomaly_reports: [],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("network_partition");
    });

    it("respects custom overload_latency_ratio", () => {
      const customAnalyzer = new RootCauseAnalyzer({
        meshManager: mockMeshManager,
        reputationStore: mockReputationStore,
        config: { overload_latency_ratio: 2.0 },
      });
      vi.mocked(mockMeshManager.getPeer).mockReturnValue(
        makePeerEntry({ status: "active", last_latency_ms: 200 })
      );
      vi.mocked(mockReputationStore.getReputation).mockReturnValue(
        makeReputation({ avg_latency_ms: 100 })
      );
      const result = customAnalyzer.diagnose({
        task_id: "task-1",
        peer_node_id: "peer-1",
        checkpoint_misses: 0,
        anomaly_reports: [],
        failure_count: 0,
      });
      expect(result.root_cause).toBe("peer_overload");
    });
  });
});
