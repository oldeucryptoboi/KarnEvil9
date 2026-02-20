import { describe, it, expect, beforeEach } from "vitest";
import { AnomalyDetector } from "./anomaly-detector.js";
import type { SwarmTaskResult, DelegationContract, PeerReputation } from "./types.js";

function makeResult(overrides?: Partial<SwarmTaskResult>): SwarmTaskResult {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    peer_session_id: "session-1",
    status: "completed",
    findings: [{ step_title: "step", tool_name: "read-file", status: "succeeded", summary: "done" }],
    tokens_used: 100,
    cost_usd: 0.5,
    duration_ms: 5000,
    ...overrides,
  };
}

function makeContract(overrides?: Partial<DelegationContract>): DelegationContract {
  return {
    contract_id: "contract-1",
    delegator_node_id: "delegator-1",
    delegatee_node_id: "peer-1",
    task_id: "task-1",
    task_text: "test task",
    slo: {
      max_duration_ms: 60000,
      max_tokens: 1000,
      max_cost_usd: 1.0,
    },
    permission_boundary: {
      tool_allowlist: ["read-file", "shell-exec"],
    },
    monitoring: { require_checkpoints: false },
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeReputation(overrides?: Partial<PeerReputation>): PeerReputation {
  return {
    node_id: "peer-1",
    tasks_completed: 8,
    tasks_failed: 2,
    tasks_aborted: 0,
    total_duration_ms: 50000,
    total_tokens_used: 5000,
    total_cost_usd: 5.0,
    avg_latency_ms: 5000,
    consecutive_successes: 3,
    consecutive_failures: 0,
    last_outcome_at: "2026-01-01T00:00:00.000Z",
    trust_score: 0.7,
    ...overrides,
  };
}

describe("AnomalyDetector", () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    detector = new AnomalyDetector();
  });

  describe("cost spike", () => {
    it("detects cost spike above threshold", () => {
      const result = makeResult({ cost_usd: 2.0 });
      const contract = makeContract();
      const reports = detector.analyzeResult({ result, contract });
      expect(reports).toHaveLength(1);
      expect(reports[0]!.type).toBe("cost_spike");
      expect(reports[0]!.severity).toBe("high");
    });

    it("detects critical cost spike above 3x", () => {
      const result = makeResult({ cost_usd: 4.0 });
      const contract = makeContract();
      const reports = detector.analyzeResult({ result, contract });
      const costReport = reports.find((r) => r.type === "cost_spike");
      expect(costReport).toBeTruthy();
      expect(costReport!.severity).toBe("critical");
    });

    it("does not flag cost within threshold", () => {
      const result = makeResult({ cost_usd: 1.2 });
      const contract = makeContract();
      const reports = detector.analyzeResult({ result, contract });
      expect(reports.filter((r) => r.type === "cost_spike")).toHaveLength(0);
    });
  });

  describe("duration spike", () => {
    it("detects duration spike above threshold", () => {
      const result = makeResult({ duration_ms: 150000 });
      const contract = makeContract();
      const reports = detector.analyzeResult({ result, contract });
      const durationReport = reports.find((r) => r.type === "duration_spike");
      expect(durationReport).toBeTruthy();
      expect(durationReport!.severity).toBe("high");
    });

    it("detects critical duration spike above 4x", () => {
      const result = makeResult({ duration_ms: 300000 });
      const contract = makeContract();
      const reports = detector.analyzeResult({ result, contract });
      const durationReport = reports.find((r) => r.type === "duration_spike");
      expect(durationReport).toBeTruthy();
      expect(durationReport!.severity).toBe("critical");
    });
  });

  describe("suspicious findings", () => {
    it("detects tools not in allowlist", () => {
      const result = makeResult({
        findings: [{ step_title: "s", tool_name: "dangerous-tool", status: "succeeded", summary: "x" }],
      });
      const contract = makeContract();
      const reports = detector.analyzeResult({ result, contract });
      const suspReport = reports.find((r) => r.type === "suspicious_findings");
      expect(suspReport).toBeTruthy();
      expect(suspReport!.description).toContain("dangerous-tool");
    });

    it("does not flag tools in allowlist", () => {
      const result = makeResult({
        findings: [{ step_title: "s", tool_name: "read-file", status: "succeeded", summary: "x" }],
      });
      const contract = makeContract();
      const reports = detector.analyzeResult({ result, contract });
      expect(reports.filter((r) => r.type === "suspicious_findings")).toHaveLength(0);
    });
  });

  describe("capability mismatch", () => {
    it("detects peer using tools outside its capabilities", () => {
      const result = makeResult({
        findings: [{ step_title: "s", tool_name: "browser", status: "succeeded", summary: "x" }],
      });
      const reports = detector.analyzeResult({
        result,
        peerCapabilities: ["read-file", "shell-exec"],
      });
      const capReport = reports.find((r) => r.type === "capability_mismatch");
      expect(capReport).toBeTruthy();
      expect(capReport!.description).toContain("browser");
    });

    it("does not flag tools within capabilities", () => {
      const result = makeResult();
      const reports = detector.analyzeResult({
        result,
        peerCapabilities: ["read-file"],
      });
      expect(reports.filter((r) => r.type === "capability_mismatch")).toHaveLength(0);
    });
  });

  describe("repeated failures", () => {
    it("detects high failure rate", () => {
      const rep = makeReputation({ tasks_completed: 2, tasks_failed: 6, tasks_aborted: 2 });
      const result = makeResult();
      const reports = detector.analyzeResult({ result, peerReputation: rep });
      const failReport = reports.find((r) => r.type === "repeated_failures");
      expect(failReport).toBeTruthy();
    });

    it("marks critical severity for 80%+ failure rate", () => {
      const rep = makeReputation({ tasks_completed: 1, tasks_failed: 8, tasks_aborted: 1 });
      const result = makeResult();
      const reports = detector.analyzeResult({ result, peerReputation: rep });
      const failReport = reports.find((r) => r.type === "repeated_failures");
      expect(failReport!.severity).toBe("critical");
    });

    it("does not flag acceptable failure rate", () => {
      const rep = makeReputation({ tasks_completed: 8, tasks_failed: 1, tasks_aborted: 1 });
      const result = makeResult();
      const reports = detector.analyzeResult({ result, peerReputation: rep });
      expect(reports.filter((r) => r.type === "repeated_failures")).toHaveLength(0);
    });
  });

  describe("quarantine", () => {
    it("auto-quarantines on critical anomaly", () => {
      const result = makeResult({ cost_usd: 4.0 }); // 4x > 3x threshold = critical
      const contract = makeContract();
      detector.analyzeResult({ result, contract });
      expect(detector.isQuarantined("peer-1")).toBe(true);
    });

    it("manual quarantine and unquarantine", () => {
      detector.quarantinePeer("peer-x");
      expect(detector.isQuarantined("peer-x")).toBe(true);
      detector.unquarantinePeer("peer-x");
      expect(detector.isQuarantined("peer-x")).toBe(false);
    });

    it("getQuarantinedPeers returns all quarantined", () => {
      detector.quarantinePeer("a");
      detector.quarantinePeer("b");
      const peers = detector.getQuarantinedPeers();
      expect(peers.size).toBe(2);
      expect(peers.has("a")).toBe(true);
      expect(peers.has("b")).toBe(true);
    });
  });

  describe("analyzeCheckpoint", () => {
    it("detects duration spike in running task", () => {
      const contract = makeContract();
      const reports = detector.analyzeCheckpoint({
        checkpoint: { task_id: "task-1", status: "running", last_activity_at: "" },
        contract,
        elapsed_ms: 200000, // 200s > 2x SLO 60s
      });
      expect(reports).toHaveLength(1);
      expect(reports[0]!.type).toBe("duration_spike");
    });

    it("does not flag if within threshold", () => {
      const contract = makeContract();
      const reports = detector.analyzeCheckpoint({
        checkpoint: { task_id: "task-1", status: "running", last_activity_at: "" },
        contract,
        elapsed_ms: 50000,
      });
      expect(reports).toHaveLength(0);
    });
  });

  describe("clean results", () => {
    it("returns empty array for clean result", () => {
      const result = makeResult();
      const contract = makeContract();
      const reports = detector.analyzeResult({ result, contract });
      expect(reports).toHaveLength(0);
    });

    it("returns empty array when no contract provided", () => {
      const result = makeResult();
      const reports = detector.analyzeResult({ result });
      expect(reports).toHaveLength(0);
    });
  });

  describe("getRecentReports", () => {
    it("accumulates reports across calls", () => {
      const result1 = makeResult({ cost_usd: 2.0 });
      const result2 = makeResult({ cost_usd: 3.0, task_id: "task-2" });
      const contract = makeContract();
      detector.analyzeResult({ result: result1, contract });
      detector.analyzeResult({ result: result2, contract });
      expect(detector.getRecentReports().length).toBeGreaterThanOrEqual(2);
    });
  });
});
