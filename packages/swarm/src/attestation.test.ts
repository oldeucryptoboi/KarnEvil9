import { describe, it, expect } from "vitest";
import { createAttestation, verifyAttestation } from "./attestation.js";
import type { SwarmTaskResult, TaskAttestation } from "./types.js";

function makeResult(overrides: Partial<SwarmTaskResult> = {}): SwarmTaskResult {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    peer_session_id: "session-1",
    status: "completed",
    findings: [
      { step_title: "step1", tool_name: "read-file", status: "succeeded", summary: "read data" },
    ],
    tokens_used: 100,
    cost_usd: 0.01,
    duration_ms: 5000,
    ...overrides,
  };
}

const TOKEN = "test-swarm-token-secret";

describe("Attestation", () => {
  it("should create a valid attestation", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    expect(attestation.task_id).toBe("task-1");
    expect(attestation.peer_node_id).toBe("peer-1");
    expect(attestation.status).toBe("completed");
    expect(attestation.findings_hash).toBeTruthy();
    expect(attestation.findings_hash).toHaveLength(64); // SHA-256 hex
    expect(attestation.timestamp).toBeTruthy();
    expect(attestation.hmac).toBeTruthy();
    expect(attestation.hmac).toHaveLength(64); // HMAC-SHA256 hex
  });

  it("should verify a valid attestation", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    expect(verifyAttestation(attestation, TOKEN)).toBe(true);
  });

  it("should reject attestation with wrong token", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    expect(verifyAttestation(attestation, "wrong-token")).toBe(false);
  });

  it("should reject attestation with tampered task_id", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    const tampered: TaskAttestation = { ...attestation, task_id: "task-TAMPERED" };
    expect(verifyAttestation(tampered, TOKEN)).toBe(false);
  });

  it("should reject attestation with tampered peer_node_id", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    const tampered: TaskAttestation = { ...attestation, peer_node_id: "evil-peer" };
    expect(verifyAttestation(tampered, TOKEN)).toBe(false);
  });

  it("should reject attestation with tampered status", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    const _tampered: TaskAttestation = { ...attestation, status: "completed" };
    // Only tampered if status was actually different
    const tampered2: TaskAttestation = { ...attestation, status: "failed" };
    expect(verifyAttestation(tampered2, TOKEN)).toBe(false);
  });

  it("should reject attestation with tampered findings_hash", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    const tampered: TaskAttestation = { ...attestation, findings_hash: "a".repeat(64) };
    expect(verifyAttestation(tampered, TOKEN)).toBe(false);
  });

  it("should reject attestation with tampered timestamp", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    const tampered: TaskAttestation = { ...attestation, timestamp: "2020-01-01T00:00:00.000Z" };
    expect(verifyAttestation(tampered, TOKEN)).toBe(false);
  });

  it("should reject attestation with tampered hmac", () => {
    const result = makeResult();
    const attestation = createAttestation(result, TOKEN);
    const tampered: TaskAttestation = { ...attestation, hmac: "b".repeat(64) };
    expect(verifyAttestation(tampered, TOKEN)).toBe(false);
  });

  it("should produce different findings_hash for different findings", () => {
    const a1 = createAttestation(makeResult(), TOKEN);
    const a2 = createAttestation(makeResult({ findings: [] }), TOKEN);
    expect(a1.findings_hash).not.toBe(a2.findings_hash);
  });

  it("should handle empty findings", () => {
    const result = makeResult({ findings: [] });
    const attestation = createAttestation(result, TOKEN);
    expect(verifyAttestation(attestation, TOKEN)).toBe(true);
  });

  it("should produce consistent findings_hash for same data", () => {
    const result = makeResult();
    const a1 = createAttestation(result, TOKEN);
    const a2 = createAttestation(result, TOKEN);
    expect(a1.findings_hash).toBe(a2.findings_hash);
  });
});
