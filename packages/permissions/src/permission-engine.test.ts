import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@openvger/journal";
import type { ApprovalDecision, PermissionRequest } from "@openvger/schemas";
import { PermissionEngine } from "./permission-engine.js";

const TEST_DIR = resolve(import.meta.dirname ?? ".", "../../.test-data");
const TEST_FILE = resolve(TEST_DIR, "perm-journal.jsonl");

describe("PermissionEngine.parse", () => {
  it("parses a valid scope string", () => {
    const perm = PermissionEngine.parse("filesystem:read:workspace");
    expect(perm.domain).toBe("filesystem");
    expect(perm.action).toBe("read");
    expect(perm.target).toBe("workspace");
    expect(perm.scope).toBe("filesystem:read:workspace");
  });

  it("handles targets with colons", () => {
    const perm = PermissionEngine.parse("network:request:https://example.com");
    expect(perm.domain).toBe("network");
    expect(perm.action).toBe("request");
    expect(perm.target).toBe("https://example.com");
  });

  it("throws for invalid scope with fewer than 3 parts", () => {
    expect(() => PermissionEngine.parse("filesystem:read")).toThrow("Invalid permission scope");
    expect(() => PermissionEngine.parse("single")).toThrow("Invalid permission scope");
  });
});

describe("PermissionEngine.check", () => {
  let journal: Journal;
  let promptDecision: ApprovalDecision;
  let promptCalls: PermissionRequest[];

  const mockPrompt = async (request: PermissionRequest): Promise<ApprovalDecision> => {
    promptCalls.push(request);
    return promptDecision;
  };

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE);
    await journal.init();
    promptDecision = "allow_session";
    promptCalls = [];
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  function makeRequest(scopes: string[]): PermissionRequest {
    return {
      request_id: uuid(),
      session_id: uuid(),
      step_id: uuid(),
      tool_name: "test-tool",
      permissions: scopes.map((s) => PermissionEngine.parse(s)),
    };
  }

  it("prompts and grants allow_session", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    const result = await engine.check(req);
    expect(result.allowed).toBe(true);
    expect(promptCalls).toHaveLength(1);
  });

  it("denies when prompt returns deny", async () => {
    promptDecision = "deny";
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:write:workspace"]);
    const result = await engine.check(req);
    expect(result.allowed).toBe(false);
  });

  it("caches session grants and skips prompt on second check (same session)", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    const req1 = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req1);
    expect(promptCalls).toHaveLength(1);

    const req2 = makeRequest(["filesystem:read:workspace"]);
    req2.session_id = req1.session_id;
    await engine.check(req2);
    expect(promptCalls).toHaveLength(1); // no additional prompt
  });

  it("caches global grants", async () => {
    promptDecision = "allow_always";
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["shell:exec:workspace"]);
    await engine.check(req);
    expect(engine.isGranted("shell:exec:workspace", req.session_id)).toBe(true);
    // Global grants are visible even without sessionId
    expect(engine.isGranted("shell:exec:workspace")).toBe(true);
  });

  it("clearSession removes session grants but keeps global", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);

    // Grant session-level
    promptDecision = "allow_session";
    const req1 = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req1);

    // Grant global-level
    promptDecision = "allow_always";
    const req2 = makeRequest(["shell:exec:workspace"]);
    await engine.check(req2);

    engine.clearSession(req1.session_id);
    expect(engine.isGranted("filesystem:read:workspace", req1.session_id)).toBe(false);
    expect(engine.isGranted("shell:exec:workspace")).toBe(true); // global survives
  });

  it("clearStep removes step-level grants only", async () => {
    promptDecision = "allow_once";
    const engine = new PermissionEngine(journal, mockPrompt);
    const req1 = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req1);
    expect(engine.isGranted("filesystem:read:workspace", req1.session_id)).toBe(false); // allow_once doesn't cache in session

    // allow_session should survive clearStep
    promptDecision = "allow_session";
    const req2 = makeRequest(["filesystem:write:workspace"]);
    await engine.check(req2);
    engine.clearStep(req2.session_id);
    expect(engine.isGranted("filesystem:write:workspace", req2.session_id)).toBe(true);
  });

  it("listGrants returns all active grants for a session", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    promptDecision = "allow_session";
    const req1 = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req1);
    promptDecision = "allow_always";
    const req2 = makeRequest(["shell:exec:workspace"]);
    req2.session_id = req1.session_id;
    await engine.check(req2);

    const grants = engine.listGrants(req1.session_id);
    expect(grants).toHaveLength(2);
    const scopes = grants.map((g) => g.scope);
    expect(scopes).toContain("filesystem:read:workspace");
    expect(scopes).toContain("shell:exec:workspace");
  });

  it("emits journal events for permission requests and grants", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req);

    const events = await journal.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("permission.requested");
    expect(types).toContain("permission.granted");
  });

  it("emits journal events for permission denial", async () => {
    promptDecision = "deny";
    const engine = new PermissionEngine(journal, mockPrompt);
    await engine.check(makeRequest(["filesystem:read:workspace"]));

    const events = await journal.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("permission.requested");
    expect(types).toContain("permission.denied");
  });

  it("isolates session grants between different sessions", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    promptDecision = "allow_session";

    // Session A grants filesystem:read:workspace
    const reqA = makeRequest(["filesystem:read:workspace"]);
    reqA.session_id = "session-A";
    await engine.check(reqA);

    // Session B should NOT see session A's grants
    expect(engine.isGranted("filesystem:read:workspace", "session-A")).toBe(true);
    expect(engine.isGranted("filesystem:read:workspace", "session-B")).toBe(false);
  });

  it("clearSession only affects the specified session", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    promptDecision = "allow_session";

    const reqA = makeRequest(["filesystem:read:workspace"]);
    reqA.session_id = "session-A";
    await engine.check(reqA);

    const reqB = makeRequest(["filesystem:read:workspace"]);
    reqB.session_id = "session-B";
    await engine.check(reqB);

    engine.clearSession("session-A");
    expect(engine.isGranted("filesystem:read:workspace", "session-A")).toBe(false);
    expect(engine.isGranted("filesystem:read:workspace", "session-B")).toBe(true);
  });

  it("global grants are shared across all sessions", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    promptDecision = "allow_always";

    const reqA = makeRequest(["shell:exec:workspace"]);
    reqA.session_id = "session-A";
    await engine.check(reqA);

    // Session B should see global grant without prompting
    expect(engine.isGranted("shell:exec:workspace", "session-B")).toBe(true);
  });
});

// ─── Graduated Permission Tests ──────────────────────────────────

describe("PermissionEngine graduated decisions", () => {
  let journal: Journal;
  let promptDecision: ApprovalDecision;
  let promptCalls: PermissionRequest[];

  const mockPrompt = async (request: PermissionRequest): Promise<ApprovalDecision> => {
    promptCalls.push(request);
    return promptDecision;
  };

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE);
    await journal.init();
    promptDecision = "allow_session";
    promptCalls = [];
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  function makeRequest(scopes: string[], toolName = "test-tool"): PermissionRequest {
    return {
      request_id: uuid(),
      session_id: "test-session",
      step_id: uuid(),
      tool_name: toolName,
      permissions: scopes.map((s) => PermissionEngine.parse(s)),
    };
  }

  it("handles allow_constrained decision", async () => {
    promptDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: {
        readonly_paths: ["/safe"],
        max_duration_ms: 5000,
        input_overrides: { mode: "safe" },
      },
    };
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    const result = await engine.check(req);
    expect(result.allowed).toBe(true);
    expect(result.constraints).toEqual({
      readonly_paths: ["/safe"],
      max_duration_ms: 5000,
      input_overrides: { mode: "safe" },
    });

    // Subsequent check for same session/tool should be granted and include cached constraints
    const req2 = makeRequest(["filesystem:read:workspace"]);
    const result2 = await engine.check(req2);
    expect(result2.allowed).toBe(true);
    expect(result2.constraints).toBeDefined();
    expect(promptCalls).toHaveLength(1); // no second prompt
  });

  it("handles allow_observed decision", async () => {
    promptDecision = {
      type: "allow_observed",
      scope: "session",
      telemetry_level: "detailed",
    };
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    const result = await engine.check(req);
    expect(result.allowed).toBe(true);
    expect(result.observed).toBe(true);

    const events = await journal.readAll();
    const grantedEvent = events.find(e => e.type === "permission.granted");
    expect(grantedEvent).toBeTruthy();
    expect(grantedEvent!.payload.decision).toBe("allow_observed");
    expect(grantedEvent!.payload.telemetry_level).toBe("detailed");
  });

  it("handles deny_with_alternative decision", async () => {
    promptDecision = {
      type: "deny_with_alternative",
      reason: "Too dangerous",
      alternative: { tool_name: "safe-tool", suggested_input: { mode: "readonly" } },
    };
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:write:workspace"]);
    const result = await engine.check(req);
    expect(result.allowed).toBe(false);
    expect(result.alternative).toEqual({
      tool_name: "safe-tool",
      suggested_input: { mode: "readonly" },
    });

    const events = await journal.readAll();
    const deniedEvent = events.find(e => e.type === "permission.denied");
    expect(deniedEvent).toBeTruthy();
    expect(deniedEvent!.payload.reason).toBe("Too dangerous");
    expect(deniedEvent!.payload.alternative).toBeDefined();
  });

  it("allow_constrained with scope=always caches globally", async () => {
    promptDecision = {
      type: "allow_constrained",
      scope: "always",
      constraints: { readonly_paths: ["/global"] },
    };
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req);

    // Should be globally granted
    expect(engine.isGranted("filesystem:read:workspace")).toBe(true);
    expect(engine.isGranted("filesystem:read:workspace", "other-session")).toBe(true);
  });

  it("allow_observed with scope=once does not cache in session", async () => {
    promptDecision = {
      type: "allow_observed",
      scope: "once",
      telemetry_level: "basic",
    };
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    const result = await engine.check(req);
    expect(result.allowed).toBe(true);
    expect(result.observed).toBe(true);

    // Should NOT be cached (scope=once → ttl=step)
    expect(engine.isGranted("filesystem:read:workspace", req.session_id)).toBe(false);
  });

  it("clearSession clears constraint and observed caches", async () => {
    promptDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: { readonly_paths: ["/test"] },
    };
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req);

    engine.clearSession(req.session_id);
    expect(engine.isGranted("filesystem:read:workspace", req.session_id)).toBe(false);
  });
});
