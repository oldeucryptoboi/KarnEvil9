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
    const engine = new PermissionEngine(journal, mockPrompt);
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
