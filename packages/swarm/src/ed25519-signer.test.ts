import { describe, it, expect } from "vitest";
import {
  generateEd25519KeyPair,
  signResult,
  verifyResultSignature,
  signAttestation,
  verifyAttestationSignature,
} from "./ed25519-signer.js";
import type { SwarmTaskResult, TaskAttestation } from "./types.js";

function makeResult(overrides?: Partial<SwarmTaskResult>): SwarmTaskResult {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    peer_session_id: "session-1",
    status: "completed",
    findings: [{ step_title: "step", tool_name: "tool", status: "succeeded", summary: "done" }],
    tokens_used: 100,
    cost_usd: 0.01,
    duration_ms: 5000,
    ...overrides,
  };
}

function makeAttestation(overrides?: Partial<TaskAttestation>): TaskAttestation {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    status: "completed",
    findings_hash: "abc123",
    timestamp: "2026-01-01T00:00:00.000Z",
    hmac: "hmac-value",
    ...overrides,
  };
}

describe("Ed25519 Signer", () => {
  describe("generateEd25519KeyPair", () => {
    it("generates a key pair with hex-encoded public and private keys", () => {
      const kp = generateEd25519KeyPair();
      expect(kp.publicKey).toBeTruthy();
      expect(kp.privateKey).toBeTruthy();
      expect(typeof kp.publicKey).toBe("string");
      expect(typeof kp.privateKey).toBe("string");
      // Hex-encoded keys should only contain hex characters
      expect(kp.publicKey).toMatch(/^[0-9a-f]+$/);
      expect(kp.privateKey).toMatch(/^[0-9a-f]+$/);
    });

    it("generates unique key pairs each time", () => {
      const kp1 = generateEd25519KeyPair();
      const kp2 = generateEd25519KeyPair();
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
      expect(kp1.privateKey).not.toBe(kp2.privateKey);
    });
  });

  describe("signResult / verifyResultSignature", () => {
    it("sign and verify round-trip succeeds", () => {
      const kp = generateEd25519KeyPair();
      const result = makeResult();
      const sig = signResult(result, kp.privateKey);
      expect(typeof sig).toBe("string");
      expect(sig.length).toBeGreaterThan(0);
      expect(verifyResultSignature(result, sig, kp.publicKey)).toBe(true);
    });

    it("detects tampered task_id", () => {
      const kp = generateEd25519KeyPair();
      const result = makeResult();
      const sig = signResult(result, kp.privateKey);
      const tampered = makeResult({ task_id: "tampered" });
      expect(verifyResultSignature(tampered, sig, kp.publicKey)).toBe(false);
    });

    it("detects tampered findings", () => {
      const kp = generateEd25519KeyPair();
      const result = makeResult();
      const sig = signResult(result, kp.privateKey);
      const tampered = makeResult({
        findings: [{ step_title: "evil", tool_name: "hack", status: "succeeded", summary: "owned" }],
      });
      expect(verifyResultSignature(tampered, sig, kp.publicKey)).toBe(false);
    });

    it("rejects with wrong public key", () => {
      const kp1 = generateEd25519KeyPair();
      const kp2 = generateEd25519KeyPair();
      const result = makeResult();
      const sig = signResult(result, kp1.privateKey);
      expect(verifyResultSignature(result, sig, kp2.publicKey)).toBe(false);
    });

    it("returns false for invalid signature hex", () => {
      const kp = generateEd25519KeyPair();
      const result = makeResult();
      expect(verifyResultSignature(result, "not-valid-hex", kp.publicKey)).toBe(false);
    });

    it("produces deterministic signatures for same input and key", () => {
      const kp = generateEd25519KeyPair();
      const result = makeResult();
      const sig1 = signResult(result, kp.privateKey);
      const sig2 = signResult(result, kp.privateKey);
      // Ed25519 is deterministic
      expect(sig1).toBe(sig2);
    });
  });

  describe("signAttestation / verifyAttestationSignature", () => {
    it("sign and verify round-trip succeeds", () => {
      const kp = generateEd25519KeyPair();
      const att = makeAttestation();
      const sig = signAttestation(att, kp.privateKey);
      expect(verifyAttestationSignature(att, sig, kp.publicKey)).toBe(true);
    });

    it("detects tampered attestation fields", () => {
      const kp = generateEd25519KeyPair();
      const att = makeAttestation();
      const sig = signAttestation(att, kp.privateKey);
      const tampered = makeAttestation({ task_id: "TAMPERED" });
      expect(verifyAttestationSignature(tampered, sig, kp.publicKey)).toBe(false);
    });

    it("detects tampered findings_hash", () => {
      const kp = generateEd25519KeyPair();
      const att = makeAttestation();
      const sig = signAttestation(att, kp.privateKey);
      const tampered = makeAttestation({ findings_hash: "tampered-hash" });
      expect(verifyAttestationSignature(tampered, sig, kp.publicKey)).toBe(false);
    });

    it("rejects with wrong key", () => {
      const kp1 = generateEd25519KeyPair();
      const kp2 = generateEd25519KeyPair();
      const att = makeAttestation();
      const sig = signAttestation(att, kp1.privateKey);
      expect(verifyAttestationSignature(att, sig, kp2.publicKey)).toBe(false);
    });

    it("returns false for invalid public key", () => {
      const att = makeAttestation();
      expect(verifyAttestationSignature(att, "deadbeef", "invalid-key")).toBe(false);
    });
  });
});
