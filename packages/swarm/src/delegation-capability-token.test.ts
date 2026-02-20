import { describe, it, expect, beforeEach, vi } from "vitest";
import { DCTManager, DEFAULT_DCT_CONFIG } from "./delegation-capability-token.js";
import type { Caveat, DelegationCapabilityToken } from "./types.js";

function makeCaveat(overrides: Partial<Caveat> = {}): Caveat {
  return {
    type: "tool_restriction",
    value: ["read-file", "http-request"],
    added_by: "node-origin",
    added_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("DCTManager", () => {
  const swarmToken = "test-swarm-secret-token-1234";
  const nodeId = "origin-node";
  let manager: DCTManager;

  beforeEach(() => {
    manager = new DCTManager({ swarmToken, nodeId });
    vi.restoreAllMocks();
  });

  // ─── createRootToken ────────────────────────────────────────────

  it("should create a root token with caveats and HMAC signature chain of length 1", () => {
    const caveats = [makeCaveat()];
    const dct = manager.createRootToken("holder-1", caveats);

    expect(dct.dct_id).toBeDefined();
    expect(dct.root_delegator_node_id).toBe(nodeId);
    expect(dct.current_holder_node_id).toBe("holder-1");
    expect(dct.parent_dct_id).toBeUndefined();
    expect(dct.caveats).toEqual(caveats);
    expect(dct.revoked).toBe(false);
    expect(dct.signature_chain).toHaveLength(1);
    expect(typeof dct.signature_chain[0]).toBe("string");
    expect(dct.created_at).toBeDefined();
    expect(dct.expires_at).toBeDefined();

    // Default expiry should be ~1 hour from creation
    const created = new Date(dct.created_at).getTime();
    const expires = new Date(dct.expires_at).getTime();
    expect(expires - created).toBeCloseTo(DEFAULT_DCT_CONFIG.default_expiry_ms, -2);
  });

  // ─── attenuate ──────────────────────────────────────────────────

  it("should create a child token with appended caveats and extended HMAC chain", () => {
    const rootCaveats = [makeCaveat({ type: "tool_restriction", value: ["read-file", "http-request"] })];
    const root = manager.createRootToken("holder-1", rootCaveats);

    const childCaveat = makeCaveat({
      type: "cost_limit",
      value: 5.0,
      added_by: "holder-1",
    });
    const child = manager.attenuate(root, [childCaveat], "holder-2");

    expect(child.dct_id).not.toBe(root.dct_id);
    expect(child.root_delegator_node_id).toBe(nodeId);
    expect(child.current_holder_node_id).toBe("holder-2");
    expect(child.parent_dct_id).toBe(root.dct_id);
    expect(child.caveats).toHaveLength(2); // root caveat + child caveat
    expect(child.signature_chain).toHaveLength(2);
    expect(child.expires_at).toBe(root.expires_at); // inherits parent expiry
    expect(child.revoked).toBe(false);
  });

  // ─── attenuate validation ───────────────────────────────────────

  it("should not allow adding tools not in parent's tool_restriction allowlist", () => {
    const rootCaveats = [makeCaveat({ type: "tool_restriction", value: ["read-file"] })];
    const root = manager.createRootToken("holder-1", rootCaveats);

    const badCaveat = makeCaveat({
      type: "tool_restriction",
      value: ["write-file"],
      added_by: "holder-1",
    });

    expect(() => manager.attenuate(root, [badCaveat], "holder-2")).toThrow(
      /Cannot add tool "write-file" not in parent's allowlist/,
    );
  });

  it("should not allow raising cost limit above parent's cost limit", () => {
    const rootCaveats = [makeCaveat({ type: "cost_limit", value: 1.0, added_by: "origin" })];
    const root = manager.createRootToken("holder-1", rootCaveats);

    const badCaveat = makeCaveat({
      type: "cost_limit",
      value: 5.0,
      added_by: "holder-1",
    });

    expect(() => manager.attenuate(root, [badCaveat], "holder-2")).toThrow(
      /New cost limit 5 exceeds parent's limit 1/,
    );
  });

  it("should not allow raising token limit above parent's token limit", () => {
    const rootCaveats = [makeCaveat({ type: "token_limit", value: 1000, added_by: "origin" })];
    const root = manager.createRootToken("holder-1", rootCaveats);

    const badCaveat = makeCaveat({
      type: "token_limit",
      value: 5000,
      added_by: "holder-1",
    });

    expect(() => manager.attenuate(root, [badCaveat], "holder-2")).toThrow(
      /New token limit 5000 exceeds parent's limit 1000/,
    );
  });

  // ─── attenuate revoked ──────────────────────────────────────────

  it("should throw when attenuating a revoked token", () => {
    const root = manager.createRootToken("holder-1", [makeCaveat()]);
    manager.revoke(root.dct_id);

    expect(() =>
      manager.attenuate(root, [makeCaveat({ type: "read_only", value: true })], "holder-2"),
    ).toThrow("Cannot attenuate a revoked token");
  });

  // ─── attenuate depth ────────────────────────────────────────────

  it("should throw when caveat chain depth exceeds max_caveat_depth", () => {
    const shallowManager = new DCTManager({
      swarmToken,
      nodeId,
      dctConfig: { max_caveat_depth: 2 },
    });

    const root = shallowManager.createRootToken("holder-1", [
      makeCaveat({ type: "cost_limit", value: 100 }),
    ]);

    // Chain depth 1 -> 2
    const child = shallowManager.attenuate(
      root,
      [makeCaveat({ type: "cost_limit", value: 50, added_by: "holder-1" })],
      "holder-2",
    );

    // Chain depth 2 -> 3 should throw (exceeds max of 2)
    expect(() =>
      shallowManager.attenuate(
        child,
        [makeCaveat({ type: "cost_limit", value: 25, added_by: "holder-2" })],
        "holder-3",
      ),
    ).toThrow(/Caveat chain depth 2 exceeds max 2/);
  });

  // ─── verify valid ───────────────────────────────────────────────

  it("should verify a valid root token", () => {
    const root = manager.createRootToken("holder-1", [makeCaveat()]);
    const result = manager.verify(root);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("should verify a valid attenuated token", () => {
    const root = manager.createRootToken("holder-1", [
      makeCaveat({ type: "cost_limit", value: 10 }),
    ]);
    const child = manager.attenuate(
      root,
      [makeCaveat({ type: "cost_limit", value: 5, added_by: "holder-1" })],
      "holder-2",
    );
    const result = manager.verify(child);
    expect(result.valid).toBe(true);
  });

  // ─── verify revoked ─────────────────────────────────────────────

  it("should return invalid for a revoked token", () => {
    const root = manager.createRootToken("holder-1", [makeCaveat()]);
    manager.revoke(root.dct_id);

    const result = manager.verify(root);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/revoked/i);
  });

  // ─── verify parent revoked ──────────────────────────────────────

  it("should return invalid when parent token is revoked", () => {
    const root = manager.createRootToken("holder-1", [
      makeCaveat({ type: "cost_limit", value: 10 }),
    ]);
    const child = manager.attenuate(
      root,
      [makeCaveat({ type: "cost_limit", value: 5, added_by: "holder-1" })],
      "holder-2",
    );

    // Revoking the parent cascades to children, so verify checks parent_dct_id
    // We need to revoke only in revokedIds for parent, without cascading, to test parent check
    // But the implementation cascades, so both parent and child are revoked.
    // Verify the child is considered invalid after parent revocation.
    manager.revoke(root.dct_id);

    expect(manager.isRevoked(root.dct_id)).toBe(true);
    expect(manager.isRevoked(child.dct_id)).toBe(true);

    const result = manager.verify(child);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/revoked/i);
  });

  // ─── verify expired ─────────────────────────────────────────────

  it("should return invalid for an expired token", () => {
    const root = manager.createRootToken("holder-1", [makeCaveat()], 50);

    vi.useFakeTimers();
    vi.advanceTimersByTime(100);

    const result = manager.verify(root);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/i);

    vi.useRealTimers();
  });

  // ─── verify depth exceeded ──────────────────────────────────────

  it("should return invalid when signature chain exceeds max depth", () => {
    const tinyManager = new DCTManager({
      swarmToken,
      nodeId,
      dctConfig: { max_caveat_depth: 1 },
    });

    // Create a root token (chain length 1) -- valid at depth limit
    const root = tinyManager.createRootToken("holder-1", [
      makeCaveat({ type: "cost_limit", value: 100 }),
    ]);

    // Manually forge a token with chain length > max for verification
    const forged: DelegationCapabilityToken = {
      ...root,
      signature_chain: ["sig1", "sig2"], // length 2 > max 1
    };

    const result = tinyManager.verify(forged);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/depth/i);
  });

  // ─── validateRequest tool_restriction ───────────────────────────

  it("should allow a tool in the tool_restriction allowlist", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "tool_restriction", value: ["read-file", "http-request"] }),
    ]);

    const result = manager.validateRequest(dct, { tool: "read-file" });
    expect(result.allowed).toBe(true);
  });

  it("should deny a tool not in the tool_restriction allowlist", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "tool_restriction", value: ["read-file"] }),
    ]);

    const result = manager.validateRequest(dct, { tool: "write-file" });
    expect(result.allowed).toBe(false);
    expect(result.violated_caveat).toBeDefined();
    expect(result.violated_caveat!.type).toBe("tool_restriction");
  });

  // ─── validateRequest path_restriction ───────────────────────────

  it("should allow a path matching allow list", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({
        type: "path_restriction",
        value: { allow: ["/home/user/safe/"], deny: ["/home/user/safe/secrets/"] },
      }),
    ]);

    expect(manager.validateRequest(dct, { path: "/home/user/safe/data.txt" }).allowed).toBe(true);
  });

  it("should deny a path in the deny list", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({
        type: "path_restriction",
        value: { allow: ["/home/user/safe/"], deny: ["/home/user/safe/secrets/"] },
      }),
    ]);

    const result = manager.validateRequest(dct, { path: "/home/user/safe/secrets/key.pem" });
    expect(result.allowed).toBe(false);
    expect(result.violated_caveat!.type).toBe("path_restriction");
  });

  it("should deny a path not in the allow list", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({
        type: "path_restriction",
        value: { allow: ["/home/user/safe/"] },
      }),
    ]);

    const result = manager.validateRequest(dct, { path: "/etc/passwd" });
    expect(result.allowed).toBe(false);
  });

  // ─── validateRequest cost_limit ─────────────────────────────────

  it("should allow request within cost limit", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "cost_limit", value: 5.0 }),
    ]);

    expect(manager.validateRequest(dct, { cost_usd: 3.0 }).allowed).toBe(true);
  });

  it("should deny request exceeding cost limit", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "cost_limit", value: 5.0 }),
    ]);

    const result = manager.validateRequest(dct, { cost_usd: 10.0 });
    expect(result.allowed).toBe(false);
    expect(result.violated_caveat!.type).toBe("cost_limit");
  });

  // ─── validateRequest token_limit ────────────────────────────────

  it("should allow request within token limit", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "token_limit", value: 1000 }),
    ]);

    expect(manager.validateRequest(dct, { tokens: 500 }).allowed).toBe(true);
  });

  it("should deny request exceeding token limit", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "token_limit", value: 1000 }),
    ]);

    const result = manager.validateRequest(dct, { tokens: 2000 });
    expect(result.allowed).toBe(false);
    expect(result.violated_caveat!.type).toBe("token_limit");
  });

  // ─── validateRequest read_only ──────────────────────────────────

  it("should block write-file and shell-exec under read_only caveat", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "read_only", value: true }),
    ]);

    expect(manager.validateRequest(dct, { tool: "write-file" }).allowed).toBe(false);
    expect(manager.validateRequest(dct, { tool: "shell-exec" }).allowed).toBe(false);
    // read-file should be allowed
    expect(manager.validateRequest(dct, { tool: "read-file" }).allowed).toBe(true);
  });

  // ─── validateRequest time_bound ─────────────────────────────────

  it("should allow request within time window", () => {
    const now = new Date();
    const past = new Date(now.getTime() - 3600000).toISOString();
    const future = new Date(now.getTime() + 3600000).toISOString();

    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "time_bound", value: { not_before: past, not_after: future } }),
    ]);

    expect(manager.validateRequest(dct, { tool: "read-file" }).allowed).toBe(true);
  });

  it("should deny request outside time window", () => {
    const past = new Date(Date.now() - 7200000).toISOString();
    const alsoInThePast = new Date(Date.now() - 3600000).toISOString();

    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "time_bound", value: { not_before: past, not_after: alsoInThePast } }),
    ]);

    // Current time is after not_after, so should be denied
    const result = manager.validateRequest(dct, { tool: "read-file" });
    expect(result.allowed).toBe(false);
    expect(result.violated_caveat!.type).toBe("time_bound");
  });

  // ─── validateRequest domain_restriction ─────────────────────────

  it("should allow request to a matching domain", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "domain_restriction", value: ["example.com", "api.example.com"] }),
    ]);

    expect(manager.validateRequest(dct, { path: "https://example.com/data" }).allowed).toBe(true);
  });

  it("should deny request to a non-matching domain", () => {
    const dct = manager.createRootToken("holder-1", [
      makeCaveat({ type: "domain_restriction", value: ["example.com"] }),
    ]);

    const result = manager.validateRequest(dct, { path: "https://evil.com/steal" });
    expect(result.allowed).toBe(false);
    expect(result.violated_caveat!.type).toBe("domain_restriction");
  });

  // ─── revoke cascading ──────────────────────────────────────────

  it("should revoke parent and all children recursively", () => {
    const root = manager.createRootToken("holder-1", [
      makeCaveat({ type: "cost_limit", value: 100 }),
    ]);
    const child = manager.attenuate(
      root,
      [makeCaveat({ type: "cost_limit", value: 50, added_by: "holder-1" })],
      "holder-2",
    );
    const grandchild = manager.attenuate(
      child,
      [makeCaveat({ type: "cost_limit", value: 25, added_by: "holder-2" })],
      "holder-3",
    );

    manager.revoke(root.dct_id);

    expect(manager.isRevoked(root.dct_id)).toBe(true);
    expect(manager.isRevoked(child.dct_id)).toBe(true);
    expect(manager.isRevoked(grandchild.dct_id)).toBe(true);
  });

  // ─── getActiveTokens ───────────────────────────────────────────

  it("should return only non-revoked tokens", () => {
    const root1 = manager.createRootToken("holder-1", [makeCaveat()]);
    const root2 = manager.createRootToken("holder-2", [makeCaveat()]);
    const root3 = manager.createRootToken("holder-3", [makeCaveat()]);

    manager.revoke(root2.dct_id);

    const active = manager.getActiveTokens();
    expect(active).toHaveLength(2);

    const activeIds = active.map(t => t.dct_id);
    expect(activeIds).toContain(root1.dct_id);
    expect(activeIds).toContain(root3.dct_id);
    expect(activeIds).not.toContain(root2.dct_id);
  });

  // ─── cleanup ────────────────────────────────────────────────────

  it("should remove expired and revoked tokens", () => {
    // Create an expiring token and a long-lived one
    const shortLived = manager.createRootToken("holder-1", [makeCaveat()], 50);
    const longLived = manager.createRootToken("holder-2", [makeCaveat()], 999999);
    const revoked = manager.createRootToken("holder-3", [makeCaveat()]);
    manager.revoke(revoked.dct_id);

    vi.useFakeTimers();
    vi.advanceTimersByTime(100);

    const removed = manager.cleanup();
    expect(removed).toBe(2); // shortLived (expired) + revoked
    const active = manager.getActiveTokens();
    expect(active).toHaveLength(1);
    expect(active[0]!.dct_id).toBe(longLived.dct_id);

    vi.useRealTimers();
  });

  // ─── full chain: create -> attenuate -> verify -> validate ──────

  it("should support a full lifecycle: create, attenuate, verify, validate", () => {
    // 1. Create root with tool + cost restrictions
    const root = manager.createRootToken("holder-1", [
      makeCaveat({ type: "tool_restriction", value: ["read-file", "http-request", "shell-exec"] }),
      makeCaveat({ type: "cost_limit", value: 10.0 }),
    ]);

    // 2. Attenuate: narrow tools, lower cost
    const child = manager.attenuate(
      root,
      [
        makeCaveat({
          type: "tool_restriction",
          value: ["read-file", "http-request"],
          added_by: "holder-1",
        }),
        makeCaveat({ type: "cost_limit", value: 5.0, added_by: "holder-1" }),
      ],
      "holder-2",
    );

    // 3. Verify both tokens
    expect(manager.verify(root).valid).toBe(true);
    expect(manager.verify(child).valid).toBe(true);

    // 4. Validate requests against child token
    // read-file within cost: allowed
    expect(
      manager.validateRequest(child, { tool: "read-file", cost_usd: 3.0 }).allowed,
    ).toBe(true);

    // shell-exec: denied by child's narrower tool_restriction
    expect(
      manager.validateRequest(child, { tool: "shell-exec", cost_usd: 1.0 }).allowed,
    ).toBe(false);

    // Exceeding cost: denied
    expect(
      manager.validateRequest(child, { tool: "read-file", cost_usd: 8.0 }).allowed,
    ).toBe(false);

    // 5. Revoke root and verify cascade
    manager.revoke(root.dct_id);
    expect(manager.verify(child).valid).toBe(false);
    expect(manager.isRevoked(child.dct_id)).toBe(true);
  });
});
