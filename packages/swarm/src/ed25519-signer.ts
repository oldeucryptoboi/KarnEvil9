import { generateKeyPairSync, sign, verify, createHash, createPrivateKey, createPublicKey } from "node:crypto";
import type { Ed25519KeyPair, SwarmTaskResult, TaskAttestation } from "./types.js";

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"),
  };
}

function canonicalizeResult(result: SwarmTaskResult): string {
  return JSON.stringify({
    task_id: result.task_id,
    peer_node_id: result.peer_node_id,
    peer_session_id: result.peer_session_id,
    status: result.status,
    findings_hash: createHash("sha256").update(JSON.stringify(result.findings)).digest("hex"),
    tokens_used: result.tokens_used,
    cost_usd: result.cost_usd,
    duration_ms: result.duration_ms,
  });
}

function canonicalizeAttestation(attestation: TaskAttestation): string {
  return JSON.stringify({
    task_id: attestation.task_id,
    peer_node_id: attestation.peer_node_id,
    status: attestation.status,
    findings_hash: attestation.findings_hash,
    timestamp: attestation.timestamp,
    hmac: attestation.hmac,
  });
}

function _importPrivateKey(hexKey: string) {
  return import("node:crypto").then((c) =>
    c.createPrivateKey({ key: Buffer.from(hexKey, "hex"), format: "der", type: "pkcs8" }),
  );
}

function _importPublicKey(hexKey: string) {
  return import("node:crypto").then((c) =>
    c.createPublicKey({ key: Buffer.from(hexKey, "hex"), format: "der", type: "spki" }),
  );
}

function importPrivateKeySync(hexKey: string) {
  return createPrivateKey({ key: Buffer.from(hexKey, "hex"), format: "der", type: "pkcs8" });
}

function importPublicKeySync(hexKey: string) {
  return createPublicKey({ key: Buffer.from(hexKey, "hex"), format: "der", type: "spki" });
}

export function signResult(result: SwarmTaskResult, privateKey: string): string {
  const data = Buffer.from(canonicalizeResult(result));
  const key = importPrivateKeySync(privateKey);
  return sign(null, data, key).toString("hex");
}

export function verifyResultSignature(result: SwarmTaskResult, signature: string, publicKey: string): boolean {
  try {
    const data = Buffer.from(canonicalizeResult(result));
    const key = importPublicKeySync(publicKey);
    return verify(null, data, key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

export function signAttestation(attestation: TaskAttestation, privateKey: string): string {
  const data = Buffer.from(canonicalizeAttestation(attestation));
  const key = importPrivateKeySync(privateKey);
  return sign(null, data, key).toString("hex");
}

export function verifyAttestationSignature(attestation: TaskAttestation, signature: string, publicKey: string): boolean {
  try {
    const data = Buffer.from(canonicalizeAttestation(attestation));
    const key = importPublicKeySync(publicKey);
    return verify(null, data, key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}
