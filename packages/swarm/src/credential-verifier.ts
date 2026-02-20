import { createHmac, randomUUID } from "node:crypto";
import type {
  PeerCredential,
  CredentialEndorsement,
  CredentialVerificationResult,
  SwarmNodeIdentity,
  Ed25519KeyPair,
} from "./types.js";
import { signAttestation, verifyAttestationSignature } from "./ed25519-signer.js";

export interface CredentialVerifierConfig {
  localIdentity: SwarmNodeIdentity;
  localKeyPair?: Ed25519KeyPair;
  trustedIssuers?: string[];
  requireCredentials?: boolean;
  minEndorsements?: number;
}

export class CredentialVerifier {
  private localIdentity: SwarmNodeIdentity;
  private localKeyPair?: Ed25519KeyPair;
  private trustedIssuers: Set<string>;
  private requireCredentials: boolean;
  private minEndorsements: number;

  constructor(config: CredentialVerifierConfig) {
    this.localIdentity = config.localIdentity;
    this.localKeyPair = config.localKeyPair;
    this.trustedIssuers = new Set(config.trustedIssuers ?? []);
    this.requireCredentials = config.requireCredentials ?? false;
    this.minEndorsements = config.minEndorsements ?? 0;
  }

  issueCredential(
    subjectNodeId: string,
    capabilityClaims: string[],
    validityMs: number = 86400000, // 24h default
  ): PeerCredential {
    if (!this.localKeyPair) {
      throw new Error("Cannot issue credential without local key pair");
    }

    const credentialId = randomUUID();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + validityMs).toISOString();

    // Canonical form for signing
    const canonical = `${credentialId}|${this.localIdentity.node_id}|${subjectNodeId}|${capabilityClaims.sort().join(",")}|${issuedAt}|${expiresAt}`;
    const signature = createHmac("sha256", this.localKeyPair.privateKey)
      .update(canonical)
      .digest("hex");

    return {
      credential_id: credentialId,
      issuer_node_id: this.localIdentity.node_id,
      subject_node_id: subjectNodeId,
      capability_claims: capabilityClaims,
      issued_at: issuedAt,
      expires_at: expiresAt,
      signature,
      endorsements: [],
    };
  }

  endorseCredential(credential: PeerCredential): CredentialEndorsement {
    if (!this.localKeyPair) {
      throw new Error("Cannot endorse credential without local key pair");
    }

    const canonical = `endorse:${credential.credential_id}:${this.localIdentity.node_id}`;
    const signature = createHmac("sha256", this.localKeyPair.privateKey)
      .update(canonical)
      .digest("hex");

    return {
      endorser_node_id: this.localIdentity.node_id,
      endorser_public_key: this.localKeyPair.publicKey,
      endorsed_at: new Date().toISOString(),
      signature,
    };
  }

  verifyCredential(
    credential: PeerCredential,
    issuerPublicKey?: string,
  ): CredentialVerificationResult {
    const issues: string[] = [];
    let signatureValid = false;
    let endorsementsValid = 0;

    // Check expiry
    const expired = new Date(credential.expires_at).getTime() < Date.now();
    if (expired) issues.push("Credential has expired");

    // Verify signature if issuer key provided
    if (issuerPublicKey) {
      const canonical = `${credential.credential_id}|${credential.issuer_node_id}|${credential.subject_node_id}|${credential.capability_claims.sort().join(",")}|${credential.issued_at}|${credential.expires_at}`;
      const expected = createHmac("sha256", issuerPublicKey)
        .update(canonical)
        .digest("hex");
      signatureValid = expected === credential.signature;
      if (!signatureValid) issues.push("Signature verification failed");
    } else {
      // Cannot verify without key — mark as unverifiable
      issues.push("No issuer public key provided for signature verification");
    }

    // Verify endorsements
    const endorsementCount = credential.endorsements?.length ?? 0;
    if (credential.endorsements) {
      for (const endorsement of credential.endorsements) {
        const canonical = `endorse:${credential.credential_id}:${endorsement.endorser_node_id}`;
        const expected = createHmac("sha256", endorsement.endorser_public_key)
          .update(canonical)
          .digest("hex");
        if (expected === endorsement.signature) {
          endorsementsValid++;
        }
      }
    }

    const valid = signatureValid && !expired && issues.length <= 0;
    // Re-check: if there are only endorsement-unrelated issues and signature is valid and not expired
    const isValid = signatureValid && !expired;

    return {
      valid: isValid,
      expired,
      signature_valid: signatureValid,
      endorsement_count: endorsementCount,
      endorsements_valid: endorsementsValid,
      issues,
    };
  }

  verifyPeerCredentials(identity: SwarmNodeIdentity): {
    accepted: boolean;
    reason?: string;
    valid_credentials: PeerCredential[];
  } {
    const credentials = identity.credentials ?? [];

    if (credentials.length === 0) {
      if (this.requireCredentials) {
        return { accepted: false, reason: "Peer has no credentials but credentials are required", valid_credentials: [] };
      }
      return { accepted: true, valid_credentials: [] };
    }

    const validCredentials: PeerCredential[] = [];
    for (const cred of credentials) {
      // Only verify credentials from trusted issuers if configured
      if (this.trustedIssuers.size > 0 && !this.trustedIssuers.has(cred.issuer_node_id)) {
        continue;
      }

      // We use the issuer's key if available from the credential itself
      const result = this.verifyCredential(cred);
      if (!result.expired) {
        validCredentials.push(cred);
      }
    }

    if (this.requireCredentials && validCredentials.length === 0) {
      return { accepted: false, reason: "No valid credentials from trusted issuers", valid_credentials: [] };
    }

    if (this.minEndorsements > 0) {
      const hasEnoughEndorsements = validCredentials.some(
        c => (c.endorsements?.length ?? 0) >= this.minEndorsements
      );
      if (!hasEnoughEndorsements) {
        return {
          accepted: false,
          reason: `No credential meets minimum endorsement requirement (${this.minEndorsements})`,
          valid_credentials: validCredentials,
        };
      }
    }

    return { accepted: true, valid_credentials: validCredentials };
  }

  getCapabilityProof(
    nodeId: string,
    capability: string,
    credentials: PeerCredential[],
  ): PeerCredential | undefined {
    return credentials.find(
      c => c.subject_node_id === nodeId &&
        c.capability_claims.includes(capability) &&
        new Date(c.expires_at).getTime() >= Date.now()
    );
  }
}
