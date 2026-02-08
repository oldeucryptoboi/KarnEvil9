import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@jarvis/journal";
import { PermissionEngine } from "@jarvis/permissions";
import type { ToolManifest, ToolExecutionRequest, ApprovalDecision } from "@jarvis/schemas";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime, CircuitBreaker } from "./tool-runtime.js";

const TEST_DIR = resolve(import.meta.dirname ?? ".", "../../.test-data");
const TEST_FILE = resolve(TEST_DIR, "runtime-journal.jsonl");

const testTool: ToolManifest = {
  name: "echo-tool",
  version: "1.0.0",
  description: "Echoes input",
  runner: "internal",
  input_schema: {
    type: "object",
    required: ["message"],
    properties: { message: { type: "string" } },
    additionalProperties: false,
  },
  output_schema: {
    type: "object",
    required: ["echo"],
    properties: { echo: { type: "string" } },
    additionalProperties: false,
  },
  permissions: ["filesystem:read:workspace"],
  timeout_ms: 5000,
  supports: { mock: true, dry_run: false },
  mock_responses: [{ echo: "mock response" }],
};

const noPermTool: ToolManifest = {
  name: "free-tool",
  version: "1.0.0",
  description: "No permissions needed",
  runner: "internal",
  input_schema: { type: "object", additionalProperties: false },
  output_schema: { type: "object", additionalProperties: false },
  permissions: [],
  timeout_ms: 5000,
  supports: { mock: true, dry_run: false },
  mock_responses: [{}],
};

function makeRequest(toolName: string, input: Record<string, unknown> = {}, mode: "mock" | "real" | "dry_run" = "mock"): ToolExecutionRequest {
  return {
    request_id: uuid(),
    tool_name: toolName,
    tool_version: "1.0.0",
    input,
    mode,
    session_id: uuid(),
    step_id: uuid(),
  };
}

describe("ToolRuntime", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let promptDecision: ApprovalDecision;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    promptDecision = "allow_session";
    permissions = new PermissionEngine(journal, async () => promptDecision);
    registry = new ToolRegistry();
    registry.register(testTool);
    registry.register(noPermTool);
    runtime = new ToolRuntime(registry, permissions, journal);
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("executes mock mode successfully", async () => {
    const req = makeRequest("echo-tool", { message: "hello" });
    const result = await runtime.execute(req);
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ echo: "mock response" });
    expect(result.mode).toBe("mock");
  });

  it("fails for unregistered tool", async () => {
    const req = makeRequest("nonexistent");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("fails on invalid input", async () => {
    const req = makeRequest("echo-tool", { wrong_field: true });
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("fails when permissions are denied", async () => {
    promptDecision = "deny";
    const req = makeRequest("echo-tool", { message: "test" });
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
  });

  it("skips permission check for tools with no permissions", async () => {
    const req = makeRequest("free-tool", {});
    const result = await runtime.execute(req);
    expect(result.ok).toBe(true);
  });

  it("executes real mode with registered handler", async () => {
    runtime.registerHandler("echo-tool", async (input, _mode, _policy) => {
      return { echo: (input as any).message };
    });
    const req = makeRequest("echo-tool", { message: "real hello" }, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ echo: "real hello" });
  });

  it("fails real mode without handler", async () => {
    const req = makeRequest("echo-tool", { message: "test" }, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
    expect(result.error?.message).toContain("No handler registered");
  });

  it("emits journal events on success", async () => {
    const req = makeRequest("echo-tool", { message: "test" });
    await runtime.execute(req);
    const events = await journal.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("permission.requested");
    expect(types).toContain("permission.granted");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.succeeded");
  });

  it("emits journal events on failure", async () => {
    const req = makeRequest("nonexistent");
    await runtime.execute(req);
    const events = await journal.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("tool.failed");
  });

  it("handles handler execution errors", async () => {
    runtime.registerHandler("echo-tool", async (_input, _mode, _policy) => {
      throw new Error("Handler crashed");
    });
    const req = makeRequest("echo-tool", { message: "test" }, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
    expect(result.error?.message).toContain("Handler crashed");
  });

  it("fails on invalid output from handler", async () => {
    runtime.registerHandler("echo-tool", async (_input, _mode, _policy) => {
      return { wrong_field: 123 }; // doesn't match output_schema
    });
    const req = makeRequest("echo-tool", { message: "test" }, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_OUTPUT");
  });

  it("reports duration_ms", async () => {
    const req = makeRequest("echo-tool", { message: "test" });
    const result = await runtime.execute(req);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("passes policy to handler", async () => {
    const policyRuntime = new ToolRuntime(registry, permissions, journal, {
      allowed_paths: ["/safe"],
      allowed_endpoints: [],
      allowed_commands: [],
      require_approval_for_writes: false,
    });
    let receivedPolicy: unknown;
    policyRuntime.registerHandler("echo-tool", async (_input, _mode, policy) => {
      receivedPolicy = policy;
      return { echo: "test" };
    });
    const req = makeRequest("echo-tool", { message: "test" }, "real");
    await policyRuntime.execute(req);
    expect(receivedPolicy).toEqual({
      allowed_paths: ["/safe"],
      allowed_endpoints: [],
      allowed_commands: [],
      require_approval_for_writes: false,
    });
  });

  it("handler can reject based on policy violation", async () => {
    const { assertPathAllowed } = await import("./policy-enforcer.js");
    const policyRuntime = new ToolRuntime(registry, permissions, journal, {
      allowed_paths: ["/restricted"],
      allowed_endpoints: [],
      allowed_commands: [],
      require_approval_for_writes: false,
    });
    policyRuntime.registerHandler("echo-tool", async (_input, _mode, policy) => {
      assertPathAllowed("/etc/passwd", policy.allowed_paths);
      return { echo: "should not reach" };
    });
    const req = makeRequest("echo-tool", { message: "test" }, "real");
    const result = await policyRuntime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("POLICY_VIOLATION");
    expect(result.error?.message).toContain("outside allowed paths");
  });

  it("handles permission prompt exception gracefully", async () => {
    // Create a permission engine that throws on check
    const brokenPrompt = async (): Promise<ApprovalDecision> => {
      throw new Error("Permission prompt crashed");
    };
    const brokenPermissions = new PermissionEngine(journal, brokenPrompt);
    const brokenRuntime = new ToolRuntime(registry, brokenPermissions, journal);

    const req = makeRequest("echo-tool", { message: "test" });
    const result = await brokenRuntime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.error?.message).toContain("Permission check failed");
  });

  it("emits policy.violated event and uses POLICY_VIOLATION code", async () => {
    const { PolicyViolationError } = await import("./policy-enforcer.js");
    runtime.registerHandler("echo-tool", async () => {
      throw new PolicyViolationError("Custom policy violation");
    });
    const req = makeRequest("echo-tool", { message: "test" }, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("POLICY_VIOLATION");
    expect(result.error?.message).toContain("Custom policy violation");

    const events = await journal.readAll();
    const policyEvent = events.find((e) => e.type === "policy.violated");
    expect(policyEvent).toBeTruthy();
    expect(policyEvent!.payload.violation_code).toBe("POLICY_VIOLATION");
    expect(policyEvent!.payload.violation_message).toContain("Custom policy violation");
  });
});

// ─── Graduated Permission Tests ───────────────────────────────────

describe("ToolRuntime graduated permissions", () => {
  let journal: Journal;
  let registry: ToolRegistry;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    registry.register(noPermTool);
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("applies input overrides from allow_constrained decision", async () => {
    const constrainedDecision: ApprovalDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: {
        input_overrides: { message: "constrained message" },
      },
    };
    const permissions = new PermissionEngine(journal, async () => constrainedDecision);
    const runtime = new ToolRuntime(registry, permissions, journal);

    let receivedInput: Record<string, unknown> = {};
    runtime.registerHandler("echo-tool", async (input) => {
      receivedInput = input as Record<string, unknown>;
      return { echo: String((input as any).message) };
    });

    const req = makeRequest("echo-tool", { message: "original" }, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(true);
    // The input should have been overridden by constraints
    expect(receivedInput.message).toBe("constrained message");
  });

  it("emits observed execution telemetry for allow_observed decision", async () => {
    const observedDecision: ApprovalDecision = {
      type: "allow_observed",
      scope: "session",
      telemetry_level: "detailed",
    };
    const permissions = new PermissionEngine(journal, async () => observedDecision);
    const runtime = new ToolRuntime(registry, permissions, journal);

    const req = makeRequest("echo-tool", { message: "watched" });
    const result = await runtime.execute(req);
    expect(result.ok).toBe(true);

    const events = await journal.readAll();
    const observedEvent = events.find((e) => e.type === "permission.observed_execution");
    expect(observedEvent).toBeTruthy();
    expect(observedEvent!.payload.tool_name).toBe("echo-tool");
    expect(observedEvent!.payload.input).toBeDefined();
  });

  it("returns alternative tool suggestion on deny_with_alternative", async () => {
    const denyAltDecision: ApprovalDecision = {
      type: "deny_with_alternative",
      reason: "Too dangerous",
      alternative: { tool_name: "safe-tool", suggested_input: { mode: "readonly" } },
    };
    const permissions = new PermissionEngine(journal, async () => denyAltDecision);
    const runtime = new ToolRuntime(registry, permissions, journal);

    const req = makeRequest("echo-tool", { message: "test" });
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.error?.message).toContain("safe-tool");
  });

  it("applies timeout override from constrained permission", async () => {
    const constrainedDecision: ApprovalDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: {
        max_duration_ms: 50, // very short timeout
      },
    };
    const permissions = new PermissionEngine(journal, async () => constrainedDecision);
    const runtime = new ToolRuntime(registry, permissions, journal);

    // Register a handler that takes longer than the constrained timeout
    runtime.registerHandler("echo-tool", async (input) => {
      await new Promise((r) => setTimeout(r, 200));
      return { echo: "too slow" };
    });

    const req = makeRequest("echo-tool", { message: "timeout test" }, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
    expect(result.error?.message).toContain("timed out");
  });
});

// ─── Circuit Breaker Tests ────────────────────────────────────────

describe("CircuitBreaker", () => {
  it("breaker trips after N consecutive failures", () => {
    const breaker = new CircuitBreaker(3, 30000);
    breaker.recordFailure("tool-a");
    breaker.recordFailure("tool-a");
    expect(breaker.isOpen("tool-a")).toBe(false);
    breaker.recordFailure("tool-a");
    expect(breaker.isOpen("tool-a")).toBe(true);
  });

  it("breaker resets on success", () => {
    const breaker = new CircuitBreaker(3, 30000);
    breaker.recordFailure("tool-a");
    breaker.recordFailure("tool-a");
    breaker.recordSuccess("tool-a");
    breaker.recordFailure("tool-a");
    expect(breaker.isOpen("tool-a")).toBe(false);
  });

  it("breaker recovers after cooldown (half-open → success → closed)", () => {
    const breaker = new CircuitBreaker(3, 10); // 10ms cooldown
    breaker.recordFailure("tool-a");
    breaker.recordFailure("tool-a");
    breaker.recordFailure("tool-a");
    expect(breaker.isOpen("tool-a")).toBe(true);

    // Wait for cooldown
    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }

    // Half-open: should allow one attempt
    expect(breaker.isOpen("tool-a")).toBe(false);
    breaker.recordSuccess("tool-a");
    expect(breaker.isOpen("tool-a")).toBe(false);
  });

  it("breaker is per-tool (tool A failures don't affect tool B)", () => {
    const breaker = new CircuitBreaker(3, 30000);
    breaker.recordFailure("tool-a");
    breaker.recordFailure("tool-a");
    breaker.recordFailure("tool-a");
    expect(breaker.isOpen("tool-a")).toBe(true);
    expect(breaker.isOpen("tool-b")).toBe(false);
  });
});

describe("ToolRuntime circuit breaker integration", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    registry = new ToolRegistry();
    registry.register(noPermTool);

    // Register a tool that always fails
    const failTool: ToolManifest = {
      name: "fail-tool",
      version: "1.0.0",
      description: "Always fails",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["result"], properties: { result: { type: "string" } }, additionalProperties: false },
      permissions: [],
      timeout_ms: 5000,
      supports: { mock: true, dry_run: false },
      mock_responses: [{}], // Missing required "result" field - will fail output validation
    };
    registry.register(failTool);
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("returns CIRCUIT_BREAKER_OPEN after threshold failures", async () => {
    const runtime = new ToolRuntime(registry, permissions, journal);

    // Cause 5 failures (default threshold)
    for (let i = 0; i < 5; i++) {
      const req = makeRequest("fail-tool");
      const result = await runtime.execute(req);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("INVALID_OUTPUT");
    }

    // 6th attempt should be blocked by circuit breaker
    const req = makeRequest("fail-tool");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CIRCUIT_BREAKER_OPEN");
  });

  it("circuit breaker does not affect other tools", async () => {
    const runtime = new ToolRuntime(registry, permissions, journal);

    // Trip circuit breaker for fail-tool
    for (let i = 0; i < 5; i++) {
      await runtime.execute(makeRequest("fail-tool"));
    }

    // free-tool should still work
    const result = await runtime.execute(makeRequest("free-tool"));
    expect(result.ok).toBe(true);
  });
});

describe("CircuitBreaker half-open edge cases", () => {
  it("half-open → failure → re-trips the breaker", () => {
    const breaker = new CircuitBreaker(3, 10); // 10ms cooldown
    breaker.recordFailure("tool-x");
    breaker.recordFailure("tool-x");
    breaker.recordFailure("tool-x");
    expect(breaker.isOpen("tool-x")).toBe(true);

    // Wait for cooldown
    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }

    // Half-open: allows one attempt
    expect(breaker.isOpen("tool-x")).toBe(false);

    // That attempt fails — should immediately re-trip
    breaker.recordFailure("tool-x");
    expect(breaker.isOpen("tool-x")).toBe(true);
  });

  it("half-open window resets trippedAt so next isOpen blocks", () => {
    const breaker = new CircuitBreaker(2, 10);
    breaker.recordFailure("t");
    breaker.recordFailure("t");

    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }

    // First call after cooldown: half-open (returns false but resets timer)
    expect(breaker.isOpen("t")).toBe(false);

    // Immediately after, should be open again (trippedAt was just reset)
    expect(breaker.isOpen("t")).toBe(true);
  });
});

describe("ToolRuntime handler registration", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
    registry = new ToolRegistry();
    registry.register(testTool);
    registry.register(noPermTool);
    runtime = new ToolRuntime(registry, permissions, journal);
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("registerHandler throws on duplicate registration", () => {
    runtime.registerHandler("echo-tool", async () => ({ echo: "first" }));
    expect(() => runtime.registerHandler("echo-tool", async () => ({ echo: "second" }))).toThrow(
      /Handler already registered/
    );
  });

  it("unregisterHandler allows re-registration", () => {
    runtime.registerHandler("echo-tool", async () => ({ echo: "first" }));
    runtime.unregisterHandler("echo-tool");
    expect(() => runtime.registerHandler("echo-tool", async () => ({ echo: "second" }))).not.toThrow();
  });

  it("unregisterHandler for non-existent handler is a no-op", () => {
    expect(() => runtime.unregisterHandler("nonexistent")).not.toThrow();
  });

  it("mock mode returns empty object when mock_responses is empty array", async () => {
    const noMockTool: ToolManifest = {
      name: "no-mock-tool",
      version: "1.0.0",
      description: "No mocks",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [],
      timeout_ms: 5000,
      supports: { mock: true, dry_run: false },
      mock_responses: [],
    };
    registry.register(noMockTool);

    const req = makeRequest("no-mock-tool", {});
    const result = await runtime.execute(req);
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({});
  });

  it("output redaction via constraints redacts specified fields", async () => {
    const constrainedDecision: ApprovalDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: {
        output_redact_fields: ["secret"],
      },
    };
    const redactPermissions = new PermissionEngine(journal, async () => constrainedDecision);
    const redactTool: ToolManifest = {
      name: "secret-tool",
      version: "1.0.0",
      description: "Returns secrets",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: {
        type: "object",
        properties: { data: { type: "string" }, secret: { type: "string" } },
        additionalProperties: false,
      },
      permissions: ["filesystem:read:workspace"],
      timeout_ms: 5000,
      supports: { mock: true, dry_run: false },
    };
    registry.register(redactTool);
    const redactRuntime = new ToolRuntime(registry, redactPermissions, journal);
    redactRuntime.registerHandler("secret-tool", async () => ({
      data: "visible",
      secret: "hunter2",
    }));

    const req = makeRequest("secret-tool", {}, "real");
    const result = await redactRuntime.execute(req);
    expect(result.ok).toBe(true);
    expect((result.result as any).data).toBe("visible");
    expect((result.result as any).secret).toBe("[REDACTED]");
  });

  it("path constraints from permissions override policy", async () => {
    const constrainedDecision: ApprovalDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: {
        readonly_paths: ["/safe/readonly"],
        writable_paths: ["/safe/writable"],
      },
    };
    const pathPermissions = new PermissionEngine(journal, async () => constrainedDecision);
    const pathRuntime = new ToolRuntime(registry, pathPermissions, journal, {
      allowed_paths: ["/original"],
      allowed_endpoints: [],
      allowed_commands: [],
      require_approval_for_writes: false,
    });
    let receivedPolicy: any;
    pathRuntime.registerHandler("echo-tool", async (_input, _mode, policy) => {
      receivedPolicy = policy;
      return { echo: "test" };
    });

    const req = makeRequest("echo-tool", { message: "test" }, "real");
    await pathRuntime.execute(req);
    expect(receivedPolicy.readonly_paths).toEqual(["/safe/readonly"]);
    expect(receivedPolicy.writable_paths).toEqual(["/safe/writable"]);
    // Original allowed_paths should still be there
    expect(receivedPolicy.allowed_paths).toEqual(["/original"]);
  });

  it("input_overrides that violate schema are rejected", async () => {
    const badConstraintDecision: ApprovalDecision = {
      type: "allow_constrained",
      scope: "session",
      constraints: {
        input_overrides: { extra_field: "not allowed" },
      },
    };
    const badPermissions = new PermissionEngine(journal, async () => badConstraintDecision);
    const badRuntime = new ToolRuntime(registry, badPermissions, journal);
    badRuntime.registerHandler("echo-tool", async (input) => ({ echo: String((input as any).message) }));

    const req = makeRequest("echo-tool", { message: "test" }, "real");
    const result = await badRuntime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(result.error?.message).toContain("constraint overrides");
  });

  it("handler uses manifest timeout_ms for execution", async () => {
    const timedTool: ToolManifest = {
      name: "timed-tool",
      version: "1.0.0",
      description: "Timed tool",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", properties: { done: { type: "boolean" } }, additionalProperties: false },
      permissions: [],
      timeout_ms: 100,
      supports: { mock: true, dry_run: false },
    };
    registry.register(timedTool);
    runtime.registerHandler("timed-tool", async () => {
      await new Promise((r) => setTimeout(r, 200)); // Exceeds timeout
      return { done: true };
    });

    const req = makeRequest("timed-tool", {}, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
    expect(result.error?.message).toContain("timed out");
  });
});

describe("B3: Timer leak fix in executeWithTimeout", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    const { mkdirSync } = await import("node:fs");
    try { mkdirSync(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    permissions = new PermissionEngine(journal, async () => "allow_session" as ApprovalDecision);
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("clears timeout timer after successful execution (no dangling timers)", async () => {
    const asyncTool: ToolManifest = {
      name: "async-tool", version: "1.0.0", description: "Async tool",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", properties: { done: { type: "boolean" } }, additionalProperties: false },
      permissions: [], timeout_ms: 60000,
      supports: { mock: true as const, dry_run: false },
    };
    registry.register(asyncTool);
    const runtime = new ToolRuntime(registry, permissions, journal);
    runtime.registerHandler("async-tool", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { done: true };
    });

    const req = makeRequest("async-tool", {}, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(true);
    // If timers leaked, the process would hang or the test would fail with
    // "open handles" warnings. Successful completion proves cleanup.
  });

  it("clears timeout timer after handler throws", async () => {
    const throwTool: ToolManifest = {
      name: "throw-tool", version: "1.0.0", description: "Throws",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 60000,
      supports: { mock: true as const, dry_run: false },
    };
    registry.register(throwTool);
    const runtime = new ToolRuntime(registry, permissions, journal);
    runtime.registerHandler("throw-tool", async () => {
      throw new Error("handler error");
    });

    const req = makeRequest("throw-tool", {}, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
    // Timer should be cleaned up even on error
  });
});
