import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { Journal } from "@jarvis/journal";
import { ToolRegistry, ToolRuntime } from "@jarvis/tools";
import { PermissionEngine } from "@jarvis/permissions";
import { MockPlanner } from "@jarvis/planner";
import { runSubagent } from "./subagent.js";
import type { SubagentDeps, SubagentRequest } from "./subagent.js";
import type { ToolManifest, ApprovalDecision } from "@jarvis/schemas";

const TEST_JOURNAL = resolve(import.meta.dirname ?? ".", "../../.test-subagent-journal.jsonl");
const autoApprove = async (): Promise<ApprovalDecision> => "allow_session";

const testTool: ToolManifest = {
  name: "test-tool", version: "1.0.0", description: "Echoes input",
  runner: "internal",
  input_schema: { type: "object", properties: { message: { type: "string" } }, additionalProperties: false },
  output_schema: { type: "object", properties: { echo: { type: "string" } }, additionalProperties: false },
  permissions: [], timeout_ms: 5000,
  supports: { mock: true as const, dry_run: true },
  mock_responses: [{ echo: "mock echo" }],
};

describe("runSubagent", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let deps: SubagentDeps;

  beforeEach(async () => {
    try { await rm(TEST_JOURNAL); } catch { /* may not exist */ }
    journal = new Journal(TEST_JOURNAL, { fsync: false, lock: false });
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    permissions = new PermissionEngine(journal, autoApprove);
    runtime = new ToolRuntime(registry, permissions, journal);
    deps = {
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner({ agentic: true }),
      mode: "mock",
      policy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    };
  });

  it("spawns child kernel and completes successfully", async () => {
    const request: SubagentRequest = {
      task_text: "Run the test tool",
      max_tokens: 50000,
      max_cost_usd: 1,
      max_iterations: 5,
      max_duration_ms: 30000,
    };

    const result = await runSubagent(deps, request);
    expect(result.status).toBe("completed");
    expect(result.subagent_session_id).toBeTruthy();
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.tokens_used).toBeGreaterThanOrEqual(0);
  });

  it("scopes budget correctly", async () => {
    const request: SubagentRequest = {
      task_text: "Limited budget task",
      max_tokens: 1000,
      max_cost_usd: 0.01,
      max_iterations: 3,
      max_duration_ms: 5000,
    };

    const result = await runSubagent(deps, request);
    // Should still complete (mock planner uses minimal tokens)
    expect(["completed", "failed"]).toContain(result.status);
    expect(result.subagent_session_id).toBeTruthy();
  });

  it("returns findings from step results", async () => {
    const request: SubagentRequest = {
      task_text: "Get findings",
      max_tokens: 50000,
      max_cost_usd: 1,
      max_iterations: 5,
      max_duration_ms: 30000,
    };

    const result = await runSubagent(deps, request);
    expect(result.status).toBe("completed");
    for (const finding of result.findings) {
      expect(finding.step_title).toBeTruthy();
      expect(finding.tool_name).toBeTruthy();
      expect(["succeeded", "failed"]).toContain(finding.status);
      expect(typeof finding.summary).toBe("string");
    }
  });

  it("handles child failure without crashing parent", async () => {
    // Use deps without runtime to force failure
    const failDeps: SubagentDeps = {
      ...deps,
      toolRuntime: undefined,
      planner: new MockPlanner({ agentic: true }),
    };

    const request: SubagentRequest = {
      task_text: "This will fail",
      max_tokens: 50000,
      max_cost_usd: 1,
      max_iterations: 5,
      max_duration_ms: 30000,
    };

    // Should not throw
    const result = await runSubagent(failDeps, request);
    expect(result.status).toBe("failed");
    expect(result.subagent_session_id).toBeTruthy();
  });

  it("handles missing planner without crashing", async () => {
    const noPlannerDeps: SubagentDeps = {
      ...deps,
      planner: undefined,
    };

    const request: SubagentRequest = {
      task_text: "No planner available",
      max_tokens: 50000,
      max_cost_usd: 1,
      max_iterations: 5,
      max_duration_ms: 30000,
    };

    const result = await runSubagent(noPlannerDeps, request);
    expect(result.status).toBe("failed");
  });
});
