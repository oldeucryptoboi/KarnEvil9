import { createHash, createHmac } from "node:crypto";
import type {
  TaskAttestation,
  SwarmTaskResult,
  AttestationChainLink,
  AttestationChain,
} from "./types.js";

export function createAttestation(result: SwarmTaskResult, token: string): TaskAttestation {
  const findingsHash = createHash("sha256")
    .update(JSON.stringify(result.findings))
    .digest("hex");

  const timestamp = new Date().toISOString();

  const canonical = `${result.task_id}|${result.peer_node_id}|${result.status}|${findingsHash}|${timestamp}`;
  const hmac = createHmac("sha256", token)
    .update(canonical)
    .digest("hex");

  return {
    task_id: result.task_id,
    peer_node_id: result.peer_node_id,
    status: result.status,
    findings_hash: findingsHash,
    timestamp,
    hmac,
  };
}

export function verifyAttestation(attestation: TaskAttestation, token: string): boolean {
  const canonical = `${attestation.task_id}|${attestation.peer_node_id}|${attestation.status}|${attestation.findings_hash}|${attestation.timestamp}`;
  const expected = createHmac("sha256", token)
    .update(canonical)
    .digest("hex");

  return expected === attestation.hmac;
}

// ─── Transitive Attestation Chain ───────────────────────────────────

export function createChainLink(
  result: SwarmTaskResult,
  token: string,
  delegatorId: string,
  delegateeId: string,
  depth: number,
): AttestationChainLink {
  const attestation = createAttestation(result, token);
  return {
    attestation,
    delegator_node_id: delegatorId,
    delegatee_node_id: delegateeId,
    depth,
  };
}

export function appendToChain(
  chain: AttestationChain | undefined,
  link: AttestationChainLink,
): AttestationChain {
  if (!chain) {
    return {
      root_task_id: link.attestation.task_id,
      links: [link],
      depth: link.depth + 1,
    };
  }
  return {
    root_task_id: chain.root_task_id,
    links: [...chain.links, link],
    depth: link.depth + 1,
  };
}

export function verifyChain(
  chain: AttestationChain,
  token: string,
): { valid: boolean; invalid_at_depth?: number } {
  if (chain.links.length === 0) {
    return { valid: true };
  }

  for (let i = 0; i < chain.links.length; i++) {
    const link = chain.links[i]!;

    // Verify HMAC
    if (!verifyAttestation(link.attestation, token)) {
      return { valid: false, invalid_at_depth: link.depth };
    }

    // Verify contiguous depths starting from 0
    if (link.depth !== i) {
      return { valid: false, invalid_at_depth: link.depth };
    }

    // Verify all reference same root_task_id
    if (link.attestation.task_id !== chain.root_task_id) {
      return { valid: false, invalid_at_depth: link.depth };
    }

    // Verify chain continuity: link[i].delegatee == link[i+1].delegator
    if (i > 0) {
      const prevLink = chain.links[i - 1]!;
      if (prevLink.delegatee_node_id !== link.delegator_node_id) {
        return { valid: false, invalid_at_depth: link.depth };
      }
    }
  }

  return { valid: true };
}

export function getChainDepth(chain: AttestationChain | undefined): number {
  if (!chain) return 0;
  return chain.depth;
}
