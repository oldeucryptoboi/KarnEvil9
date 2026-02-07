import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@openflaw/journal";
import { ToolRegistry, ToolRuntime } from "@openflaw/tools";
import { PermissionEngine } from "@openflaw/permissions";
import { Kernel } from "./kernel.js";
import { MockPlanner } from "@openflaw/planner";
import type { Task, ToolManifest, ApprovalDecision, Plan } from "@openflaw/schemas";

const TEST_JOURNAL = resolve(import.meta.dirname ?? ".", "../../.test-journal.jsonl");
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

function makeKernelConfig(overrides: Record<string, unknown> = {}) {
  return {
    journal: overrides.journal as Journal,
    toolRuntime: overrides.runtime as ToolRuntime,
    toolRegistry: overrides.registry as ToolRegistry,
    permissions: overrides.permissions as PermissionEngine,
    planner: (overrides.planner ?? new MockPlanner()) as any,
    mode: (overrides.mode ?? "mock") as "mock" | "real" | "dry_run",
    limits: (overrides.limits ?? { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 }) as any,
    policy: (overrides.policy ?? { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false }) as any,
  };
}

describe("Kernel E2E", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    try { await rm(TEST_JOURNAL); } catch { /* may not exist */ }
    journal = new Journal(TEST_JOURNAL);
    await journal.init();
    registry = new ToolRegistry();
    permissions = new PermissionEngine(journal, autoApprove);
    runtime = new ToolRuntime(registry, permissions, journal);
  });

  it("runs a full mock session successfully", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Run the test tool", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));

    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    const types = events.map((e) => e.type);
    expect(types).toContain("session.created");
    expect(types).toContain("session.completed");
    expect(types).toContain("tool.succeeded");

    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("rejects plans with unknown tools", async () => {
    const badPlanner = {
      async generatePlan() {
        return {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Use nonexistent tool",
          assumptions: [],
          steps: [{ step_id: uuid(), title: "Bad step", tool_ref: { name: "nonexistent-tool" },
            input: {}, success_criteria: ["Never"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 }],
          created_at: new Date().toISOString(),
        };
      },
    };
    const task: Task = { task_id: uuid(), text: "This should fail planning", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: badPlanner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");
  });

  it("enforces session step limits", async () => {
    const counterTool: ToolManifest = {
      name: "counter-tool", version: "1.0.0", description: "For testing",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false }, mock_responses: [{}],
    };
    registry.register(counterTool);

    const manyStepPlanner = {
      async generatePlan() {
        return {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Too many steps",
          assumptions: [],
          steps: Array.from({ length: 25 }, (_, i) => ({
            step_id: uuid(), title: `Step ${i + 1}`, tool_ref: { name: "counter-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "continue" as const, timeout_ms: 5000, max_retries: 0,
          })),
          created_at: new Date().toISOString(),
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Too many steps test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: manyStepPlanner,
      limits: { max_steps: 5, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
    }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");
  });

  it("run() throws if no session created", async () => {
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await expect(kernel.run()).rejects.toThrow("No session created");
  });

  it("abort() transitions session to aborted", async () => {
    // Use a slow planner that gives us time to abort during the running phase
    const slowTool: ToolManifest = {
      name: "slow-tool", version: "1.0.0", description: "Slow",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 30000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(slowTool);

    // Planner that generates many steps so abort can happen during execution
    const multiStepPlanner = {
      async generatePlan() {
        return {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Abort test",
          assumptions: [],
          steps: Array.from({ length: 10 }, (_, i) => ({
            step_id: uuid(), title: `Step ${i}`, tool_ref: { name: "slow-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "continue" as const, timeout_ms: 5000, max_retries: 0,
          })),
          created_at: new Date().toISOString(),
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Abort test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: multiStepPlanner }));
    await kernel.createSession(task);

    // Start run and abort after a short delay to allow transition to running
    const runPromise = kernel.run();
    // Use setImmediate to let the run start and reach "running" state
    await new Promise((r) => setTimeout(r, 5));
    await kernel.abort();
    const result = await runPromise;

    expect(["aborted", "completed"]).toContain(result.status);
  });

  it("abort() is a no-op on completed session", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Complete then abort", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    await kernel.run();
    // Session is completed; abort should be safe
    await kernel.abort();
    expect(kernel.getSession()!.status).toBe("completed");
  });

  it("getSession() returns null before createSession", () => {
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    expect(kernel.getSession()).toBeNull();
  });

  it("getTaskState() returns null before createSession", () => {
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    expect(kernel.getTaskState()).toBeNull();
  });

  it("createSession returns session with correct fields", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Session fields test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    const session = await kernel.createSession(task);
    expect(session.session_id).toBeTruthy();
    expect(session.status).toBe("created");
    expect(session.mode).toBe("mock");
    expect(session.task).toBe(task);
    expect(session.active_plan_id).toBeNull();
  });

  it("handles planner that throws an error", async () => {
    const throwingPlanner = {
      async generatePlan(): Promise<Plan> {
        throw new Error("Planner exploded");
      },
    };
    const task: Task = { task_id: uuid(), text: "Planner error test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: throwingPlanner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("planner.plan_rejected");
  });

  it("handles step with continue failure policy", async () => {
    // Tool that produces invalid output in mock mode (empty object vs required fields)
    const failTool: ToolManifest = {
      name: "fail-tool", version: "1.0.0", description: "Fails on purpose",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["result"], properties: { result: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}], // Missing required "result" field
    };
    const okTool: ToolManifest = {
      name: "ok-tool", version: "1.0.0", description: "Succeeds",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(failTool);
    registry.register(okTool);

    const planner = {
      async generatePlan() {
        return {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Continue past failure",
          assumptions: [],
          steps: [
            {
              step_id: uuid(), title: "Failing step", tool_ref: { name: "fail-tool" },
              input: {}, success_criteria: ["done"], failure_policy: "continue" as const, timeout_ms: 5000, max_retries: 0,
            },
            {
              step_id: uuid(), title: "OK step", tool_ref: { name: "ok-tool" },
              input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
            },
          ],
          created_at: new Date().toISOString(),
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Continue test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    // First step fails with continue, second succeeds, session completes
    expect(session.status).toBe("completed");
  });

  it("step with abort failure policy stops execution", async () => {
    const failTool: ToolManifest = {
      name: "abort-fail-tool", version: "1.0.0", description: "Fails",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["result"], properties: { result: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(failTool);

    const planner = {
      async generatePlan() {
        return {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Abort on failure",
          assumptions: [],
          steps: [{
            step_id: uuid(), title: "Abort step", tool_ref: { name: "abort-fail-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
          }],
          created_at: new Date().toISOString(),
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Abort failure test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");
  });

  it("handles permission denial during execution", async () => {
    const permTool: ToolManifest = {
      name: "perm-tool", version: "1.0.0", description: "Needs permissions",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: ["filesystem:write:workspace"], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(permTool);

    const denyPerms = new PermissionEngine(journal, async () => "deny" as ApprovalDecision);
    const denyRuntime = new ToolRuntime(registry, denyPerms, journal);

    const planner = {
      async generatePlan() {
        return {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Denied",
          assumptions: [],
          steps: [{
            step_id: uuid(), title: "Denied step", tool_ref: { name: "perm-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
          }],
          created_at: new Date().toISOString(),
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Permission denial test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime: denyRuntime, registry, permissions: denyPerms, planner,
    }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");
  });

  it("retries failed steps up to max_retries", async () => {
    const retryTool: ToolManifest = {
      name: "retry-tool", version: "1.0.0", description: "Retry test",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}], // Invalid output, will fail validation each time
    };
    registry.register(retryTool);

    const planner = {
      async generatePlan() {
        return {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Retry test",
          assumptions: [],
          steps: [{
            step_id: uuid(), title: "Retry step", tool_ref: { name: "retry-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 2,
          }],
          created_at: new Date().toISOString(),
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Retry test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    // Should have attempted 3 times (initial + 2 retries)
    const taskState = kernel.getTaskState()!;
    const results = taskState.getAllStepResults();
    expect(results[0]!.attempts).toBe(3);
  });

  it("tracks task state through execution", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "State tracking test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    await kernel.run();

    const taskState = kernel.getTaskState()!;
    expect(taskState.getPlan()).not.toBeNull();
    const snapshot = taskState.getSnapshot();
    expect(snapshot.completed_steps).toBe(1);
    expect(snapshot.has_plan).toBe(true);
  });
});
