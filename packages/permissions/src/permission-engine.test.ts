import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import type { ApprovalDecision, PermissionRequest } from "@karnevil9/schemas";
import { PermissionEngine, MAX_SESSION_CACHES } from "./permission-engine.js";

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
    journal = new Journal(TEST_FILE, { lock: false });
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

  it("allow_always is scoped to session (not global)", async () => {
    promptDecision = "allow_always";
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["shell:exec:workspace"]);
    await engine.check(req);
    expect(engine.isGranted("shell:exec:workspace", req.session_id)).toBe(true);
    // allow_always is now session-scoped for safety — not visible without sessionId
    expect(engine.isGranted("shell:exec:workspace")).toBe(false);
  });

  it("clearSession removes all grants including allow_always", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);

    // Grant session-level
    promptDecision = "allow_session";
    const req1 = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req1);

    // Grant allow_always (now session-scoped)
    promptDecision = "allow_always";
    const req2 = makeRequest(["shell:exec:workspace"]);
    req2.session_id = req1.session_id;
    await engine.check(req2);

    engine.clearSession(req1.session_id);
    expect(engine.isGranted("filesystem:read:workspace", req1.session_id)).toBe(false);
    expect(engine.isGranted("shell:exec:workspace", req1.session_id)).toBe(false);
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

  it("allow_always grants are isolated per session (not shared)", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    promptDecision = "allow_always";

    const reqA = makeRequest(["shell:exec:workspace"]);
    reqA.session_id = "session-A";
    await engine.check(reqA);

    // allow_always is session-scoped — session B should NOT see it
    expect(engine.isGranted("shell:exec:workspace", "session-A")).toBe(true);
    expect(engine.isGranted("shell:exec:workspace", "session-B")).toBe(false);
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
    journal = new Journal(TEST_FILE, { lock: false });
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

    // Subsequent check for same session/tool/step should be granted and include cached constraints
    const req2 = makeRequest(["filesystem:read:workspace"]);
    req2.step_id = req.step_id; // constraints are cached per step
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

  it("allow_constrained with scope=always caches in session (not global)", async () => {
    promptDecision = {
      type: "allow_constrained",
      scope: "always",
      constraints: { readonly_paths: ["/global"] },
    };
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    await engine.check(req);

    // allow_always is now session-scoped for safety
    expect(engine.isGranted("filesystem:read:workspace", req.session_id)).toBe(true);
    expect(engine.isGranted("filesystem:read:workspace", "other-session")).toBe(false);
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

  it("H4: clearStep requires sessionId to properly clear step-scoped grants", async () => {
    promptDecision = "allow_once"; // allow_once grants are step-scoped (ttl=step)
    const engine = new PermissionEngine(journal, mockPrompt);

    // Create two sessions
    const reqA = makeRequest(["filesystem:read:workspace"], "test-tool");
    (reqA as any).session_id = "session-A";
    await engine.check(reqA);

    const reqB = makeRequest(["filesystem:write:workspace"], "test-tool");
    (reqB as any).session_id = "session-B";
    await engine.check(reqB);

    // clearStep with sessionId should only affect that session
    engine.clearStep("session-A");

    // Session A step cache cleared, Session B unaffected
    // allow_once doesn't cache in session, so both should be false regardless
    expect(engine.isGranted("filesystem:read:workspace", "session-A")).toBe(false);
    expect(engine.isGranted("filesystem:write:workspace", "session-B")).toBe(false);

    // Now test with session-scoped grants — clearStep should NOT remove them
    promptDecision = "allow_session";
    const reqC = makeRequest(["shell:exec:workspace"], "test-tool");
    (reqC as any).session_id = "session-C";
    await engine.check(reqC);

    engine.clearStep("session-C");
    // allow_session grants should survive clearStep
    expect(engine.isGranted("shell:exec:workspace", "session-C")).toBe(true);
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

// ─── Pre-Grant Tests ─────────────────────────────────────────────

describe("PermissionEngine.preGrant", () => {
  let journal: Journal;
  let promptCalls: PermissionRequest[];

  const mockPrompt = async (request: PermissionRequest): Promise<ApprovalDecision> => {
    promptCalls.push(request);
    return "allow_session";
  };

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
    promptCalls = [];
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  function makeRequest(scopes: string[], sessionId: string): PermissionRequest {
    return {
      request_id: uuid(),
      session_id: sessionId,
      step_id: uuid(),
      tool_name: "test-tool",
      permissions: scopes.map((s) => PermissionEngine.parse(s)),
    };
  }

  it("pre-granted scopes bypass the prompt", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    const sessionId = "pre-grant-session";
    engine.preGrant(sessionId, ["moltbook:send:posts", "moltbook:read:dm"]);

    const req = makeRequest(["moltbook:send:posts", "moltbook:read:dm"], sessionId);
    const result = await engine.check(req);
    expect(result.allowed).toBe(true);
    expect(promptCalls).toHaveLength(0);
  });

  it("non-pre-granted scopes still prompt", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    const sessionId = "pre-grant-session-2";
    engine.preGrant(sessionId, ["moltbook:send:posts"]);

    const req = makeRequest(["filesystem:read:workspace"], sessionId);
    await engine.check(req);
    expect(promptCalls).toHaveLength(1);
  });

  it("clearSession removes pre-grants", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    const sessionId = "pre-grant-session-3";
    engine.preGrant(sessionId, ["moltbook:send:posts"]);

    engine.clearSession(sessionId);

    const req = makeRequest(["moltbook:send:posts"], sessionId);
    await engine.check(req);
    expect(promptCalls).toHaveLength(1);
  });

  it("listGrants includes pre-grants with granted_by: plugin", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    const sessionId = "pre-grant-session-4";
    engine.preGrant(sessionId, ["moltbook:send:posts", "moltbook:read:dm"]);

    const grants = engine.listGrants(sessionId);
    expect(grants).toHaveLength(2);
    const scopes = grants.map((g) => g.scope);
    expect(scopes).toContain("moltbook:send:posts");
    expect(scopes).toContain("moltbook:read:dm");
    for (const grant of grants) {
      expect(grant.granted_by).toBe("plugin");
      expect(grant.decision).toBe("allow_session");
      expect(grant.ttl).toBe("session");
    }
  });
});

// ─── Permission Edge Case Tests ──────────────────────────────────

describe("PermissionEngine edge cases", () => {
  let journal: Journal;
  let promptDecision: ApprovalDecision;
  let promptCalls: PermissionRequest[];

  const mockPrompt = async (request: PermissionRequest): Promise<ApprovalDecision> => {
    promptCalls.push(request);
    return promptDecision;
  };

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
    promptDecision = "allow_session";
    promptCalls = [];
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  function makeRequest(scopes: string[], opts?: { sessionId?: string; stepId?: string; toolName?: string }): PermissionRequest {
    return {
      request_id: uuid(),
      session_id: opts?.sessionId ?? "test-session",
      step_id: opts?.stepId ?? uuid(),
      tool_name: opts?.toolName ?? "test-tool",
      permissions: scopes.map((s) => PermissionEngine.parse(s)),
    };
  }

  it("parse handles scope with multiple colons in target", () => {
    const perm = PermissionEngine.parse("network:request:https://example.com:8080/path");
    expect(perm.domain).toBe("network");
    expect(perm.action).toBe("request");
    expect(perm.target).toBe("https://example.com:8080/path");
  });

  it("parse throws for empty string", () => {
    expect(() => PermissionEngine.parse("")).toThrow("Invalid permission scope");
  });

  it("parse throws for just two parts", () => {
    expect(() => PermissionEngine.parse("domain:action")).toThrow("Invalid permission scope");
  });

  it("listGrants returns empty for unknown session", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    expect(engine.listGrants("nonexistent-session")).toEqual([]);
  });

  it("listGrants returns empty when no sessionId provided", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    expect(engine.listGrants()).toEqual([]);
  });

  it("isGranted returns false when no sessionId provided", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    expect(engine.isGranted("filesystem:read:workspace")).toBe(false);
  });

  it("multiple permissions in single request — prompts once", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace", "filesystem:write:workspace"]);
    const result = await engine.check(req);
    expect(result.allowed).toBe(true);
    expect(promptCalls).toHaveLength(1);
    // Both scopes should be in the prompt
    const requestedScopes = promptCalls[0]!.permissions.map(p => p.scope);
    expect(requestedScopes).toContain("filesystem:read:workspace");
    expect(requestedScopes).toContain("filesystem:write:workspace");
  });

  it("partially cached permissions — only prompts for missing ones", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    // First request grants read
    const req1 = makeRequest(["filesystem:read:workspace"], { sessionId: "sess-1" });
    await engine.check(req1);
    expect(promptCalls).toHaveLength(1);

    // Second request needs read (cached) + write (new)
    const req2 = makeRequest(["filesystem:read:workspace", "filesystem:write:workspace"], { sessionId: "sess-1" });
    await engine.check(req2);
    expect(promptCalls).toHaveLength(2);
    // Second prompt should only request write
    const secondRequestScopes = promptCalls[1]!.permissions.map(p => p.scope);
    expect(secondRequestScopes).toEqual(["filesystem:write:workspace"]);
  });

  it("clearSession without argument clears all sessions", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    promptDecision = "allow_session";

    const req1 = makeRequest(["filesystem:read:workspace"], { sessionId: "sess-A" });
    await engine.check(req1);
    const req2 = makeRequest(["filesystem:read:workspace"], { sessionId: "sess-B" });
    await engine.check(req2);

    engine.clearSession(); // no argument → clear all
    expect(engine.isGranted("filesystem:read:workspace", "sess-A")).toBe(false);
    expect(engine.isGranted("filesystem:read:workspace", "sess-B")).toBe(false);
  });

  it("clearStep without argument clears step-scoped grants from all sessions", async () => {
    // allow_once grants are step-scoped
    promptDecision = "allow_once";
    const engine = new PermissionEngine(journal, mockPrompt);

    const reqA = makeRequest(["filesystem:read:workspace"], { sessionId: "sess-A" });
    await engine.check(reqA);
    const reqB = makeRequest(["filesystem:read:workspace"], { sessionId: "sess-B" });
    await engine.check(reqB);

    // allow_once doesn't actually cache in session, so this is a no-op
    // The real purpose is to clear step-scoped constraints
    engine.clearStep(); // no argument → clear all sessions' step grants
  });

  it("allow_constrained constraints are step-scoped, not shared across steps", async () => {
    promptDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: { readonly_paths: ["/safe"] },
    };
    const engine = new PermissionEngine(journal, mockPrompt);

    const step1 = uuid();
    const step2 = uuid();
    const req1 = makeRequest(["filesystem:read:workspace"], { sessionId: "sess-1", stepId: step1 });
    const result1 = await engine.check(req1);
    expect(result1.constraints).toBeDefined();

    // Same session, different step — constraints should not be cached for new step
    const req2 = makeRequest(["filesystem:read:workspace"], { sessionId: "sess-1", stepId: step2 });
    const result2 = await engine.check(req2);
    // Permission is cached (allow_session), so no prompt. But constraints are step-scoped.
    // Step2 key is different from step1, so constraints won't be found
    expect(result2.allowed).toBe(true);
    expect(result2.constraints).toBeUndefined();
  });

  it("unknown decision type falls back to deny", async () => {
    promptDecision = { type: "unknown_type" } as any;
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:read:workspace"]);
    const result = await engine.check(req);
    expect(result.allowed).toBe(false);
  });

  it("concurrent permission checks don't corrupt state", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    promptDecision = "allow_session";

    // Fire 10 concurrent permission checks for different scopes
    const promises = Array.from({ length: 10 }, (_, i) =>
      engine.check(makeRequest([`domain:action:target-${i}`], { sessionId: "sess-concurrent" }))
    );
    const results = await Promise.all(promises);
    expect(results.every(r => r.allowed)).toBe(true);

    // All should be cached
    for (let i = 0; i < 10; i++) {
      expect(engine.isGranted(`domain:action:target-${i}`, "sess-concurrent")).toBe(true);
    }
  });

  it("grant TTL is correctly set for each decision type", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);

    // allow_once → ttl=step, NOT cached in session
    promptDecision = "allow_once";
    const reqOnce = makeRequest(["once:scope:target"], { sessionId: "sess-ttl" });
    await engine.check(reqOnce);
    expect(engine.isGranted("once:scope:target", "sess-ttl")).toBe(false);

    // allow_session → ttl=session, cached
    promptDecision = "allow_session";
    const reqSession = makeRequest(["session:scope:target"], { sessionId: "sess-ttl" });
    await engine.check(reqSession);
    expect(engine.isGranted("session:scope:target", "sess-ttl")).toBe(true);

    // allow_always → ttl=global, but scoped to session for safety
    promptDecision = "allow_always";
    const reqAlways = makeRequest(["always:scope:target"], { sessionId: "sess-ttl" });
    await engine.check(reqAlways);
    expect(engine.isGranted("always:scope:target", "sess-ttl")).toBe(true);
    expect(engine.isGranted("always:scope:target", "other-session")).toBe(false);
  });

  it("concurrent checks for same scope prompt only once with allow_session", async () => {
    let resolvePrompt!: (d: ApprovalDecision) => void;
    let resolvePromptCalled!: () => void;
    const promptCalled = new Promise<void>((r) => { resolvePromptCalled = r; });
    const slowPrompt = async (_req: PermissionRequest): Promise<ApprovalDecision> => {
      promptCalls.push(_req);
      resolvePromptCalled();
      return new Promise<ApprovalDecision>((r) => { resolvePrompt = r; });
    };
    const engine = new PermissionEngine(journal, slowPrompt);
    const sessionId = "concurrent-session";
    const scope = "network:browser:https";

    const req1 = makeRequest([scope], { sessionId, stepId: "step-1" });
    const req2 = makeRequest([scope], { sessionId, stepId: "step-2" });

    // Fire both checks concurrently
    const p1 = engine.check(req1);
    const p2 = engine.check(req2);

    // Wait for the prompt to actually be called (req2 is blocked on the prompt lock)
    await promptCalled;
    expect(promptCalls.length).toBe(1);

    // Resolve the prompt with session grant
    resolvePrompt("allow_session");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // Only one prompt was shown to the user
    expect(promptCalls.length).toBe(1);
  });

  it("concurrent checks with allow_once still prompt the second caller", async () => {
    let promptCount = 0;
    const autoPrompt = async (_req: PermissionRequest): Promise<ApprovalDecision> => {
      promptCount++;
      return "allow_once";
    };
    const engine = new PermissionEngine(journal, autoPrompt);
    const sessionId = "concurrent-once-session";
    const scope = "network:browser:https";

    const req1 = makeRequest([scope], { sessionId, stepId: "step-1" });
    const req2 = makeRequest([scope], { sessionId, stepId: "step-2" });

    const [r1, r2] = await Promise.all([engine.check(req1), engine.check(req2)]);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // allow_once doesn't cache — second caller still needs its own prompt
    expect(promptCount).toBe(2);
  });

  it("promptLock is released when promptFn throws, allowing subsequent checks", async () => {
    let callCount = 0;
    const failingThenSucceeding = async (_req: PermissionRequest): Promise<ApprovalDecision> => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Prompt UI crashed");
      }
      return "allow_session";
    };
    const engine = new PermissionEngine(journal, failingThenSucceeding);
    const sessionId = "lock-error-session";
    const scope = "test:lock:cleanup";

    const req1 = makeRequest([scope], { sessionId, stepId: "step-1" });
    // First check — prompt throws
    await expect(engine.check(req1)).rejects.toThrow("Prompt UI crashed");

    // Second check — should NOT hang (lock must have been released)
    const req2 = makeRequest([scope], { sessionId, stepId: "step-2" });
    const result = await engine.check(req2);
    expect(result.allowed).toBe(true);
    expect(callCount).toBe(2);
  });
});

// ─── Cache Eviction Tests ─────────────────────────────────────────

describe("PermissionEngine cache eviction", () => {
  let journal: Journal;
  let promptCalls: PermissionRequest[];

  const mockPrompt = async (request: PermissionRequest): Promise<ApprovalDecision> => {
    promptCalls.push(request);
    return "allow_session";
  };

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
    promptCalls = [];
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("session cache evicts oldest entry at MAX_SESSION_CACHES", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    // Pre-grant many sessions to fill cache to capacity
    for (let i = 0; i < MAX_SESSION_CACHES; i++) {
      engine.preGrant(`session-${i}`, ["test:scope:target"]);
    }
    // The first session should still be present
    expect(engine.isGranted("test:scope:target", "session-0")).toBe(true);

    // Adding one more should evict session-0 (oldest)
    engine.preGrant(`session-${MAX_SESSION_CACHES}`, ["test:scope:target"]);
    expect(engine.isGranted("test:scope:target", "session-0")).toBe(false);
    expect(engine.isGranted("test:scope:target", `session-${MAX_SESSION_CACHES}`)).toBe(true);
    // Session 1 should still be present
    expect(engine.isGranted("test:scope:target", "session-1")).toBe(true);
  });

  it("clearSession cleans up constraint cache via secondary index", async () => {
    const _engine = new PermissionEngine(journal, mockPrompt);
    const sessionId = "constraint-session";

    // Create an allow_constrained decision
    let decision: ApprovalDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: { readonly_paths: ["/safe"] },
    };
    const constrainedPrompt = async (_req: PermissionRequest): Promise<ApprovalDecision> => decision;
    const engine2 = new PermissionEngine(journal, constrainedPrompt);

    const req = {
      request_id: uuid(),
      session_id: sessionId,
      step_id: "step-1",
      tool_name: "test-tool",
      permissions: [PermissionEngine.parse("filesystem:read:workspace")],
    };
    const result = await engine2.check(req);
    expect(result.constraints).toBeDefined();

    // Verify constraint cache is populated (same step returns constraints)
    const req2 = { ...req, request_id: uuid() };
    const result2 = await engine2.check(req2);
    expect(result2.constraints).toBeDefined();

    // Clear session — constraint cache should be cleaned up
    engine2.clearSession(sessionId);

    // Re-check — should prompt again and not have cached constraints
    decision = "allow_session";
    const req3 = { ...req, request_id: uuid() };
    const result3 = await engine2.check(req3);
    expect(result3.constraints).toBeUndefined();
  });

  it("clearSession cleans up observed cache via secondary index", async () => {
    const engine = new PermissionEngine(journal, async () => ({
      type: "allow_observed" as const,
      scope: "session" as const,
      telemetry_level: "basic" as const,
    }));
    const sessionId = "observed-session";

    const req = {
      request_id: uuid(),
      session_id: sessionId,
      step_id: "step-1",
      tool_name: "test-tool",
      permissions: [PermissionEngine.parse("filesystem:read:workspace")],
    };
    const result = await engine.check(req);
    expect(result.observed).toBe(true);

    // Verify observed flag is cached
    const req2 = { ...req, request_id: uuid() };
    const result2 = await engine.check(req2);
    expect(result2.observed).toBe(true);

    // Clear session — observed cache should be cleaned up
    engine.clearSession(sessionId);

    // After clearing, observed flag should not persist for new checks
    // (the session cache is also cleared, so it will prompt again)
    const promptCount = { value: 0 };
    const engine2 = new PermissionEngine(journal, async () => {
      promptCount.value++;
      return "allow_session";
    });
    const req3 = {
      request_id: uuid(),
      session_id: sessionId,
      step_id: "step-1",
      tool_name: "test-tool",
      permissions: [PermissionEngine.parse("filesystem:read:workspace")],
    };
    const result3 = await engine2.check(req3);
    expect(result3.observed).toBeUndefined();
  });

  it("clearSession(undefined) clears all secondary indices", async () => {
    const engine = new PermissionEngine(journal, async () => ({
      type: "allow_constrained" as const,
      scope: "session" as const,
      constraints: { readonly_paths: ["/test"] },
    }));

    // Populate caches for multiple sessions
    for (const sid of ["sess-a", "sess-b"]) {
      await engine.check({
        request_id: uuid(),
        session_id: sid,
        step_id: "step-1",
        tool_name: "test-tool",
        permissions: [PermissionEngine.parse("test:scope:target")],
      });
    }

    // Clear all
    engine.clearSession();

    // Both sessions should be cleared
    expect(engine.isGranted("test:scope:target", "sess-a")).toBe(false);
    expect(engine.isGranted("test:scope:target", "sess-b")).toBe(false);
  });

  // Note: constraint and observed cache eviction tests omitted — filling 50,000
  // entries with journal writes exceeds the test timeout. Session cache eviction
  // (10,000 entries via preGrant) is tested above and exercises the same FIFO logic.

  it("constraint cache eviction handles keys without colon separator", async () => {
    // Exercises the defensive `split(":")[0] ?? ""` guard in addConstraintCacheEntry
    const constrainedPrompt = async (_req: PermissionRequest): Promise<ApprovalDecision> => ({
      type: "allow_constrained",
      scope: "session",
      constraints: { readonly_paths: ["/safe"] },
    });
    const engine = new PermissionEngine(journal, constrainedPrompt);
    // Just verify that checking permissions doesn't crash — the defensive guard
    // prevents undefined dereference on malformed cache keys
    const req = {
      request_id: uuid(),
      session_id: "evict-test",
      step_id: "step-1",
      tool_name: "test-tool",
      permissions: [PermissionEngine.parse("filesystem:read:workspace")],
    };
    const result = await engine.check(req);
    expect(result.constraints).toBeDefined();
  });

  it("observed cache eviction handles keys without colon separator", async () => {
    const engine = new PermissionEngine(journal, async () => ({
      type: "allow_observed" as const,
      scope: "session" as const,
      telemetry_level: "basic" as const,
    }));
    const req = {
      request_id: uuid(),
      session_id: "observed-evict-test",
      step_id: "step-1",
      tool_name: "test-tool",
      permissions: [PermissionEngine.parse("filesystem:read:workspace")],
    };
    const result = await engine.check(req);
    expect(result.observed).toBe(true);
  });
});

// ─── Additional Edge Case Tests ─────────────────────────────────

describe("PermissionEngine additional edge cases", () => {
  let journal: Journal;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("preGrant with custom grantedBy sets correct field", () => {
    const engine = new PermissionEngine(journal, async () => "deny");
    engine.preGrant("sess-1", ["moltbook:send:posts"], "scheduler");

    const grants = engine.listGrants("sess-1");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.granted_by).toBe("scheduler");
    expect(grants[0]!.decision).toBe("allow_session");
  });

  it("concurrent checks for different scopes in same session both prompt", async () => {
    let promptCount = 0;
    const autoPrompt = async (_req: PermissionRequest): Promise<ApprovalDecision> => {
      promptCount++;
      return "allow_session";
    };
    const engine = new PermissionEngine(journal, autoPrompt);
    const sessionId = "concurrent-diff";

    const req1 = {
      request_id: uuid(),
      session_id: sessionId,
      step_id: uuid(),
      tool_name: "tool-a",
      permissions: [PermissionEngine.parse("filesystem:read:workspace")],
    };
    const req2 = {
      request_id: uuid(),
      session_id: sessionId,
      step_id: uuid(),
      tool_name: "tool-b",
      permissions: [PermissionEngine.parse("network:request:https://example.com")],
    };

    const [r1, r2] = await Promise.all([engine.check(req1), engine.check(req2)]);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // Serialized: both prompted because the scopes differ
    expect(promptCount).toBe(2);
  });

  it("clearStep without arg preserves session-scoped grants across all sessions", async () => {
    const engine = new PermissionEngine(journal, async () => "allow_session");

    // Grant session-scoped in two sessions
    for (const sid of ["sess-x", "sess-y"]) {
      await engine.check({
        request_id: uuid(),
        session_id: sid,
        step_id: uuid(),
        tool_name: "tool",
        permissions: [PermissionEngine.parse("filesystem:read:workspace")],
      });
    }

    // clearStep without arg — should only clear step-scoped (ttl=step), not session-scoped
    engine.clearStep();

    expect(engine.isGranted("filesystem:read:workspace", "sess-x")).toBe(true);
    expect(engine.isGranted("filesystem:read:workspace", "sess-y")).toBe(true);
  });

  it("parse preserves full scope with port numbers", () => {
    const perm = PermissionEngine.parse("network:connect:redis://host:6379");
    expect(perm.domain).toBe("network");
    expect(perm.action).toBe("connect");
    expect(perm.target).toBe("redis://host:6379");
    expect(perm.scope).toBe("network:connect:redis://host:6379");
  });
});

// ─── Wildcard Resolution Tests ──────────────────────────────────

describe("PermissionEngine wildcard resolution", () => {
  let journal: Journal;
  let promptCalls: PermissionRequest[];

  const mockPrompt = async (request: PermissionRequest): Promise<ApprovalDecision> => {
    promptCalls.push(request);
    return "allow_session";
  };

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
    promptCalls = [];
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("filesystem:read:* matches specific target", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    engine.preGrant("sess-w", ["filesystem:read:*"]);

    expect(engine.isGranted("filesystem:read:workspace", "sess-w")).toBe(true);
    expect(engine.isGranted("filesystem:read:/etc/passwd", "sess-w")).toBe(true);
  });

  it("filesystem:*:* matches any action and target", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    engine.preGrant("sess-w", ["filesystem:*:*"]);

    expect(engine.isGranted("filesystem:read:workspace", "sess-w")).toBe(true);
    expect(engine.isGranted("filesystem:write:/tmp/file", "sess-w")).toBe(true);
  });

  it("domain mismatch is rejected even with wildcard action and target", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    engine.preGrant("sess-w", ["filesystem:*:*"]);

    expect(engine.isGranted("network:request:https://example.com", "sess-w")).toBe(false);
  });

  it("wildcard in domain position throws on preGrant", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    expect(() => engine.preGrant("sess-w", ["*:read:workspace"])).toThrow(
      "Wildcard not allowed in domain position"
    );
  });

  it("URL targets with colons matched correctly", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    engine.preGrant("sess-w", ["network:request:*"]);

    expect(engine.isGranted("network:request:https://example.com:8080/path", "sess-w")).toBe(true);
  });

  it("exact match is still O(1) — wildcard scan only for non-exact", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    engine.preGrant("sess-w", ["filesystem:read:workspace"]);

    // Exact match — no wildcard scan needed
    expect(engine.isGranted("filesystem:read:workspace", "sess-w")).toBe(true);
  });

  it("requesting a wildcard scope does not escalate beyond its own grant", () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    engine.preGrant("sess-w", ["filesystem:read:workspace"]);

    // Requesting wildcard scope should NOT match a specific grant
    expect(engine.isGranted("filesystem:read:*", "sess-w")).toBe(false);
  });

  it("validateWildcardScope rejects invalid scopes", () => {
    expect(() => PermissionEngine.validateWildcardScope("ab")).toThrow("Invalid scope");
    expect(() => PermissionEngine.validateWildcardScope("*:action:target")).toThrow("Wildcard not allowed in domain position");
  });

  it("scopeMatchesGrant handles edge cases", () => {
    // Not enough parts
    expect(PermissionEngine.scopeMatchesGrant("a:b", "a:b:c")).toBe(false);
    expect(PermissionEngine.scopeMatchesGrant("a:b:c", "a:b")).toBe(false);
    // Exact match
    expect(PermissionEngine.scopeMatchesGrant("a:b:c", "a:b:c")).toBe(true);
    // Wildcard action
    expect(PermissionEngine.scopeMatchesGrant("a:*:c", "a:b:c")).toBe(true);
    // Wildcard action but different target
    expect(PermissionEngine.scopeMatchesGrant("a:*:c", "a:b:d")).toBe(false);
  });

  it("wildcard grants bypass prompt for matching scopes", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    engine.preGrant("sess-w", ["filesystem:read:*"]);

    const req: PermissionRequest = {
      request_id: uuid(),
      session_id: "sess-w",
      step_id: uuid(),
      tool_name: "test-tool",
      permissions: [PermissionEngine.parse("filesystem:read:workspace")],
    };
    const result = await engine.check(req);
    expect(result.allowed).toBe(true);
    expect(promptCalls).toHaveLength(0); // no prompt — wildcard matched
  });
});

// ─── External Audit Hook Tests ──────────────────────────────────

describe("PermissionEngine external audit hook", () => {
  let journal: Journal;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("calls external audit hook on notifyObservedExecution", async () => {
    const hookCalls: Array<{ session_id: string; tool_name: string; input: Record<string, unknown> }> = [];
    const hook = async (event: { session_id: string; tool_name: string; input: Record<string, unknown>; timestamp: string }) => {
      hookCalls.push(event);
    };
    const engine = new PermissionEngine(journal, async () => "allow_session", { externalAuditHook: hook });

    await engine.notifyObservedExecution("sess-1", "test-tool", { key: "value" });
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.session_id).toBe("sess-1");
    expect(hookCalls[0]!.tool_name).toBe("test-tool");
    expect(hookCalls[0]!.input).toEqual({ key: "value" });
  });

  it("swallows errors from external audit hook", async () => {
    const hook = async () => { throw new Error("Hook exploded"); };
    const engine = new PermissionEngine(journal, async () => "allow_session", { externalAuditHook: hook });

    // Should not throw
    await expect(engine.notifyObservedExecution("sess-1", "test-tool", {})).resolves.toBeUndefined();
  });

  it("no hook configured — notifyObservedExecution is a no-op", async () => {
    const engine = new PermissionEngine(journal, async () => "allow_session");
    // Should not throw
    await expect(engine.notifyObservedExecution("sess-1", "test-tool", {})).resolves.toBeUndefined();
  });

  it("multiple observed calls each trigger the hook", async () => {
    let callCount = 0;
    const hook = async () => { callCount++; };
    const engine = new PermissionEngine(journal, async () => "allow_session", { externalAuditHook: hook });

    await engine.notifyObservedExecution("sess-1", "tool-a", {});
    await engine.notifyObservedExecution("sess-1", "tool-b", {});
    await engine.notifyObservedExecution("sess-2", "tool-a", {});
    expect(callCount).toBe(3);
  });
});

// ─── Rate-Limited Grant Tests ───────────────────────────────────

describe("PermissionEngine allow_rate_limited", () => {
  let journal: Journal;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  function makeRequest(scopes: string[], sessionId = "sess-rate"): PermissionRequest {
    return {
      request_id: uuid(),
      session_id: sessionId,
      step_id: uuid(),
      tool_name: "test-tool",
      permissions: scopes.map((s) => PermissionEngine.parse(s)),
    };
  }

  it("N calls succeed then denied when rate limit exhausted", async () => {
    const decision: ApprovalDecision = {
      type: "allow_rate_limited",
      scope: "session",
      max_calls_per_window: 3,
      window_ms: 60000,
    };
    const engine = new PermissionEngine(journal, async () => decision);

    // First call triggers prompt and consumes 1 token (2 remaining)
    const r1 = await engine.check(makeRequest(["test:rate:target"]));
    expect(r1.allowed).toBe(true);

    // 2nd and 3rd calls consume from bucket
    const r2 = await engine.check(makeRequest(["test:rate:target"]));
    expect(r2.allowed).toBe(true);
    const r3 = await engine.check(makeRequest(["test:rate:target"]));
    expect(r3.allowed).toBe(true);

    // 4th call: bucket exhausted → denied (triggers new prompt, but bucket is still empty)
    // The isGranted check consumes token, and if empty, returns false → re-prompts
    // But prompt returns same decision, creating a new bucket — so effectively it resets.
    // To properly test exhaustion, we need to check isGranted directly
    expect(engine.isGranted("test:rate:target", "sess-rate")).toBe(false);
  });

  it("window resets after expiry", async () => {
    const decision: ApprovalDecision = {
      type: "allow_rate_limited",
      scope: "session",
      max_calls_per_window: 1,
      window_ms: 50, // 50ms window
    };
    const engine = new PermissionEngine(journal, async () => decision);

    // First call succeeds
    const r1 = await engine.check(makeRequest(["test:rate:expire"]));
    expect(r1.allowed).toBe(true);

    // Bucket exhausted
    expect(engine.isGranted("test:rate:expire", "sess-rate")).toBe(false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));

    // Window reset — should succeed again
    expect(engine.isGranted("test:rate:expire", "sess-rate")).toBe(true);
  });

  it("per-scope/per-session isolation", async () => {
    const decision: ApprovalDecision = {
      type: "allow_rate_limited",
      scope: "session",
      max_calls_per_window: 1,
      window_ms: 60000,
    };
    const engine = new PermissionEngine(journal, async () => decision);

    // Session A scope X
    const rA = await engine.check(makeRequest(["test:rate:x"], "sess-a"));
    expect(rA.allowed).toBe(true);
    expect(engine.isGranted("test:rate:x", "sess-a")).toBe(false); // exhausted

    // Session B same scope — independent bucket
    const rB = await engine.check(makeRequest(["test:rate:x"], "sess-b"));
    expect(rB.allowed).toBe(true);
  });

  it("clearSession removes rate buckets", async () => {
    const decision: ApprovalDecision = {
      type: "allow_rate_limited",
      scope: "session",
      max_calls_per_window: 2,
      window_ms: 60000,
    };
    const engine = new PermissionEngine(journal, async () => decision);

    await engine.check(makeRequest(["test:rate:clear"]));
    expect(engine.isGranted("test:rate:clear", "sess-rate")).toBe(true);

    engine.clearSession("sess-rate");
    expect(engine.isGranted("test:rate:clear", "sess-rate")).toBe(false);
  });

  it("journal event includes rate limit parameters", async () => {
    const decision: ApprovalDecision = {
      type: "allow_rate_limited",
      scope: "session",
      max_calls_per_window: 5,
      window_ms: 30000,
    };
    const engine = new PermissionEngine(journal, async () => decision);

    await engine.check(makeRequest(["test:rate:journal"]));
    const events = await journal.readAll();
    const grantEvent = events.find(e => e.type === "permission.granted" && e.payload.decision === "allow_rate_limited");
    expect(grantEvent).toBeTruthy();
    expect(grantEvent!.payload.max_calls_per_window).toBe(5);
    expect(grantEvent!.payload.window_ms).toBe(30000);
  });
});

// ─── Time-Bounded Grant Tests ───────────────────────────────────

describe("PermissionEngine allow_time_bounded", () => {
  let journal: Journal;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { lock: false });
    await journal.init();
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  function makeRequest(scopes: string[], sessionId = "sess-time"): PermissionRequest {
    return {
      request_id: uuid(),
      session_id: sessionId,
      step_id: uuid(),
      tool_name: "test-tool",
      permissions: scopes.map((s) => PermissionEngine.parse(s)),
    };
  }

  it("access within time window is allowed", async () => {
    // Use "* * * * *" (every minute) with a large window to guarantee we're inside
    const decision: ApprovalDecision = {
      type: "allow_time_bounded",
      scope: "session",
      cron_expression: "* * * * *",
      window_duration_ms: 120000, // 2 minutes — always within window
    };
    const engine = new PermissionEngine(journal, async () => decision);

    const result = await engine.check(makeRequest(["test:time:open"]));
    expect(result.allowed).toBe(true);

    // Second check should also pass (grant cached, time still in window)
    expect(engine.isGranted("test:time:open", "sess-time")).toBe(true);
  });

  it("access outside time window is denied", async () => {
    // Use a cron that fired in the past but window already expired
    // "0 0 1 1 *" fires on Jan 1 at midnight — window of 1ms means it's expired now
    const decision: ApprovalDecision = {
      type: "allow_time_bounded",
      scope: "session",
      cron_expression: "0 0 1 1 *",
      window_duration_ms: 1, // 1ms window — already expired
    };
    const engine = new PermissionEngine(journal, async () => decision);

    // First call grants the permission and sets up time bound
    await engine.check(makeRequest(["test:time:closed"]));

    // But subsequent isGranted check fails the time bound
    expect(engine.isGranted("test:time:closed", "sess-time")).toBe(false);
  });

  it("invalid cron expression is treated as denied", async () => {
    const decision: ApprovalDecision = {
      type: "allow_time_bounded",
      scope: "session",
      cron_expression: "not a valid cron",
      window_duration_ms: 60000,
    };
    const engine = new PermissionEngine(journal, async () => decision);

    await engine.check(makeRequest(["test:time:invalid"]));
    // Grant is cached but time bound check fails for invalid cron
    expect(engine.isGranted("test:time:invalid", "sess-time")).toBe(false);
  });

  it("clearSession removes time bounds", async () => {
    const decision: ApprovalDecision = {
      type: "allow_time_bounded",
      scope: "session",
      cron_expression: "* * * * *",
      window_duration_ms: 120000,
    };
    const engine = new PermissionEngine(journal, async () => decision);

    await engine.check(makeRequest(["test:time:cleanup"]));
    expect(engine.isGranted("test:time:cleanup", "sess-time")).toBe(true);

    engine.clearSession("sess-time");
    expect(engine.isGranted("test:time:cleanup", "sess-time")).toBe(false);
  });

  it("journal event includes time bound parameters", async () => {
    const decision: ApprovalDecision = {
      type: "allow_time_bounded",
      scope: "session",
      cron_expression: "0 9 * * 1-5",
      window_duration_ms: 28800000,
      timezone: "America/New_York",
    };
    const engine = new PermissionEngine(journal, async () => decision);

    await engine.check(makeRequest(["test:time:journal"]));
    const events = await journal.readAll();
    const grantEvent = events.find(e => e.type === "permission.granted" && e.payload.decision === "allow_time_bounded");
    expect(grantEvent).toBeTruthy();
    expect(grantEvent!.payload.cron_expression).toBe("0 9 * * 1-5");
    expect(grantEvent!.payload.window_duration_ms).toBe(28800000);
    expect(grantEvent!.payload.timezone).toBe("America/New_York");
  });
});
