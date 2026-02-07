import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@openflaw/journal";
import { PermissionEngine } from "@openflaw/permissions";
import type { ToolManifest, ToolExecutionRequest, ApprovalDecision } from "@openflaw/schemas";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime } from "./tool-runtime.js";

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
    journal = new Journal(TEST_FILE);
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
    runtime.registerHandler("echo-tool", async (input) => {
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
    runtime.registerHandler("echo-tool", async () => {
      throw new Error("Handler crashed");
    });
    const req = makeRequest("echo-tool", { message: "test" }, "real");
    const result = await runtime.execute(req);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
    expect(result.error?.message).toContain("Handler crashed");
  });

  it("fails on invalid output from handler", async () => {
    runtime.registerHandler("echo-tool", async () => {
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
});
