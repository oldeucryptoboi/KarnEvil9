import { describe, it, expect } from "vitest";
import {
  createAttestation,
  createChainLink,
  appendToChain,
  verifyChain,
  getChainDepth,
} from "./attestation.js";
import type { SwarmTaskResult, AttestationChain } from "./types.js";

const TOKEN = "test-swarm-token-secret";

function makeResult(overrides: Partial<SwarmTaskResult> = {}): SwarmTaskResult {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    peer_session_id: "session-1",
    status: "completed",
    findings: [{ step_title: "test", tool_name: "read-file", status: "succeeded", summary: "ok" }],
    tokens_used: 100,
    cost_usd: 0.01,
    duration_ms: 5000,
    ...overrides,
  };
}

describe("createChainLink", () => {
  it("should create a chain link with valid attestation", () => {
    const result = makeResult();
    const link = createChainLink(result, TOKEN, "delegator-A", "delegatee-B", 0);
    expect(link.attestation.task_id).toBe("task-1");
    expect(link.delegator_node_id).toBe("delegator-A");
    expect(link.delegatee_node_id).toBe("delegatee-B");
    expect(link.depth).toBe(0);
    expect(link.attestation.hmac).toBeTruthy();
  });

  it("should produce a verifiable attestation", () => {
    const result = makeResult();
    const link = createChainLink(result, TOKEN, "A", "B", 0);
    const att = link.attestation;
    const manual = createAttestation(result, TOKEN);
    // Both should have same findings hash (deterministic)
    expect(att.findings_hash).toBe(manual.findings_hash);
  });
});

describe("appendToChain", () => {
  it("should create new chain from undefined", () => {
    const result = makeResult();
    const link = createChainLink(result, TOKEN, "A", "B", 0);
    const chain = appendToChain(undefined, link);
    expect(chain.root_task_id).toBe("task-1");
    expect(chain.links).toHaveLength(1);
    expect(chain.depth).toBe(1);
  });

  it("should append to existing chain", () => {
    const result = makeResult();
    const link0 = createChainLink(result, TOKEN, "A", "B", 0);
    const chain0 = appendToChain(undefined, link0);

    const link1 = createChainLink(result, TOKEN, "B", "C", 1);
    const chain1 = appendToChain(chain0, link1);
    expect(chain1.links).toHaveLength(2);
    expect(chain1.depth).toBe(2);
    expect(chain1.root_task_id).toBe("task-1");
  });

  it("should preserve root_task_id from existing chain", () => {
    const result = makeResult({ task_id: "root-task" });
    const link0 = createChainLink(result, TOKEN, "A", "B", 0);
    const chain0 = appendToChain(undefined, link0);

    const result2 = makeResult({ task_id: "root-task" });
    const link1 = createChainLink(result2, TOKEN, "B", "C", 1);
    const chain1 = appendToChain(chain0, link1);
    expect(chain1.root_task_id).toBe("root-task");
  });
});

describe("verifyChain", () => {
  it("should verify a valid single-link chain", () => {
    const result = makeResult();
    const link = createChainLink(result, TOKEN, "A", "B", 0);
    const chain = appendToChain(undefined, link);
    const verification = verifyChain(chain, TOKEN);
    expect(verification.valid).toBe(true);
    expect(verification.invalid_at_depth).toBeUndefined();
  });

  it("should verify a valid 3-link chain", () => {
    const result = makeResult();
    const link0 = createChainLink(result, TOKEN, "A", "B", 0);
    const chain0 = appendToChain(undefined, link0);

    const link1 = createChainLink(result, TOKEN, "B", "C", 1);
    const chain1 = appendToChain(chain0, link1);

    const link2 = createChainLink(result, TOKEN, "C", "D", 2);
    const chain2 = appendToChain(chain1, link2);

    const verification = verifyChain(chain2, TOKEN);
    expect(verification.valid).toBe(true);
  });

  it("should detect tampered HMAC", () => {
    const result = makeResult();
    const link = createChainLink(result, TOKEN, "A", "B", 0);
    link.attestation.hmac = "tampered";
    const chain = appendToChain(undefined, link);
    const verification = verifyChain(chain, TOKEN);
    expect(verification.valid).toBe(false);
    expect(verification.invalid_at_depth).toBe(0);
  });

  it("should detect wrong token", () => {
    const result = makeResult();
    const link = createChainLink(result, TOKEN, "A", "B", 0);
    const chain = appendToChain(undefined, link);
    const verification = verifyChain(chain, "wrong-token");
    expect(verification.valid).toBe(false);
    expect(verification.invalid_at_depth).toBe(0);
  });

  it("should detect broken continuity", () => {
    const result = makeResult();
    const link0 = createChainLink(result, TOKEN, "A", "B", 0);
    const chain0 = appendToChain(undefined, link0);

    // Link1 delegator should be B (to match link0's delegatee), but we use X
    const link1 = createChainLink(result, TOKEN, "X", "C", 1);
    const chain1 = appendToChain(chain0, link1);

    const verification = verifyChain(chain1, TOKEN);
    expect(verification.valid).toBe(false);
    expect(verification.invalid_at_depth).toBe(1);
  });

  it("should detect non-contiguous depths", () => {
    const result = makeResult();
    const link = createChainLink(result, TOKEN, "A", "B", 5); // wrong depth
    const chain: AttestationChain = {
      root_task_id: "task-1",
      links: [link],
      depth: 6,
    };
    const verification = verifyChain(chain, TOKEN);
    expect(verification.valid).toBe(false);
  });

  it("should detect wrong root_task_id", () => {
    const result = makeResult({ task_id: "different-task" });
    const link = createChainLink(result, TOKEN, "A", "B", 0);
    const chain: AttestationChain = {
      root_task_id: "task-1", // doesn't match attestation.task_id
      links: [link],
      depth: 1,
    };
    const verification = verifyChain(chain, TOKEN);
    expect(verification.valid).toBe(false);
    expect(verification.invalid_at_depth).toBe(0);
  });

  it("should handle empty chain", () => {
    const chain: AttestationChain = {
      root_task_id: "task-1",
      links: [],
      depth: 0,
    };
    const verification = verifyChain(chain, TOKEN);
    expect(verification.valid).toBe(true);
  });

  it("should detect tampered findings_hash in middle of chain", () => {
    const result = makeResult();
    const link0 = createChainLink(result, TOKEN, "A", "B", 0);
    const chain0 = appendToChain(undefined, link0);

    const link1 = createChainLink(result, TOKEN, "B", "C", 1);
    link1.attestation.findings_hash = "tampered-hash";
    const chain1 = appendToChain(chain0, link1);

    const verification = verifyChain(chain1, TOKEN);
    expect(verification.valid).toBe(false);
    expect(verification.invalid_at_depth).toBe(1);
  });
});

describe("getChainDepth", () => {
  it("should return 0 for undefined chain", () => {
    expect(getChainDepth(undefined)).toBe(0);
  });

  it("should return chain depth", () => {
    const result = makeResult();
    const link = createChainLink(result, TOKEN, "A", "B", 0);
    const chain = appendToChain(undefined, link);
    expect(getChainDepth(chain)).toBe(1);
  });

  it("should return depth for multi-link chain", () => {
    const result = makeResult();
    const link0 = createChainLink(result, TOKEN, "A", "B", 0);
    const chain0 = appendToChain(undefined, link0);
    const link1 = createChainLink(result, TOKEN, "B", "C", 1);
    const chain1 = appendToChain(chain0, link1);
    const link2 = createChainLink(result, TOKEN, "C", "D", 2);
    const chain2 = appendToChain(chain1, link2);
    expect(getChainDepth(chain2)).toBe(3);
  });
});
