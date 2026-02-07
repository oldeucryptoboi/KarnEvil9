import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@openflaw/journal";
import type { ApprovalDecision, PermissionRequest } from "@openflaw/schemas";
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
    expect(result).toBe(true);
    expect(promptCalls).toHaveLength(1);
  });

  it("denies when prompt returns deny", async () => {
    promptDecision = "deny";
    const engine = new PermissionEngine(journal, mockPrompt);
    const req = makeRequest(["filesystem:write:workspace"]);
    const result = await engine.check(req);
    expect(result).toBe(false);
  });

  it("caches session grants and skips prompt on second check", async () => {
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
    expect(engine.isGranted("shell:exec:workspace")).toBe(true);
  });

  it("clearSession removes session grants but keeps global", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);

    // Grant session-level
    promptDecision = "allow_session";
    await engine.check(makeRequest(["filesystem:read:workspace"]));

    // Grant global-level
    promptDecision = "allow_always";
    await engine.check(makeRequest(["shell:exec:workspace"]));

    engine.clearSession();
    expect(engine.isGranted("filesystem:read:workspace")).toBe(false);
    expect(engine.isGranted("shell:exec:workspace")).toBe(true); // global survives
  });

  it("clearStep removes step-level grants only", async () => {
    promptDecision = "allow_once";
    const engine = new PermissionEngine(journal, mockPrompt);
    await engine.check(makeRequest(["filesystem:read:workspace"]));
    expect(engine.isGranted("filesystem:read:workspace")).toBe(false); // allow_once doesn't cache in session

    // allow_session should survive clearStep
    promptDecision = "allow_session";
    await engine.check(makeRequest(["filesystem:write:workspace"]));
    engine.clearStep();
    expect(engine.isGranted("filesystem:write:workspace")).toBe(true);
  });

  it("listGrants returns all active grants", async () => {
    const engine = new PermissionEngine(journal, mockPrompt);
    promptDecision = "allow_session";
    await engine.check(makeRequest(["filesystem:read:workspace"]));
    promptDecision = "allow_always";
    await engine.check(makeRequest(["shell:exec:workspace"]));

    const grants = engine.listGrants();
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
});
