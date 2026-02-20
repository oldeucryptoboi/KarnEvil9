import { describe, it, expect } from "vitest";
import { OutcomeVerifier } from "./outcome-verifier.js";
import { createAttestation } from "./attestation.js";
import { generateEd25519KeyPair, signAttestation } from "./ed25519-signer.js";
import type { SwarmTaskResult, DelegationContract, TaskAttestation } from "./types.js";

const TOKEN = "test-swarm-token";

function makeResult(overrides?: Partial<SwarmTaskResult>): SwarmTaskResult {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    peer_session_id: "session-1",
    status: "completed",
    findings: [{ step_title: "step", tool_name: "read-file", status: "succeeded", summary: "done" }],
    tokens_used: 100,
    cost_usd: 0.01,
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
    task_text: "do something",
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

describe("OutcomeVerifier", () => {
  describe("SLO compliance", () => {
    it("passes when result is within SLO bounds", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult();
      const contract = makeContract();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, contract, attestation: att, swarmToken: TOKEN });
      expect(vr.slo_compliance).toBe(true);
      expect(vr.verified).toBe(true);
    });

    it("fails cost SLO", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult({ cost_usd: 5.0 });
      const contract = makeContract();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, contract, attestation: att, swarmToken: TOKEN });
      expect(vr.slo_compliance).toBe(false);
      expect(vr.issues).toEqual(expect.arrayContaining([expect.stringContaining("Cost")]));
    });

    it("fails tokens SLO", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult({ tokens_used: 5000 });
      const contract = makeContract();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, contract, attestation: att, swarmToken: TOKEN });
      expect(vr.slo_compliance).toBe(false);
      expect(vr.issues).toEqual(expect.arrayContaining([expect.stringContaining("Tokens")]));
    });

    it("fails duration SLO", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult({ duration_ms: 120000 });
      const contract = makeContract();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, contract, attestation: att, swarmToken: TOKEN });
      expect(vr.slo_compliance).toBe(false);
      expect(vr.issues).toEqual(expect.arrayContaining([expect.stringContaining("Duration")]));
    });

    it("passes SLO when slo_strict is false even with violations", () => {
      const verifier = new OutcomeVerifier({ slo_strict: false });
      const result = makeResult({ cost_usd: 5.0 });
      const contract = makeContract();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, contract, attestation: att, swarmToken: TOKEN });
      expect(vr.slo_compliance).toBe(false);
      // verified can still be true since slo_strict is off
      expect(vr.verified).toBe(true);
    });
  });

  describe("attestation verification", () => {
    it("verifies HMAC attestation", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, attestation: att, swarmToken: TOKEN });
      expect(vr.findings_verified).toBe(true);
      expect(vr.verification_method).toBe("attestation");
    });

    it("fails with wrong HMAC token", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, attestation: att, swarmToken: "wrong-token" });
      expect(vr.findings_verified).toBe(false);
      expect(vr.verified).toBe(false);
    });

    it("verifies Ed25519 signature on attestation", () => {
      const verifier = new OutcomeVerifier();
      const kp = generateEd25519KeyPair();
      const result = makeResult();
      const att = createAttestation(result, TOKEN);
      att.ed25519_signature = signAttestation(att, kp.privateKey);
      const vr = verifier.verify({ result, attestation: att, peerPublicKey: kp.publicKey, swarmToken: TOKEN });
      expect(vr.findings_verified).toBe(true);
      expect(vr.verification_method).toBe("attestation");
    });

    it("fails with wrong Ed25519 key", () => {
      const verifier = new OutcomeVerifier();
      const kp1 = generateEd25519KeyPair();
      const kp2 = generateEd25519KeyPair();
      const result = makeResult();
      const att = createAttestation(result, TOKEN);
      att.ed25519_signature = signAttestation(att, kp1.privateKey);
      const vr = verifier.verify({ result, attestation: att, peerPublicKey: kp2.publicKey });
      expect(vr.findings_verified).toBe(false);
    });
  });

  describe("result quality checks", () => {
    it("flags completed task with no findings", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult({ findings: [] });
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, attestation: att, swarmToken: TOKEN });
      expect(vr.issues).toContain("Completed task has no findings");
    });

    it("allows failed task with no findings", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult({ status: "failed", findings: [] });
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, attestation: att, swarmToken: TOKEN });
      // No "Completed task has no findings" issue
      const hasIssue = (vr.issues ?? []).some((i) => i.includes("no findings"));
      expect(hasIssue).toBe(false);
    });

    it("calculates outcome_score based on findings success ratio", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult({
        findings: [
          { step_title: "s1", tool_name: "read-file", status: "succeeded", summary: "ok" },
          { step_title: "s2", tool_name: "read-file", status: "failed", summary: "err" },
        ],
      });
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, attestation: att, swarmToken: TOKEN });
      expect(vr.outcome_score).toBe(0.5);
    });
  });

  describe("capability match", () => {
    it("flags tools not in allowlist", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult({
        findings: [{ step_title: "s", tool_name: "shell-exec-evil", status: "succeeded", summary: "x" }],
      });
      const contract = makeContract();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, contract, attestation: att, swarmToken: TOKEN });
      expect(vr.issues).toEqual(expect.arrayContaining([expect.stringContaining("shell-exec-evil")]));
    });

    it("passes when findings use tools in allowlist", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult();
      const contract = makeContract();
      const att = createAttestation(result, TOKEN);
      const vr = verifier.verify({ result, contract, attestation: att, swarmToken: TOKEN });
      expect(vr.verified).toBe(true);
    });
  });

  describe("direct verification", () => {
    it("falls back to direct when no attestation available", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult();
      const vr = verifier.verify({ result });
      expect(vr.verification_method).toBe("direct");
      expect(vr.findings_verified).toBe(true);
    });

    it("fails direct verification for completed task with no findings and no attestation", () => {
      const verifier = new OutcomeVerifier();
      const result = makeResult({ findings: [] });
      const vr = verifier.verify({ result });
      expect(vr.findings_verified).toBe(false);
    });
  });
});
