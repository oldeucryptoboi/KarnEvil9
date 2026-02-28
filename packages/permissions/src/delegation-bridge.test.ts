import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import type { PermissionGrant, PermissionRequest } from "@karnevil9/schemas";
import { PermissionEngine } from "./permission-engine.js";
import { DelegationBridge } from "./delegation-bridge.js";

const TEST_DIR = resolve(import.meta.dirname ?? ".", "../../.test-data-delegation");
const TEST_FILE = resolve(TEST_DIR, "delegation-journal.jsonl");

const SECRET = "test-delegation-secret-key";

function makeGrant(scope: string): PermissionGrant {
  return {
    scope,
    decision: "allow_session",
    granted_by: "user",
    granted_at: new Date().toISOString(),
    ttl: "session",
  };
}

describe("DelegationBridge", () => {
  let journal: Journal;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("child gets subset of parent grants", () => {
    const bridge = new DelegationBridge({ signingSecret: SECRET });
    const parentGrants = [
      makeGrant("filesystem:read:workspace"),
      makeGrant("filesystem:write:workspace"),
      makeGrant("network:request:*"),
    ];

    const token = bridge.deriveChildToken(parentGrants, "child-1");
    expect(token.allowed_scopes).toHaveLength(3);
    expect(token.allowed_scopes).toContain("filesystem:read:workspace");
    expect(token.allowed_scopes).toContain("filesystem:write:workspace");
    expect(token.allowed_scopes).toContain("network:request:*");
    expect(bridge.verifySignature(token)).toBe(true);
  });

  it("child cannot escalate beyond parent — tool_allowlist intersects", () => {
    const bridge = new DelegationBridge({ signingSecret: SECRET });
    const parentGrants = [
      makeGrant("filesystem:read:workspace"),
      makeGrant("network:request:*"),
    ];

    // Request filesystem but not network
    const token = bridge.deriveChildToken(parentGrants, "child-2", {
      tool_allowlist: ["filesystem"],
    });
    expect(token.allowed_scopes).toContain("filesystem:read:workspace");
    expect(token.allowed_scopes).not.toContain("network:request:*");
  });

  it("empty parent grants = child gets nothing", () => {
    const bridge = new DelegationBridge({ signingSecret: SECRET });
    const token = bridge.deriveChildToken([], "child-3");
    expect(token.allowed_scopes).toHaveLength(0);
  });

  it("tool_allowlist with no matching parent scopes yields empty", () => {
    const bridge = new DelegationBridge({ signingSecret: SECRET });
    const parentGrants = [makeGrant("filesystem:read:workspace")];

    const token = bridge.deriveChildToken(parentGrants, "child-4", {
      tool_allowlist: ["network"],
    });
    expect(token.allowed_scopes).toHaveLength(0);
  });

  it("enforcer rejects out-of-boundary scopes", () => {
    const bridge = new DelegationBridge({ signingSecret: SECRET });
    const parentGrants = [
      makeGrant("filesystem:read:workspace"),
    ];

    const token = bridge.deriveChildToken(parentGrants, "child-5");
    const enforcer = bridge.createEnforcer(token);

    expect(enforcer.validateScope("filesystem:read:workspace")).toBe(true);
    expect(enforcer.validateScope("network:request:https://evil.com")).toBe(false);
    expect(enforcer.validateScope("shell:exec:rm")).toBe(false);
  });

  it("enforcer supports wildcard scopes in token", () => {
    const bridge = new DelegationBridge({ signingSecret: SECRET });
    const parentGrants = [makeGrant("filesystem:read:*")];

    const token = bridge.deriveChildToken(parentGrants, "child-6");
    const enforcer = bridge.createEnforcer(token);

    expect(enforcer.validateScope("filesystem:read:workspace")).toBe(true);
    expect(enforcer.validateScope("filesystem:read:/etc/passwd")).toBe(true);
    expect(enforcer.validateScope("filesystem:write:workspace")).toBe(false);
  });

  it("applyTokenAsGrants + setDCTEnforcer creates constrained child engine", async () => {
    const bridge = new DelegationBridge({ signingSecret: SECRET });
    const parentGrants = [
      makeGrant("filesystem:read:workspace"),
      makeGrant("network:request:*"),
    ];

    const token = bridge.deriveChildToken(parentGrants, "child-7");
    const childEngine = new PermissionEngine(journal, async () => "allow_session");

    bridge.applyTokenAsGrants(childEngine, "child-session", token);
    const enforcer = bridge.createEnforcer(token);
    childEngine.setDCTEnforcer(enforcer);

    // Allowed scope — pre-granted and within DCT boundary
    expect(childEngine.isGranted("filesystem:read:workspace", "child-session")).toBe(true);

    // Out-of-boundary scope — DCT enforcer blocks it in check()
    const req: PermissionRequest = {
      request_id: uuid(),
      session_id: "child-session",
      step_id: uuid(),
      tool_name: "shell-tool",
      permissions: [PermissionEngine.parse("shell:exec:rm")],
    };
    const result = await childEngine.check(req);
    expect(result.allowed).toBe(false);
  });

  it("parent cleanup doesn't affect child engine", async () => {
    const bridge = new DelegationBridge({ signingSecret: SECRET });
    const parentEngine = new PermissionEngine(journal, async () => "allow_session");
    parentEngine.preGrant("parent-sess", ["filesystem:read:workspace"]);

    const parentGrants = parentEngine.listGrants("parent-sess");
    const token = bridge.deriveChildToken(parentGrants, "child-8");
    const childEngine = new PermissionEngine(journal, async () => "allow_session");
    bridge.applyTokenAsGrants(childEngine, "child-sess", token);

    // Clear parent
    parentEngine.clearSession("parent-sess");
    expect(parentEngine.isGranted("filesystem:read:workspace", "parent-sess")).toBe(false);

    // Child still has grants
    expect(childEngine.isGranted("filesystem:read:workspace", "child-sess")).toBe(true);
  });
});
