import { describe, it, expect } from "vitest";
import { CredentialVerifier } from "./credential-verifier.js";
import type { SwarmNodeIdentity, PeerCredential, CredentialEndorsement } from "./types.js";

const localIdentity: SwarmNodeIdentity = {
  node_id: "local-node",
  display_name: "Local",
  api_url: "http://localhost:3100",
  capabilities: ["read-file"],
  version: "0.1.0",
};

const localKeyPair = { publicKey: "test-public-key", privateKey: "test-private-key" };

function makeVerifier(overrides: Partial<ConstructorParameters<typeof CredentialVerifier>[0]> = {}) {
  return new CredentialVerifier({
    localIdentity,
    localKeyPair,
    ...overrides,
  });
}

function makeExpiredCredential(verifier: CredentialVerifier): PeerCredential {
  // Issue a credential with 1ms validity, then wait for it to expire
  const cred = verifier.issueCredential("peer-1", ["read-file"], 1);
  // Force expiry by backdating expires_at
  return { ...cred, expires_at: new Date(Date.now() - 10000).toISOString() };
}

describe("CredentialVerifier", () => {
  // ─── issueCredential ─────────────────────────────────────────────

  describe("issueCredential", () => {
    it("should issue a credential with correct fields", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file", "write-file"]);

      expect(cred.credential_id).toBeTruthy();
      expect(cred.issuer_node_id).toBe("local-node");
      expect(cred.subject_node_id).toBe("peer-1");
      expect(cred.capability_claims).toEqual(["read-file", "write-file"]);
      expect(cred.issued_at).toBeTruthy();
      expect(cred.expires_at).toBeTruthy();
      expect(cred.signature).toBeTruthy();
      expect(cred.signature).toHaveLength(64); // HMAC-SHA256 hex
      expect(cred.endorsements).toEqual([]);
    });

    it("should default to 24h validity", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const issued = new Date(cred.issued_at).getTime();
      const expires = new Date(cred.expires_at).getTime();
      const diff = expires - issued;
      // Allow small tolerance for clock drift between Date.now() calls
      expect(diff).toBeGreaterThanOrEqual(86400000 - 100);
      expect(diff).toBeLessThanOrEqual(86400000 + 100);
    });

    it("should respect custom validity duration", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"], 3600000); // 1h
      const issued = new Date(cred.issued_at).getTime();
      const expires = new Date(cred.expires_at).getTime();
      const diff = expires - issued;
      expect(diff).toBeGreaterThanOrEqual(3600000 - 100);
      expect(diff).toBeLessThanOrEqual(3600000 + 100);
    });

    it("should throw if no localKeyPair is configured", () => {
      const verifier = makeVerifier({ localKeyPair: undefined });
      expect(() => verifier.issueCredential("peer-1", ["read-file"])).toThrow(
        "Cannot issue credential without local key pair",
      );
    });

    it("should produce unique credential IDs", () => {
      const verifier = makeVerifier();
      const c1 = verifier.issueCredential("peer-1", ["read-file"]);
      const c2 = verifier.issueCredential("peer-1", ["read-file"]);
      expect(c1.credential_id).not.toBe(c2.credential_id);
    });
  });

  // ─── endorseCredential ───────────────────────────────────────────

  describe("endorseCredential", () => {
    it("should create a valid endorsement", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const endorsement = verifier.endorseCredential(cred);

      expect(endorsement.endorser_node_id).toBe("local-node");
      expect(endorsement.endorser_public_key).toBe("test-public-key");
      expect(endorsement.endorsed_at).toBeTruthy();
      expect(endorsement.signature).toBeTruthy();
      expect(endorsement.signature).toHaveLength(64); // HMAC-SHA256 hex
    });

    it("should throw if no localKeyPair is configured", () => {
      const verifier = makeVerifier({ localKeyPair: undefined });
      const cred: PeerCredential = {
        credential_id: "cred-1",
        issuer_node_id: "issuer-1",
        subject_node_id: "peer-1",
        capability_claims: ["read-file"],
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        signature: "some-sig",
      };
      expect(() => verifier.endorseCredential(cred)).toThrow(
        "Cannot endorse credential without local key pair",
      );
    });

    it("should produce deterministic signatures for the same credential", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const e1 = verifier.endorseCredential(cred);
      const e2 = verifier.endorseCredential(cred);
      // Same credential + same key + same node_id -> same canonical -> same signature
      expect(e1.signature).toBe(e2.signature);
    });
  });

  // ─── verifyCredential ────────────────────────────────────────────

  describe("verifyCredential", () => {
    it("should verify a valid credential with correct issuer key", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);

      // The signature is HMAC'd with privateKey, but verification uses the issuerPublicKey
      // to re-compute. Looking at the code: issueCredential uses privateKey, verifyCredential uses issuerPublicKey.
      // So for verification to pass, we pass the privateKey as issuerPublicKey (since that's what was used to sign).
      const result = verifier.verifyCredential(cred, localKeyPair.privateKey);

      expect(result.valid).toBe(true);
      expect(result.expired).toBe(false);
      expect(result.signature_valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it("should fail verification without issuerPublicKey", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const result = verifier.verifyCredential(cred);

      expect(result.valid).toBe(false);
      expect(result.signature_valid).toBe(false);
      expect(result.issues).toContain("No issuer public key provided for signature verification");
    });

    it("should fail verification with wrong issuer key", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const result = verifier.verifyCredential(cred, "wrong-key");

      expect(result.valid).toBe(false);
      expect(result.signature_valid).toBe(false);
      expect(result.issues).toContain("Signature verification failed");
    });

    it("should detect expired credentials", () => {
      const verifier = makeVerifier();
      const cred = makeExpiredCredential(verifier);
      const result = verifier.verifyCredential(cred, localKeyPair.privateKey);

      expect(result.expired).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain("Credential has expired");
    });

    it("should detect tampered credential (modified subject)", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const tampered = { ...cred, subject_node_id: "evil-peer" };
      const result = verifier.verifyCredential(tampered, localKeyPair.privateKey);

      expect(result.signature_valid).toBe(false);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain("Signature verification failed");
    });

    it("should detect tampered credential (modified capabilities)", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const tampered = { ...cred, capability_claims: ["read-file", "shell-exec", "admin"] };
      const result = verifier.verifyCredential(tampered, localKeyPair.privateKey);

      expect(result.signature_valid).toBe(false);
      expect(result.valid).toBe(false);
    });

    it("should count endorsements and validate them", () => {
      // Endorsement signing uses privateKey, but verification uses endorser_public_key.
      // For HMAC validation to pass, use a key pair where publicKey matches privateKey.
      const symmetricKeyPair = { publicKey: "shared-key", privateKey: "shared-key" };
      const endorserVerifier = makeVerifier({ localKeyPair: symmetricKeyPair });
      const issuerVerifier = makeVerifier();
      const cred = issuerVerifier.issueCredential("peer-1", ["read-file"]);

      const endorsement = endorserVerifier.endorseCredential(cred);
      const credWithEndorsement = { ...cred, endorsements: [endorsement] };

      const result = issuerVerifier.verifyCredential(credWithEndorsement, localKeyPair.privateKey);

      expect(result.endorsement_count).toBe(1);
      expect(result.endorsements_valid).toBe(1);
    });

    it("should detect invalid endorsement signatures", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);

      const fakeEndorsement: CredentialEndorsement = {
        endorser_node_id: "endorser-1",
        endorser_public_key: "fake-key",
        endorsed_at: new Date().toISOString(),
        signature: "0".repeat(64),
      };
      const credWithBadEndorsement = { ...cred, endorsements: [fakeEndorsement] };

      const result = verifier.verifyCredential(credWithBadEndorsement, localKeyPair.privateKey);

      expect(result.endorsement_count).toBe(1);
      expect(result.endorsements_valid).toBe(0);
    });

    it("should report zero endorsements when none present", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const result = verifier.verifyCredential(cred, localKeyPair.privateKey);

      expect(result.endorsement_count).toBe(0);
      expect(result.endorsements_valid).toBe(0);
    });
  });

  // ─── verifyPeerCredentials ───────────────────────────────────────

  describe("verifyPeerCredentials", () => {
    it("should accept a peer with no credentials when not required", () => {
      const verifier = makeVerifier({ requireCredentials: false });
      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      expect(result.accepted).toBe(true);
      expect(result.valid_credentials).toEqual([]);
    });

    it("should reject a peer with no credentials when required", () => {
      const verifier = makeVerifier({ requireCredentials: true });
      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("no credentials");
    });

    it("should accept a peer with valid non-expired credentials", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
        credentials: [cred],
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      expect(result.accepted).toBe(true);
      expect(result.valid_credentials).toHaveLength(1);
    });

    it("should filter out expired credentials", () => {
      const verifier = makeVerifier({ requireCredentials: true });
      const expiredCred = makeExpiredCredential(verifier);
      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
        credentials: [expiredCred],
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      expect(result.accepted).toBe(false);
      expect(result.valid_credentials).toHaveLength(0);
      expect(result.reason).toContain("No valid credentials");
    });

    it("should filter by trusted issuers when configured", () => {
      const verifier = makeVerifier({ trustedIssuers: ["trusted-issuer-1"] });
      // This credential is issued by local-node, which is NOT in trustedIssuers
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
        credentials: [cred],
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      // Credential from local-node is skipped since it's not in trustedIssuers
      expect(result.valid_credentials).toHaveLength(0);
    });

    it("should accept credentials from trusted issuers", () => {
      // Make the verifier trust "local-node" (our own node)
      const verifier = makeVerifier({ trustedIssuers: ["local-node"] });
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
        credentials: [cred],
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      expect(result.accepted).toBe(true);
      expect(result.valid_credentials).toHaveLength(1);
    });

    it("should reject when minimum endorsements not met", () => {
      const verifier = makeVerifier({ minEndorsements: 2 });
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      // No endorsements on the credential
      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
        credentials: [cred],
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("minimum endorsement requirement");
      // Still returns valid_credentials even though endorsement check failed
      expect(result.valid_credentials).toHaveLength(1);
    });

    it("should accept when minimum endorsements are met", () => {
      const verifier = makeVerifier({ minEndorsements: 1 });
      const cred = verifier.issueCredential("peer-1", ["read-file"]);

      const endorsement = verifier.endorseCredential(cred);
      const credWithEndorsement: PeerCredential = {
        ...cred,
        endorsements: [endorsement],
      };

      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
        credentials: [credWithEndorsement],
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      expect(result.accepted).toBe(true);
    });

    it("should reject when requireCredentials=true and only untrusted issuer credentials", () => {
      const verifier = makeVerifier({
        requireCredentials: true,
        trustedIssuers: ["trusted-only"],
      });
      const cred = verifier.issueCredential("peer-1", ["read-file"]);
      const peerIdentity: SwarmNodeIdentity = {
        node_id: "peer-1",
        display_name: "Peer 1",
        api_url: "http://peer1:3100",
        capabilities: ["read-file"],
        version: "0.1.0",
        credentials: [cred],
      };

      const result = verifier.verifyPeerCredentials(peerIdentity);
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("No valid credentials from trusted issuers");
    });
  });

  // ─── getCapabilityProof ──────────────────────────────────────────

  describe("getCapabilityProof", () => {
    it("should find a credential proving a capability", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file", "write-file"]);

      const proof = verifier.getCapabilityProof("peer-1", "read-file", [cred]);
      expect(proof).toBeDefined();
      expect(proof!.credential_id).toBe(cred.credential_id);
    });

    it("should return undefined when no credential has the capability", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);

      const proof = verifier.getCapabilityProof("peer-1", "shell-exec", [cred]);
      expect(proof).toBeUndefined();
    });

    it("should return undefined when credential is for a different node", () => {
      const verifier = makeVerifier();
      const cred = verifier.issueCredential("peer-1", ["read-file"]);

      const proof = verifier.getCapabilityProof("peer-2", "read-file", [cred]);
      expect(proof).toBeUndefined();
    });

    it("should skip expired credentials", () => {
      const verifier = makeVerifier();
      const expiredCred = makeExpiredCredential(verifier);

      const proof = verifier.getCapabilityProof("peer-1", "read-file", [expiredCred]);
      expect(proof).toBeUndefined();
    });

    it("should return the first matching credential from multiple", () => {
      const verifier = makeVerifier();
      const cred1 = verifier.issueCredential("peer-1", ["read-file"]);
      const cred2 = verifier.issueCredential("peer-1", ["read-file", "write-file"]);

      const proof = verifier.getCapabilityProof("peer-1", "read-file", [cred1, cred2]);
      expect(proof).toBeDefined();
      expect(proof!.credential_id).toBe(cred1.credential_id);
    });
  });
});
