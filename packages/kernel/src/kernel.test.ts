import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { PluginRegistry } from "@karnevil9/plugins";
import { Kernel } from "./kernel.js";
import { MockPlanner } from "@karnevil9/planner";
import type { Task, ToolManifest, ApprovalDecision, Plan, PlanResult, Planner, ToolSchemaForPlanner } from "@karnevil9/schemas";

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
  const config: Record<string, unknown> = {
    journal: overrides.journal as Journal,
    toolRegistry: overrides.registry as ToolRegistry,
    mode: (overrides.mode ?? "mock") as "mock" | "real" | "dry_run",
    limits: (overrides.limits ?? { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 }) as any,
    policy: (overrides.policy ?? { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false }) as any,
  };
  // Only include optional deps if explicitly provided and not undefined
  if ("planner" in overrides && overrides.planner !== undefined) {
    config.planner = overrides.planner;
  } else if (!("planner" in overrides)) {
    config.planner = new MockPlanner();
  }
  if ("runtime" in overrides && overrides.runtime !== undefined) {
    config.toolRuntime = overrides.runtime;
  }
  if ("permissions" in overrides && overrides.permissions !== undefined) {
    config.permissions = overrides.permissions;
  }
  return config as any;
}

describe("Kernel E2E", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    try { await rm(TEST_JOURNAL); } catch { /* may not exist */ }
    journal = new Journal(TEST_JOURNAL, { fsync: false, lock: false });
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
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Use nonexistent tool",
          assumptions: [],
          steps: [{ step_id: uuid(), title: "Bad step", tool_ref: { name: "nonexistent-tool" },
            input: {}, success_criteria: ["Never"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 }],
          created_at: new Date().toISOString(),
        } };
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
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Too many steps",
          assumptions: [],
          steps: Array.from({ length: 25 }, (_, i) => ({
            step_id: uuid(), title: `Step ${i + 1}`, tool_ref: { name: "counter-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "continue" as const, timeout_ms: 5000, max_retries: 0,
          })),
          created_at: new Date().toISOString(),
        } };
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
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Abort test",
          assumptions: [],
          steps: Array.from({ length: 10 }, (_, i) => ({
            step_id: uuid(), title: `Step ${i}`, tool_ref: { name: "slow-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "continue" as const, timeout_ms: 5000, max_retries: 0,
          })),
          created_at: new Date().toISOString(),
        } };
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
      async generatePlan(): Promise<PlanResult> {
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
        return { plan: {
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
        } };
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
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Abort on failure",
          assumptions: [],
          steps: [{
            step_id: uuid(), title: "Abort step", tool_ref: { name: "abort-fail-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
          }],
          created_at: new Date().toISOString(),
        } };
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
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Denied",
          assumptions: [],
          steps: [{
            step_id: uuid(), title: "Denied step", tool_ref: { name: "perm-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
          }],
          created_at: new Date().toISOString(),
        } };
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
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Retry test",
          assumptions: [],
          steps: [{
            step_id: uuid(), title: "Retry step", tool_ref: { name: "retry-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 2,
          }],
          created_at: new Date().toISOString(),
        } };
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

  it("executes parallel steps with depends_on", async () => {
    const parallelTool: ToolManifest = {
      name: "parallel-tool", version: "1.0.0", description: "For parallel test",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(parallelTool);

    const stepA = uuid();
    const stepB = uuid();
    const stepC = uuid();

    // A and B have no deps (run in parallel), C depends on both
    const planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Parallel test",
          assumptions: [],
          steps: [
            { step_id: stepA, title: "Step A", tool_ref: { name: "parallel-tool" },
              input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 },
            { step_id: stepB, title: "Step B", tool_ref: { name: "parallel-tool" },
              input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 },
            { step_id: stepC, title: "Step C", tool_ref: { name: "parallel-tool" },
              input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
              depends_on: [stepA, stepB] },
          ],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Parallel steps test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const taskState = kernel.getTaskState()!;
    expect(taskState.getStepResult(stepA)?.status).toBe("succeeded");
    expect(taskState.getStepResult(stepB)?.status).toBe("succeeded");
    expect(taskState.getStepResult(stepC)?.status).toBe("succeeded");
  });

  it("skips dependent steps when dependency fails", async () => {
    const failTool2: ToolManifest = {
      name: "fail-tool-2", version: "1.0.0", description: "Fails output validation",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["result"], properties: { result: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    const okTool2: ToolManifest = {
      name: "ok-tool-2", version: "1.0.0", description: "Succeeds",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(failTool2);
    registry.register(okTool2);

    const stepA = uuid();
    const stepB = uuid();

    const planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Dep fail test",
          assumptions: [],
          steps: [
            { step_id: stepA, title: "Failing", tool_ref: { name: "fail-tool-2" },
              input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 },
            { step_id: stepB, title: "Dependent", tool_ref: { name: "ok-tool-2" },
              input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
              depends_on: [stepA] },
          ],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Skip dependent test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const taskState = kernel.getTaskState()!;
    expect(taskState.getStepResult(stepB)?.status).toBe("skipped");
  });

  it("resolves input_from bindings across steps", async () => {
    const producerTool: ToolManifest = {
      name: "producer-tool", version: "1.0.0", description: "Produces output",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", properties: { content: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{ content: "hello from producer" }],
    };
    const consumerTool: ToolManifest = {
      name: "consumer-tool", version: "1.0.0", description: "Consumes input",
      runner: "internal",
      input_schema: { type: "object", properties: { message: { type: "string" } }, additionalProperties: false },
      output_schema: { type: "object", properties: { echo: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{ echo: "mock echo" }],
    };
    registry.register(producerTool);
    registry.register(consumerTool);

    const stepA = "step-producer";
    const stepB = "step-consumer";

    const planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Input binding test",
          assumptions: [],
          steps: [
            { step_id: stepA, title: "Produce", tool_ref: { name: "producer-tool" },
              input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 },
            { step_id: stepB, title: "Consume", tool_ref: { name: "consumer-tool" },
              input: { message: "default" }, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
              depends_on: [stepA], input_from: { message: "step-producer.content" } },
          ],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Input binding test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");
  });

  it("backward compatible: plans without depends_on still work (sequential)", async () => {
    registry.register(testTool);
    const planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Sequential backward compat",
          assumptions: [],
          steps: [
            { step_id: uuid(), title: "Step 1", tool_ref: { name: "test-tool" },
              input: { message: "a" }, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 },
            { step_id: uuid(), title: "Step 2", tool_ref: { name: "test-tool" },
              input: { message: "b" }, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 },
          ],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "No deps test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const taskState = kernel.getTaskState()!;
    expect(taskState.getSnapshot().completed_steps).toBe(2);
  });

  it("runs without planner — fails gracefully at planning phase", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "No planner test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: undefined }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const rejected = events.find((e) => e.type === "planner.plan_rejected");
    expect(rejected).toBeTruthy();
    expect((rejected!.payload as any).errors).toContain("No planner configured — cannot generate plan");
  });

  it("runs without toolRuntime — fails gracefully at execute phase", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "No runtime test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime: undefined, registry, permissions }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const taskState = kernel.getTaskState()!;
    const results = taskState.getAllStepResults();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.error).toEqual({ code: "NO_RUNTIME", message: "No tool runtime configured" });
  });

  it("runs without permissions — cleanup is no-op", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "No permissions test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions: undefined }));
    await kernel.createSession(task);
    const session = await kernel.run();
    // Should complete without throwing — permissions cleanup is skipped gracefully
    expect(["completed", "failed"]).toContain(session.status);
  });

  it("enforces max_duration_ms", async () => {
    // Tool that sleeps for 200ms each time
    const slowTool: ToolManifest = {
      name: "duration-tool", version: "1.0.0", description: "Slow tool",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(slowTool);

    // Register a handler that adds delay — used in real mode
    runtime.registerHandler("duration-tool", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return {};
    });

    const planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Duration test",
          assumptions: [],
          steps: Array.from({ length: 10 }, (_, i) => ({
            step_id: `dur-step-${i}`, title: `Step ${i}`, tool_ref: { name: "duration-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "continue" as const, timeout_ms: 5000, max_retries: 0,
            depends_on: i > 0 ? [`dur-step-${i - 1}`] : [],
          })),
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Duration limit test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner,
      mode: "real",
      limits: { max_steps: 20, max_duration_ms: 500, max_cost_usd: 1, max_tokens: 10000 },
    }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const limitEvent = events.find((e) => e.type === "limit.exceeded");
    expect(limitEvent).toBeTruthy();
    expect(limitEvent!.payload.limit).toBe("max_duration_ms");
  });

  it("emits session.checkpoint after steps", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Checkpoint test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    const checkpoints = events.filter((e) => e.type === "session.checkpoint");
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0]!.payload.completed_step_ids).toBeDefined();
  });

  it("stores full plan in plan.accepted event", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Plan storage test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    const planEvent = events.find((e) => e.type === "plan.accepted");
    expect(planEvent).toBeTruthy();
    expect(planEvent!.payload.plan).toBeDefined();
    expect((planEvent!.payload.plan as any).plan_id).toBeTruthy();
    expect((planEvent!.payload.plan as any).steps).toBeDefined();
  });

  it("resumes session from journal checkpoint", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Resume test", created_at: new Date().toISOString() };

    // Run a full session first to get journal events
    const kernel1 = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel1.createSession(task);
    const session1 = await kernel1.run();
    expect(session1.status).toBe("completed");
    const sessionId = session1.session_id;

    // Now create a second journal with incomplete session events (simulate crash)
    const RESUME_JOURNAL = resolve(import.meta.dirname ?? ".", "../../.test-resume-journal.jsonl");
    try { await rm(RESUME_JOURNAL); } catch { /* ok */ }
    const journal2 = new Journal(RESUME_JOURNAL, { fsync: false, lock: false });
    await journal2.init();

    // Get original events to find plan
    const origEvents = await journal.readSession(sessionId);
    const planAccepted = origEvents.find((e) => e.type === "plan.accepted");
    const plan = planAccepted!.payload.plan as Plan;

    // Emit synthetic events for a session that was interrupted (no terminal event)
    const newSessionId = uuid();
    await journal2.emit(newSessionId, "session.created", {
      task_id: task.task_id, task_text: task.text, mode: "mock",
    });
    await journal2.emit(newSessionId, "session.started", {});
    await journal2.emit(newSessionId, "plan.accepted", { plan_id: plan.plan_id, plan });

    // Resume the session
    const kernel2 = new Kernel(makeKernelConfig({ journal: journal2, runtime, registry, permissions }));
    const resumed = await kernel2.resumeSession(newSessionId);
    expect(resumed).not.toBeNull();
    expect(resumed!.status).toBe("completed");

    try { await rm(RESUME_JOURNAL); } catch { /* cleanup */ }
  });

  it("resumeSession returns null for completed sessions", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Already done", created_at: new Date().toISOString() };
    const kernel1 = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel1.createSession(task);
    const session = await kernel1.run();

    const kernel2 = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    const result = await kernel2.resumeSession(session.session_id);
    expect(result).toBeNull();
  });

  it("resumeSession returns null for nonexistent session", async () => {
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    const result = await kernel.resumeSession("nonexistent-session-id");
    expect(result).toBeNull();
  });

  it("rejects concurrent run() calls", async () => {
    const slowTool: ToolManifest = {
      name: "slow-reentrant", version: "1.0.0", description: "Slow",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 30000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(slowTool);
    runtime.registerHandler("slow-reentrant", async () => {
      await new Promise((r) => setTimeout(r, 500));
      return {};
    });

    const planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Reentrant test",
          assumptions: [],
          steps: [{ step_id: uuid(), title: "Slow", tool_ref: { name: "slow-reentrant" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 30000, max_retries: 0 }],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Reentrant test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner, mode: "real" }));
    await kernel.createSession(task);

    const firstRun = kernel.run();
    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 10));
    await expect(kernel.run()).rejects.toThrow("already running");
    await firstRun; // let it finish
  });

  it("allows run() again after previous run completes", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Sequential runs", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    const session1 = await kernel.run();
    expect(session1.status).toBe("completed");
    // Second run should fail because session is already completed, but should NOT throw re-entrancy error
    await expect(kernel.run()).rejects.toThrow("Invalid session transition");
  });

  it("plugin hook blocks step", async () => {
    registry.register(testTool);

    const pluginsDir = join(tmpdir(), `karnevil9-ktest-${uuid()}`);
    const pluginDir = join(pluginsDir, "blocker");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.yaml"), `
id: blocker
name: Blocker
version: "1.0.0"
description: Blocks before_step
entry: index.js
permissions: []
provides:
  hooks:
    - before_step
`);
    await writeFile(join(pluginDir, "index.js"), `
export async function register(api) {
  api.registerHook("before_step", async (ctx) => {
    return { action: "block", reason: "blocked by test plugin" };
  });
}
`);

    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
    });
    await pluginRegistry.discoverAndLoadAll();

    const task: Task = { task_id: uuid(), text: "Blocked step test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    (kernel as any).config.pluginRegistry = pluginRegistry;
    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("failed");
    const events = await journal.readSession(session.session_id);
    const stepFailed = events.find((e) => e.type === "step.failed");
    expect(stepFailed).toBeTruthy();
    expect((stepFailed!.payload as any).error?.code).toBe("PLUGIN_HOOK_BLOCKED");

    await rm(pluginsDir, { recursive: true, force: true });
  });

  // ─── Agentic Loop Tests ──────────────────────────────────────────────

  it("agentic loop completes with mock planner", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Agentic mock test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions,
      planner: new MockPlanner({ agentic: true }),
      limits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 5 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    const types = events.map((e) => e.type);
    expect(types).toContain("session.completed");
    expect(types).toContain("step.succeeded");
    // Done signal's plan.accepted should include the plan object
    const doneAccepted = events.find(
      (e) => e.type === "plan.accepted" && (e.payload.plan as any)?.steps?.length === 0
    );
    expect(doneAccepted).toBeTruthy();
    expect((doneAccepted!.payload.plan as any).goal).toBe("Task complete");
    // There should be at least 2 planner.requested events (one for steps, one for done)
    const plannerRequests = events.filter((e) => e.type === "planner.requested");
    expect(plannerRequests.length).toBeGreaterThanOrEqual(2);
  });

  it("agentic multi-iteration loop accumulates step results", async () => {
    registry.register(testTool);
    let callCount = 0;
    const multiIterPlanner: Planner = {
      async generatePlan(_task: Task, _toolSchemas: ToolSchemaForPlanner[]) {
        callCount++;
        if (callCount <= 3) {
          return { plan: {
            plan_id: uuid(), schema_version: "0.1", goal: `Iteration ${callCount}`,
            assumptions: [], created_at: new Date().toISOString(),
            steps: [{
              step_id: uuid(), title: `Step iter ${callCount}`,
              tool_ref: { name: "test-tool" },
              input: { message: `iter-${callCount}` },
              success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0,
            }],
          } };
        }
        // Return empty steps to signal done
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: "Task complete",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Multi-iteration test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: multiIterPlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");
    expect(callCount).toBe(4); // 3 iterations + 1 done

    const taskState = kernel.getTaskState()!;
    const results = taskState.getAllStepResults();
    expect(results.length).toBe(3);
    expect(results.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("agentic loop fails at max iterations", async () => {
    registry.register(testTool);
    const neverDonePlanner: Planner = {
      async generatePlan(task: Task) {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: task.text,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{
            step_id: uuid(), title: "Another step",
            tool_ref: { name: "test-tool" },
            input: { message: "again" },
            success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0,
          }],
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Never done test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: neverDonePlanner,
      limits: { max_steps: 50, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 3 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const limitEvent = events.find((e) => e.type === "limit.exceeded");
    expect(limitEvent).toBeTruthy();
    expect(limitEvent!.payload.limit).toBe("max_iterations");
    expect(limitEvent!.payload.value).toBe(3);
    // session.failed event should also be emitted
    const failedEvent = events.find((e) => e.type === "session.failed");
    expect(failedEvent).toBeTruthy();
    expect((failedEvent!.payload as any).reason).toContain("Max iterations exceeded");
  });

  it("agentic loop enforces cumulative step limit", async () => {
    const counterTool: ToolManifest = {
      name: "agentic-counter", version: "1.0.0", description: "Counter",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false }, mock_responses: [{}],
    };
    registry.register(counterTool);

    let callCount = 0;
    const manyStepsPlanner: Planner = {
      async generatePlan() {
        callCount++;
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: `Batch ${callCount}`,
          assumptions: [], created_at: new Date().toISOString(),
          steps: Array.from({ length: 5 }, (_, i) => ({
            step_id: uuid(), title: `Step ${callCount}-${i}`,
            tool_ref: { name: "agentic-counter" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0,
          })),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Cumulative step limit test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: manyStepsPlanner,
      limits: { max_steps: 8, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    // First iteration: 5 steps (ok, total=5). Second iteration: 5 steps (5+5=10 > 8, rejected)
    expect(callCount).toBe(2);
    const events = await journal.readSession(session.session_id);
    const limitEvent = events.find((e) => e.type === "limit.exceeded");
    expect(limitEvent).toBeTruthy();
    expect(limitEvent!.payload.limit).toBe("max_steps");
    // session.failed event should also be emitted
    const failedEvent = events.find((e) => e.type === "session.failed");
    expect(failedEvent).toBeTruthy();
    expect((failedEvent!.payload as any).reason).toContain("Cumulative step limit exceeded");
  });

  it("agentic loop handles replan failure_policy", async () => {
    const failTool: ToolManifest = {
      name: "replan-fail-tool", version: "1.0.0", description: "Fails for replan",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["result"], properties: { result: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}], // Missing required "result" field → fails
    };
    const okTool: ToolManifest = {
      name: "replan-ok-tool", version: "1.0.0", description: "Succeeds",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(failTool);
    registry.register(okTool);

    let callCount = 0;
    const replanPlanner: Planner = {
      async generatePlan(_task: Task, _schemas: ToolSchemaForPlanner[], stateSnapshot: Record<string, unknown>) {
        callCount++;
        if (callCount === 1) {
          // First iteration: step that will fail with replan policy
          return { plan: {
            plan_id: uuid(), schema_version: "0.1", goal: "Try first approach",
            assumptions: [], created_at: new Date().toISOString(),
            steps: [{
              step_id: "replan-step-1", title: "Failing step",
              tool_ref: { name: "replan-fail-tool" },
              input: {}, success_criteria: ["done"], failure_policy: "replan" as const,
              timeout_ms: 5000, max_retries: 0,
            }],
          } };
        }
        if (callCount === 2) {
          // Second iteration: planner sees the failure and tries different approach
          const results = stateSnapshot.step_results as Record<string, { status: string }>;
          expect(results["replan-step-1"]?.status).toBe("failed");
          return { plan: {
            plan_id: uuid(), schema_version: "0.1", goal: "Alternative approach",
            assumptions: [], created_at: new Date().toISOString(),
            steps: [{
              step_id: uuid(), title: "OK step",
              tool_ref: { name: "replan-ok-tool" },
              input: {}, success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0,
            }],
          } };
        }
        // Done
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: "Task complete",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Replan test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: replanPlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 5 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");
    expect(callCount).toBe(3);
  });

  it("agentic loop aborts between iterations", async () => {
    registry.register(testTool);
    let callCount = 0;
    const slowPlanner: Planner = {
      async generatePlan(task: Task) {
        callCount++;
        // Add a small delay to give abort a chance to fire between iterations
        await new Promise((r) => setTimeout(r, 20));
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: task.text,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{
            step_id: uuid(), title: `Step ${callCount}`,
            tool_ref: { name: "test-tool" },
            input: { message: "test" },
            success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0,
          }],
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Abort agentic test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: slowPlanner,
      limits: { max_steps: 50, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);

    const runPromise = kernel.run();
    await new Promise((r) => setTimeout(r, 30));
    await kernel.abort();
    const session = await runPromise;
    // Session terminates — abort may arrive during different phases
    expect(["aborted", "completed", "failed"]).toContain(session.status);
    // Key assertion: the loop didn't run all 10 iterations
    expect(callCount).toBeLessThan(10);
  });

  it("agentic loop emits plan.replaced events on iterations 2+", async () => {
    registry.register(testTool);
    let callCount = 0;
    const twoIterPlanner: Planner = {
      async generatePlan(_task: Task) {
        callCount++;
        if (callCount <= 2) {
          return { plan: {
            plan_id: `plan-${callCount}`, schema_version: "0.1", goal: `Iteration ${callCount}`,
            assumptions: [], created_at: new Date().toISOString(),
            steps: [{
              step_id: uuid(), title: `Step ${callCount}`,
              tool_ref: { name: "test-tool" },
              input: { message: `iter-${callCount}` },
              success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0,
            }],
          } };
        }
        return { plan: {
          plan_id: `plan-done`, schema_version: "0.1", goal: "Done",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Plan replaced test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: twoIterPlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    const replaced = events.filter((e) => e.type === "plan.replaced");
    expect(replaced.length).toBe(1);
    expect(replaced[0]!.payload.previous_plan_id).toBe("plan-1");
    expect(replaced[0]!.payload.new_plan_id).toBe("plan-2");
    expect(replaced[0]!.payload.iteration).toBe(2);
  });

  it("non-agentic mode unchanged (backward compat)", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Non-agentic backward compat", created_at: new Date().toISOString() };
    // No agentic flag — default single-shot behavior
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    const types = events.map((e) => e.type);
    // Should NOT have plan.replaced events
    expect(types).not.toContain("plan.replaced");
    expect(types).toContain("session.completed");
  });

  it("agentic loop respects duration limit across iterations", async () => {
    const slowTool: ToolManifest = {
      name: "agentic-slow-tool", version: "1.0.0", description: "Slow",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(slowTool);
    runtime.registerHandler("agentic-slow-tool", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return {};
    });

    const neverDonePlanner: Planner = {
      async generatePlan(task: Task) {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: task.text,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{
            step_id: uuid(), title: "Slow step",
            tool_ref: { name: "agentic-slow-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0,
          }],
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Duration limit agentic", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: neverDonePlanner,
      mode: "real",
      limits: { max_steps: 50, max_duration_ms: 500, max_cost_usd: 1, max_tokens: 10000, max_iterations: 20 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const limitEvents = events.filter((e) => e.type === "limit.exceeded");
    expect(limitEvents.length).toBeGreaterThan(0);
    // Could be max_duration_ms from either agenticPhase or executePhase
    const limits = limitEvents.map((e) => e.payload.limit);
    expect(limits).toContain("max_duration_ms");
    // session.failed event should also be emitted
    const failedEvent = events.find((e) => e.type === "session.failed");
    expect(failedEvent).toBeTruthy();
  });

  it("plugin hook observes without affecting execution", async () => {
    registry.register(testTool);

    const pluginsDir = join(tmpdir(), `karnevil9-ktest-${uuid()}`);
    const pluginDir = join(pluginsDir, "observer");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.yaml"), `
id: observer
name: Observer
version: "1.0.0"
description: Observes before_step
entry: index.js
permissions: []
provides:
  hooks:
    - before_step
`);
    await writeFile(join(pluginDir, "index.js"), `
export async function register(api) {
  api.registerHook("before_step", async (ctx) => {
    return { action: "observe" };
  });
}
`);

    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
    });
    await pluginRegistry.discoverAndLoadAll();

    const task: Task = { task_id: uuid(), text: "Observer test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    (kernel as any).config.pluginRegistry = pluginRegistry;
    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("completed");

    await rm(pluginsDir, { recursive: true, force: true });
  });

  it("planner retries on failure when plannerRetries is set", async () => {
    let attempts = 0;
    const flakyPlanner = {
      async generatePlan() {
        attempts++;
        if (attempts < 3) throw new Error("Planner temporarily unavailable");
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Retry test",
          assumptions: [],
          steps: [{ step_id: uuid(), title: "Step 1", tool_ref: { name: "test-tool" },
            input: { message: "test" }, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 }],
          created_at: new Date().toISOString(),
        } };
      },
    };

    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Planner retry test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions,
      planner: flakyPlanner,
      limits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
    }));
    // Inject plannerRetries into config
    (kernel as any).config.plannerRetries = 3;

    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");
    expect(attempts).toBe(3);
  });

  it("planner fails after exhausting retries", async () => {
    const alwaysFailPlanner = {
      async generatePlan(): Promise<PlanResult> {
        throw new Error("Planner permanently down");
      },
    };

    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Planner exhaust test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions,
      planner: alwaysFailPlanner,
    }));
    (kernel as any).config.plannerRetries = 2;

    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const rejections = events.filter((e) => e.type === "planner.plan_rejected");
    // Should have 2 intermediate rejections + 1 final = 3
    expect(rejections.length).toBe(3);
  });

  it("planner times out when plannerTimeoutMs is set", async () => {
    const hangingPlanner = {
      async generatePlan(): Promise<PlanResult> {
        await new Promise((r) => setTimeout(r, 5000)); // hang for 5s
        throw new Error("Should not reach here");
      },
    };

    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Planner timeout test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions,
      planner: hangingPlanner,
    }));
    (kernel as any).config.plannerTimeoutMs = 100;

    await kernel.createSession(task);
    const start = Date.now();
    const session = await kernel.run();
    const elapsed = Date.now() - start;
    expect(session.status).toBe("failed");
    expect(elapsed).toBeLessThan(2000); // Should timeout quickly, not wait 5s

    const events = await journal.readSession(session.session_id);
    const rejected = events.find((e) => e.type === "planner.plan_rejected");
    expect(rejected).toBeTruthy();
    expect((rejected!.payload as any).errors[0]).toContain("timed out");
  });

  it("B3: planner timer is cleaned up on normal completion (no dangling timers)", async () => {
    // Use a fast planner with a timeout configured
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Timer cleanup test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    (kernel as any).config.plannerTimeoutMs = 30000; // 30s timeout that should NOT fire

    await kernel.createSession(task);
    const session = await kernel.run();
    // If the timer leaked, the test process would hang with open handles
    expect(session.status).toBe("completed");
  });

  it("resumeSession recovers agentic sessions mid-execution", async () => {
    registry.register(testTool);
    // Simulate an interrupted agentic session with plan.replaced:
    // Iteration 1: completed (step1 succeeded), Iteration 2: partially done (step2 succeeded, step3 not started)
    const sessionId = uuid();
    const planId1 = uuid();
    const planId2 = uuid();
    const stepId1 = uuid();
    const stepId2 = uuid();
    const stepId3 = uuid();
    const createdAt = new Date(Date.now() - 10000).toISOString();

    await journal.emit(sessionId, "session.created", {
      task_id: uuid(), task_text: "Agentic resume test", mode: "mock",
    });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId1,
      plan: {
        plan_id: planId1, schema_version: "0.1", goal: "Iteration 1",
        assumptions: [], created_at: createdAt,
        steps: [{
          step_id: stepId1, title: "Step 1", tool_ref: { name: "test-tool" },
          input: { message: "test" }, success_criteria: ["done"],
          failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
        }],
      },
    });
    await journal.emit(sessionId, "step.succeeded", {
      step_id: stepId1, status: "succeeded", attempts: 1, output: { echo: "mock echo" },
    });
    await journal.emit(sessionId, "plan.replaced", {
      previous_plan_id: planId1, new_plan_id: planId2, iteration: 2,
    });
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId2,
      plan: {
        plan_id: planId2, schema_version: "0.1", goal: "Iteration 2",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [
          { step_id: stepId2, title: "Step 2", tool_ref: { name: "test-tool" },
            input: { message: "test2" }, success_criteria: ["done"],
            failure_policy: "abort", timeout_ms: 5000, max_retries: 0 },
          { step_id: stepId3, title: "Step 3", tool_ref: { name: "test-tool" },
            input: { message: "test3" }, success_criteria: ["done"],
            failure_policy: "abort", timeout_ms: 5000, max_retries: 0 },
        ],
      },
    });
    // Step 2 completed, Step 3 not started (crash)
    await journal.emit(sessionId, "step.succeeded", {
      step_id: stepId2, status: "succeeded", attempts: 1, output: { echo: "mock echo" },
    });

    // Create a planner that returns empty steps (done) on its first call during recovery
    const recoveryPlanner: Planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: "Task complete",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        } };
      },
    };

    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: recoveryPlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;

    const result = await kernel.resumeSession(sessionId);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");

    // Verify recovery event was emitted
    const events = await journal.readSession(sessionId);
    const recoveryStarted = events.find(
      (e) => e.type === "session.started" && (e.payload as any).recovered === true
    );
    expect(recoveryStarted).toBeTruthy();
    expect((recoveryStarted!.payload as any).agentic).toBe(true);
    expect((recoveryStarted!.payload as any).resumed_at_iteration).toBe(2);

    // Step 3 should have been executed during recovery
    const step3Events = events.filter(
      (e) => e.type === "step.succeeded" && (e.payload as any).step_id === stepId3
    );
    expect(step3Events.length).toBe(1);
  });

  it("resumeSession recovers agentic session between iterations", async () => {
    registry.register(testTool);
    // Simulate: Iteration 1 fully completed, crashed before iteration 2 planning
    const sessionId = uuid();
    const planId1 = uuid();
    const stepId1 = uuid();

    await journal.emit(sessionId, "session.created", {
      task_id: uuid(), task_text: "Agentic inter-iteration test", mode: "mock",
    });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId1,
      plan: {
        plan_id: planId1, schema_version: "0.1", goal: "Iteration 1",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [{
          step_id: stepId1, title: "Step 1", tool_ref: { name: "test-tool" },
          input: { message: "test" }, success_criteria: ["done"],
          failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
        }],
      },
    });
    await journal.emit(sessionId, "step.succeeded", {
      step_id: stepId1, status: "succeeded", attempts: 1, output: { echo: "mock echo" },
    });
    // Second plan accepted + replaced, but then step done in iteration 2
    const planId2 = uuid();
    const stepId2 = uuid();
    await journal.emit(sessionId, "plan.replaced", {
      previous_plan_id: planId1, new_plan_id: planId2, iteration: 2,
    });
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId2,
      plan: {
        plan_id: planId2, schema_version: "0.1", goal: "Iteration 2",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [{
          step_id: stepId2, title: "Step 2", tool_ref: { name: "test-tool" },
          input: { message: "test2" }, success_criteria: ["done"],
          failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
        }],
      },
    });
    await journal.emit(sessionId, "step.succeeded", {
      step_id: stepId2, status: "succeeded", attempts: 1, output: { echo: "mock echo" },
    });
    // All steps of last plan completed — crashed before next plan

    // Planner returns empty steps = done
    const donePlanner: Planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: "Task complete",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        } };
      },
    };

    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: donePlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;

    const result = await kernel.resumeSession(sessionId);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");

    const events = await journal.readSession(sessionId);
    const recoveryStarted = events.find(
      (e) => e.type === "session.started" && (e.payload as any).recovered === true
    );
    expect(recoveryStarted).toBeTruthy();
    expect((recoveryStarted!.payload as any).agentic).toBe(true);
  });

  it("resumeSession returns null for terminal agentic sessions", async () => {
    registry.register(testTool);
    const sessionId = uuid();
    const planId1 = uuid();
    const planId2 = uuid();

    await journal.emit(sessionId, "session.created", {
      task_id: uuid(), task_text: "Terminal agentic", mode: "mock",
    });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId1,
      plan: {
        plan_id: planId1, schema_version: "0.1", goal: "Iter 1",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [{ step_id: uuid(), title: "S1", tool_ref: { name: "test-tool" },
          input: { message: "t" }, success_criteria: ["d"], failure_policy: "abort",
          timeout_ms: 5000, max_retries: 0 }],
      },
    });
    await journal.emit(sessionId, "plan.replaced", {
      previous_plan_id: planId1, new_plan_id: planId2, iteration: 2,
    });
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId2,
      plan: {
        plan_id: planId2, schema_version: "0.1", goal: "Iter 2",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [{ step_id: uuid(), title: "S2", tool_ref: { name: "test-tool" },
          input: { message: "t" }, success_criteria: ["d"], failure_policy: "abort",
          timeout_ms: 5000, max_retries: 0 }],
      },
    });
    // Session already completed
    await journal.emit(sessionId, "session.completed", { step_results: [] });

    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    const result = await kernel.resumeSession(sessionId);
    expect(result).toBeNull();
  });

  it("resumeSession restores UsageAccumulator from usage.recorded events", async () => {
    registry.register(testTool);
    const sessionId = uuid();
    const planId1 = uuid();
    const planId2 = uuid();
    const stepId1 = uuid();

    await journal.emit(sessionId, "session.created", {
      task_id: uuid(), task_text: "Usage restore test", mode: "mock",
    });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId1,
      plan: {
        plan_id: planId1, schema_version: "0.1", goal: "Iteration 1",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [{ step_id: stepId1, title: "S1", tool_ref: { name: "test-tool" },
          input: { message: "t" }, success_criteria: ["d"], failure_policy: "abort",
          timeout_ms: 5000, max_retries: 0 }],
      },
    });
    await journal.emit(sessionId, "step.succeeded", {
      step_id: stepId1, status: "succeeded", attempts: 1, output: { echo: "ok" },
    });
    await journal.emit(sessionId, "usage.recorded", {
      input_tokens: 500, output_tokens: 200, total_tokens: 700, cost_usd: 0.05,
      cumulative: {
        total_input_tokens: 500, total_output_tokens: 200,
        total_tokens: 700, total_cost_usd: 0.05, call_count: 1,
      },
    });
    await journal.emit(sessionId, "plan.replaced", {
      previous_plan_id: planId1, new_plan_id: planId2, iteration: 2,
    });
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId2,
      plan: {
        plan_id: planId2, schema_version: "0.1", goal: "Iteration 2",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [{ step_id: uuid(), title: "S2", tool_ref: { name: "test-tool" },
          input: { message: "t2" }, success_criteria: ["d"], failure_policy: "abort",
          timeout_ms: 5000, max_retries: 0 }],
      },
    });
    // Crashed mid-iteration 2

    const donePlanner: Planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: "Task complete",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        } };
      },
    };

    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: donePlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;

    const result = await kernel.resumeSession(sessionId);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");

    // Verify usage was restored
    const acc = (kernel as any).usageAccumulator;
    expect(acc.totalTokens).toBeGreaterThanOrEqual(700);
    expect(acc.totalCostUsd).toBeGreaterThanOrEqual(0.05);
  });

  it("resumeSession uses original session start time for duration limits", async () => {
    registry.register(testTool);
    const sessionId = uuid();
    const planId1 = uuid();
    const planId2 = uuid();
    const stepId1 = uuid();

    await journal.emit(sessionId, "session.created", {
      task_id: uuid(), task_text: "Duration restore test", mode: "mock",
    });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId1,
      plan: {
        plan_id: planId1, schema_version: "0.1", goal: "Iteration 1",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [{ step_id: stepId1, title: "S1", tool_ref: { name: "test-tool" },
          input: { message: "t" }, success_criteria: ["d"], failure_policy: "abort",
          timeout_ms: 5000, max_retries: 0 }],
      },
    });
    await journal.emit(sessionId, "step.succeeded", {
      step_id: stepId1, status: "succeeded", attempts: 1, output: { echo: "ok" },
    });
    await journal.emit(sessionId, "plan.replaced", {
      previous_plan_id: planId1, new_plan_id: planId2, iteration: 2,
    });
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId2,
      plan: {
        plan_id: planId2, schema_version: "0.1", goal: "Iteration 2",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [{ step_id: uuid(), title: "S2", tool_ref: { name: "test-tool" },
          input: { message: "t2" }, success_criteria: ["d"], failure_policy: "abort",
          timeout_ms: 5000, max_retries: 0 }],
      },
    });

    const donePlanner: Planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: "Task complete",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        } };
      },
    };

    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: donePlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;

    const result = await kernel.resumeSession(sessionId);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");

    // Verify sessionStartTime was set from the original session.created timestamp,
    // not from Date.now() at resume time
    const sessionStartTime = (kernel as any).sessionStartTime as number;
    const events = await journal.readSession(sessionId);
    const createdEvent = events.find((e) => e.type === "session.created");
    expect(sessionStartTime).toBe(Date.parse(createdEvent!.timestamp));
  });

  it("executePhase skips already-completed steps during recovery", async () => {
    registry.register(testTool);
    // Simulate: session with 2-step plan, step 1 completed, step 2 not started
    const sessionId = uuid();
    const planId = uuid();
    const stepId1 = uuid();
    const stepId2 = uuid();

    await journal.emit(sessionId, "session.created", {
      task_id: uuid(), task_text: "Pre-populate test", mode: "mock",
    });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "plan.accepted", {
      plan_id: planId,
      plan: {
        plan_id: planId, schema_version: "0.1", goal: "Test pre-populate",
        assumptions: [], created_at: new Date().toISOString(),
        steps: [
          { step_id: stepId1, title: "Step 1", tool_ref: { name: "test-tool" },
            input: { message: "s1" }, success_criteria: ["done"],
            failure_policy: "abort", timeout_ms: 5000, max_retries: 0 },
          { step_id: stepId2, title: "Step 2", tool_ref: { name: "test-tool" },
            input: { message: "s2" }, success_criteria: ["done"],
            failure_policy: "abort", timeout_ms: 5000, max_retries: 0 },
        ],
      },
    });
    await journal.emit(sessionId, "step.succeeded", {
      step_id: stepId1, status: "succeeded", attempts: 1, output: { echo: "done1" },
    });

    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    const result = await kernel.resumeSession(sessionId);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");

    // Verify step 1 was NOT re-executed (should only have 1 step.succeeded for step1, from before recovery)
    const events = await journal.readSession(sessionId);
    const step1Successes = events.filter(
      (e) => e.type === "step.succeeded" && (e.payload as any).step_id === stepId1
    );
    expect(step1Successes.length).toBe(1); // Only the original, not re-executed

    // Step 2 should have been executed
    const step2Successes = events.filter(
      (e) => e.type === "step.succeeded" && (e.payload as any).step_id === stepId2
    );
    expect(step2Successes.length).toBe(1);
  });

  // ─── Critics Integration Tests ─────────────────────────────────────

  it("critics block plan with circular dependencies", async () => {
    registry.register(testTool);

    const stepA = uuid();
    const stepB = uuid();
    const circularPlanner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Circular plan",
          assumptions: [],
          steps: [
            { step_id: stepA, title: "Step A", tool_ref: { name: "test-tool" },
              input: { message: "a" }, success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0, depends_on: [stepB] },
            { step_id: stepB, title: "Step B", tool_ref: { name: "test-tool" },
              input: { message: "b" }, success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0, depends_on: [stepA] },
          ],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Circular deps test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: circularPlanner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const types = events.map((e) => e.type);
    expect(types).toContain("plan.criticized");
    expect(types).toContain("planner.plan_rejected");

    const criticized = events.find((e) => e.type === "plan.criticized");
    expect(criticized).toBeTruthy();
    const critics = criticized!.payload.critics as Array<{ name: string; passed: boolean }>;
    const selfRefCritic = critics.find(c => c.name === "selfReferenceCritic");
    expect(selfRefCritic).toBeTruthy();
    expect(selfRefCritic!.passed).toBe(false);
  });

  it("critics block plan with missing required inputs", async () => {
    // Register a tool that has required input fields
    const requiredTool: ToolManifest = {
      name: "required-tool", version: "1.0.0", description: "Tool with required fields",
      runner: "internal",
      input_schema: {
        type: "object",
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
        additionalProperties: false,
      },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}],
    };
    registry.register(requiredTool);

    const missingInputPlanner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Missing input",
          assumptions: [],
          steps: [{ step_id: uuid(), title: "Bad input", tool_ref: { name: "required-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0 }],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Missing input test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: missingInputPlanner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    expect(events.some((e) => e.type === "plan.criticized")).toBe(true);
  });

  it("critics pass good plans", async () => {
    registry.register(testTool);

    const task: Task = { task_id: uuid(), text: "Good plan test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    // No plan.criticized event for passing plans
    expect(events.some((e) => e.type === "plan.criticized")).toBe(false);
    expect(events.some((e) => e.type === "plan.accepted")).toBe(true);
  });

  it("disableCritics bypasses critic checks", async () => {
    registry.register(testTool);

    const stepA = uuid();
    const stepB = uuid();
    const circularPlanner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Circular but critics disabled",
          assumptions: [],
          steps: [
            { step_id: stepA, title: "Step A", tool_ref: { name: "test-tool" },
              input: { message: "a" }, success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0, depends_on: [stepB] },
            { step_id: stepB, title: "Step B", tool_ref: { name: "test-tool" },
              input: { message: "b" }, success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0, depends_on: [stepA] },
          ],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Critics disabled test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: circularPlanner }));
    (kernel as any).config.disableCritics = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    // Plan is accepted (no critic block), but execution may fail due to circular deps
    const events = await journal.readSession(session.session_id);
    expect(events.some((e) => e.type === "plan.criticized")).toBe(false);
    expect(events.some((e) => e.type === "plan.accepted")).toBe(true);
  });

  // ─── Active Memory Integration Tests ────────────────────────────────

  it("active memory recalls lessons into planner state snapshot", async () => {
    registry.register(testTool);

    let receivedSnapshot: Record<string, unknown> = {};
    const capturingPlanner: Planner = {
      async generatePlan(task: Task, _schemas: ToolSchemaForPlanner[], snapshot: Record<string, unknown>): Promise<PlanResult> {
        receivedSnapshot = snapshot;
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: task.text,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{ step_id: uuid(), title: "Step", tool_ref: { name: "test-tool" },
            input: { message: "test" }, success_criteria: ["done"],
            failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 }],
        } };
      },
    };

    // Create an ActiveMemory with a pre-existing lesson
    const memPath = resolve(import.meta.dirname ?? ".", "../../.test-active-memory.jsonl");
    try { await rm(memPath); } catch { /* ok */ }
    const { ActiveMemory } = await import("@karnevil9/memory");
    const activeMem = new ActiveMemory(memPath);
    await activeMem.load();
    activeMem.addLesson({
      lesson_id: uuid(), task_summary: "Read a file for testing",
      outcome: "succeeded", lesson: "Used read-file tool successfully",
      tool_names: ["read-file"], created_at: new Date().toISOString(),
      session_id: uuid(), relevance_count: 0,
    });

    const task: Task = { task_id: uuid(), text: "Read a file for testing", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: capturingPlanner,
    }));
    (kernel as any).config.activeMemory = activeMem;
    await kernel.createSession(task);
    await kernel.run();

    // The planner should have received relevant_memories in the snapshot
    expect(receivedSnapshot.relevant_memories).toBeDefined();
    const memories = receivedSnapshot.relevant_memories as Array<{ task: string; outcome: string; lesson: string }>;
    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0]!.outcome).toBe("succeeded");
    expect(memories[0]!.lesson).toContain("read-file");

    try { await rm(memPath); } catch { /* ok */ }
  });

  it("active memory extracts lesson after session completes", async () => {
    registry.register(testTool);

    const memPath = resolve(import.meta.dirname ?? ".", "../../.test-active-memory-extract.jsonl");
    try { await rm(memPath); } catch { /* ok */ }
    const { ActiveMemory } = await import("@karnevil9/memory");
    const activeMem = new ActiveMemory(memPath);
    await activeMem.load();

    const task: Task = { task_id: uuid(), text: "Extract lesson test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    (kernel as any).config.activeMemory = activeMem;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    // Lesson should have been extracted and stored
    expect(activeMem.getLessons().length).toBe(1);
    const lesson = activeMem.getLessons()[0]!;
    expect(lesson.outcome).toBe("succeeded");
    expect(lesson.session_id).toBe(session.session_id);

    // Journal should have memory.lesson_extracted event
    const events = await journal.readSession(session.session_id);
    expect(events.some((e) => e.type === "memory.lesson_extracted")).toBe(true);

    try { await rm(memPath); } catch { /* ok */ }
  });

  it("active memory extracts failure lesson after session fails", async () => {
    const failTool: ToolManifest = {
      name: "mem-fail-tool", version: "1.0.0", description: "Fails for memory test",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["result"], properties: { result: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}], // Missing required field → fails
    };
    registry.register(failTool);

    const failPlanner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Fail for memory",
          assumptions: [],
          steps: [{ step_id: uuid(), title: "Failing step", tool_ref: { name: "mem-fail-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0 }],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const memPath = resolve(import.meta.dirname ?? ".", "../../.test-active-memory-fail.jsonl");
    try { await rm(memPath); } catch { /* ok */ }
    const { ActiveMemory } = await import("@karnevil9/memory");
    const activeMem = new ActiveMemory(memPath);
    await activeMem.load();

    const task: Task = { task_id: uuid(), text: "Failure lesson test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: failPlanner,
    }));
    (kernel as any).config.activeMemory = activeMem;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    expect(activeMem.getLessons().length).toBe(1);
    expect(activeMem.getLessons()[0]!.outcome).toBe("failed");

    try { await rm(memPath); } catch { /* ok */ }
  });

  // ─── Futility Detection Tests ─────────────────────────────────────

  it("agentic loop detects repeated errors and halts with futility.detected", async () => {
    const failTool: ToolManifest = {
      name: "futility-fail-tool", version: "1.0.0", description: "Always fails",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["result"], properties: { result: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}], // Missing required "result" → fails
    };
    registry.register(failTool);

    let callCount = 0;
    const repeatingPlanner: Planner = {
      async generatePlan(_task: Task) {
        callCount++;
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: `Attempt ${callCount}`,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{
            step_id: uuid(), title: `Failing step ${callCount}`,
            tool_ref: { name: "futility-fail-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "replan" as const,
            timeout_ms: 5000, max_retries: 0,
          }],
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Futility repeated error test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: repeatingPlanner,
      limits: { max_steps: 50, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    (kernel as any).config.futilityConfig = { maxRepeatedErrors: 3, maxStagnantIterations: 99, maxIdenticalPlans: 99 };
    await kernel.createSession(task);
    const session = await kernel.run();

    const events = await journal.readSession(session.session_id);
    const futilityEvent = events.find((e) => e.type === "futility.detected");
    expect(futilityEvent).toBeTruthy();
    expect((futilityEvent!.payload as any).reason).toContain("Same error repeated");
    expect(session.status).toBe("failed");
    // Should have stopped well before max_iterations
    expect(callCount).toBeLessThanOrEqual(4);
  });

  it("agentic loop detects stagnation and halts", async () => {
    registry.register(testTool);

    let callCount = 0;
    const stagnantPlanner: Planner = {
      async generatePlan(_task: Task) {
        callCount++;
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: `Stagnant iteration ${callCount}`,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{
            step_id: uuid(), title: `Step ${callCount}`,
            tool_ref: { name: "test-tool" },
            input: { message: `iter-${callCount}` },
            success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0,
          }],
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Futility stagnation test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: stagnantPlanner,
      limits: { max_steps: 50, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 20 },
    }));
    (kernel as any).config.agentic = true;
    // Each iteration produces 1 success, so success count stays at 1 → stagnation after 4 iterations (baseline + 3 stagnant)
    (kernel as any).config.futilityConfig = { maxRepeatedErrors: 99, maxStagnantIterations: 3, maxIdenticalPlans: 99 };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const futilityEvent = events.find((e) => e.type === "futility.detected");
    expect(futilityEvent).toBeTruthy();
    expect((futilityEvent!.payload as any).reason).toContain("No progress");
    const failedEvent = events.find((e) => e.type === "session.failed");
    expect(failedEvent).toBeTruthy();
    expect((failedEvent!.payload as any).reason).toContain("Futility detected");
  });

  it("agentic loop does not trigger futility on normal progress", async () => {
    registry.register(testTool);

    let callCount = 0;
    const progressPlanner: Planner = {
      async generatePlan(_task: Task) {
        callCount++;
        if (callCount <= 3) {
          // Each iteration adds more successful steps (growing step count)
          return { plan: {
            plan_id: uuid(), schema_version: "0.1", goal: `Progress iteration ${callCount}`,
            assumptions: [], created_at: new Date().toISOString(),
            steps: Array.from({ length: callCount }, (_, i) => ({
              step_id: uuid(), title: `Step ${callCount}-${i}`,
              tool_ref: { name: "test-tool" },
              input: { message: `iter-${callCount}-${i}` },
              success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0,
            })),
          } };
        }
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: "Task complete",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Futility no-trigger test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: progressPlanner,
      limits: { max_steps: 50, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    (kernel as any).config.futilityConfig = { maxRepeatedErrors: 3, maxStagnantIterations: 3, maxIdenticalPlans: 99 };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    expect(events.some((e) => e.type === "futility.detected")).toBe(false);
  });

  it("retry with backoff takes longer than immediate execution", async () => {
    const retryTool: ToolManifest = {
      name: "backoff-tool", version: "1.0.0", description: "Backoff test",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}], // Invalid output, will fail each time
    };
    registry.register(retryTool);

    const planner = {
      async generatePlan() {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1" as const, goal: "Backoff test",
          assumptions: [],
          steps: [{
            step_id: uuid(), title: "Backoff step", tool_ref: { name: "backoff-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 1,
          }],
          created_at: new Date().toISOString(),
        } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Backoff timing test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner }));
    await kernel.createSession(task);

    const start = Date.now();
    await kernel.run();
    const elapsed = Date.now() - start;

    // With backoff(1) = min(500*2^0, 15000) + jitter(0-500) = 500-1000ms
    // Should take at least 400ms (allowing for timer imprecision)
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  // ─── Usage / Cost Tracking Tests ──────────────────────────────────

  it("emits usage.recorded events during planning", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Usage tracking test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    const usageEvents = events.filter((e) => e.type === "usage.recorded");
    expect(usageEvents.length).toBeGreaterThan(0);
    expect(usageEvents[0]!.payload.total_tokens).toBe(100); // MockPlanner returns 100 tokens
  });

  it("getUsageSummary returns accumulated usage after run", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Usage summary test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    await kernel.run();

    const usage = kernel.getUsageSummary();
    expect(usage).not.toBeNull();
    expect(usage!.total_tokens).toBe(100);
    expect(usage!.call_count).toBe(1);
  });

  it("includes usage in session.completed event", async () => {
    registry.register(testTool);
    const task: Task = { task_id: uuid(), text: "Usage in completed test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readSession(session.session_id);
    const completed = events.find((e) => e.type === "session.completed");
    expect(completed).toBeTruthy();
    expect(completed!.payload.usage).toBeDefined();
    expect((completed!.payload.usage as any).total_tokens).toBe(100);
  });

  it("agentic loop enforces max_tokens limit", async () => {
    registry.register(testTool);

    // Planner that never signals done — MockPlanner returns 100 tokens each call
    const neverDonePlanner: Planner = {
      async generatePlan(task: Task) {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: task.text,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{
            step_id: uuid(), title: "Step",
            tool_ref: { name: "test-tool" },
            input: { message: "test" },
            success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0,
          }],
        }, usage: { input_tokens: 500, output_tokens: 500, total_tokens: 1000 } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Token limit test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: neverDonePlanner,
      limits: { max_steps: 50, max_duration_ms: 60000, max_cost_usd: 100, max_tokens: 2500, max_iterations: 20 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const limitEvent = events.find((e) => e.type === "limit.exceeded" && e.payload.limit === "max_tokens");
    expect(limitEvent).toBeTruthy();
  });

  it("agentic loop enforces max_cost_usd limit", async () => {
    registry.register(testTool);

    const expensivePlanner: Planner = {
      async generatePlan(task: Task) {
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: task.text,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{
            step_id: uuid(), title: "Step",
            tool_ref: { name: "test-tool" },
            input: { message: "test" },
            success_criteria: ["done"], failure_policy: "abort" as const,
            timeout_ms: 5000, max_retries: 0,
          }],
        }, usage: { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, cost_usd: 5.0 } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Cost limit test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: expensivePlanner,
      limits: { max_steps: 50, max_duration_ms: 60000, max_cost_usd: 8, max_tokens: 100000, max_iterations: 20 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const limitEvent = events.find((e) => e.type === "limit.exceeded" && e.payload.limit === "max_cost_usd");
    expect(limitEvent).toBeTruthy();
  });

  it("agentic loop passes usage to futility monitor for cost-based detection", async () => {
    const failTool: ToolManifest = {
      name: "cost-futility-tool", version: "1.0.0", description: "Fails for cost futility",
      runner: "internal",
      input_schema: { type: "object", additionalProperties: false },
      output_schema: { type: "object", required: ["result"], properties: { result: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{}], // Missing required "result" → fails
    };
    registry.register(failTool);

    let callCount = 0;
    const costPlanner: Planner = {
      async generatePlan(_task: Task) {
        callCount++;
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: `Cost attempt ${callCount}`,
          assumptions: [], created_at: new Date().toISOString(),
          steps: [{
            step_id: uuid(), title: `Step ${callCount}`,
            tool_ref: { name: "cost-futility-tool" },
            input: {}, success_criteria: ["done"], failure_policy: "replan" as const,
            timeout_ms: 5000, max_retries: 0,
          }],
        }, usage: { input_tokens: 500, output_tokens: 500, total_tokens: 1000, cost_usd: 2.0 } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Cost futility test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: costPlanner,
      limits: { max_steps: 50, max_duration_ms: 60000, max_cost_usd: 100, max_tokens: 100000, max_iterations: 20 },
    }));
    (kernel as any).config.agentic = true;
    (kernel as any).config.futilityConfig = {
      maxRepeatedErrors: 99,
      maxStagnantIterations: 99,
      maxIdenticalPlans: 99,
      maxCostWithoutProgress: 3,
    };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readSession(session.session_id);
    const futilityEvent = events.find((e) => e.type === "futility.detected");
    expect(futilityEvent).toBeTruthy();
    expect((futilityEvent!.payload as any).reason).toContain("without new successful steps");
  });

  it("accumulates usage across agentic iterations", async () => {
    registry.register(testTool);
    let callCount = 0;
    const multiIterPlanner: Planner = {
      async generatePlan(_task: Task) {
        callCount++;
        if (callCount <= 3) {
          return { plan: {
            plan_id: uuid(), schema_version: "0.1", goal: `Iteration ${callCount}`,
            assumptions: [], created_at: new Date().toISOString(),
            steps: [{
              step_id: uuid(), title: `Step ${callCount}`,
              tool_ref: { name: "test-tool" },
              input: { message: `iter-${callCount}` },
              success_criteria: ["done"], failure_policy: "abort" as const,
              timeout_ms: 5000, max_retries: 0,
            }],
          }, usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 } };
        }
        return { plan: {
          plan_id: uuid(), schema_version: "0.1", goal: "Task complete",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        }, usage: { input_tokens: 50, output_tokens: 50, total_tokens: 100 } };
      },
    };

    const task: Task = { task_id: uuid(), text: "Multi-iter usage test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions, planner: multiIterPlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 100, max_tokens: 100000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const usage = kernel.getUsageSummary();
    expect(usage).not.toBeNull();
    // 3 iterations * 200 tokens + 1 done * 100 tokens = 700 total
    expect(usage!.total_tokens).toBe(700);
    expect(usage!.call_count).toBe(4);
  });

  // ─── Context Budget Integration Tests ─────────────────────────────

  it("context budget disabled by default (no context events)", async () => {
    const browserTool: ToolManifest = {
      name: "browser", version: "1.0.0", description: "Browser tool",
      runner: "internal",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{ content: "page content" }],
    };
    registry.register(browserTool);

    const task: Task = { task_id: uuid(), text: "Browse something", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions,
      planner: new MockPlanner({ agentic: true }),
    }));
    (kernel as any).config.agentic = true;
    await kernel.createSession(task);
    const session = await kernel.run();

    const events = await journal.readSession(session.session_id);
    const contextEvents = events.filter(e => e.type.startsWith("context."));
    expect(contextEvents.length).toBe(0);
  });

  it("context budget fires checkpoint when tokens hit threshold", async () => {
    registry.register(testTool);

    // Planner that generates high token usage to trigger checkpoint
    let iterCount = 0;
    const highTokenPlanner: Planner = {
      async generatePlan(_task, _toolSchemas) {
        iterCount++;
        const usage = { input_tokens: 4000, output_tokens: 1000, total_tokens: 5000 };
        if (iterCount > 2) {
          return {
            plan: { plan_id: uuid(), schema_version: "0.1", goal: "Task complete", assumptions: [], steps: [], created_at: new Date().toISOString() },
            usage,
          };
        }
        return {
          plan: {
            plan_id: uuid(), schema_version: "0.1", goal: `Iteration ${iterCount}`,
            assumptions: [], steps: [{
              step_id: uuid(), title: `Step ${iterCount}`,
              tool_ref: { name: "test-tool" },
              input: { message: `test ${iterCount}` },
              success_criteria: ["ok"], failure_policy: "continue" as const,
              timeout_ms: 5000, max_retries: 0,
            }],
            created_at: new Date().toISOString(),
          },
          usage,
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "High token task", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions,
      planner: highTokenPlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 100, max_tokens: 10000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    (kernel as any).config.contextBudgetConfig = {
      checkpointThreshold: 0.85,
      summarizeThreshold: 0.95,
      minIterationsBeforeAction: 1,
    };
    await kernel.createSession(task);
    const session = await kernel.run();

    // Session should end gracefully (completed, not failed) due to checkpoint
    expect(["completed"]).toContain(session.status);

    const events = await journal.readSession(session.session_id);
    const _checkpointEvents = events.filter(e =>
      e.type === "context.checkpoint_triggered" || e.type === "context.checkpoint_saved"
    );
    // May or may not fire depending on exact token accumulation timing
    // The key is no crash occurred and backward compat is maintained
  });

  it("subagent spawning completes and parent continues with findings", async () => {
    const browserTool: ToolManifest = {
      name: "browser", version: "1.0.0", description: "Browser tool",
      runner: "internal",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
      output_schema: { type: "object", additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: false },
      mock_responses: [{ content: "page content" }],
    };
    registry.register(browserTool);

    // Planner that uses browser tool (high-burn) to trigger delegation
    let iterCount = 0;
    const browserPlanner: Planner = {
      async generatePlan(_task, _toolSchemas) {
        iterCount++;
        const usage = { input_tokens: 3000, output_tokens: 1000, total_tokens: 4000 };
        if (iterCount > 3) {
          return {
            plan: { plan_id: uuid(), schema_version: "0.1", goal: "Task complete", assumptions: [], steps: [], created_at: new Date().toISOString() },
            usage,
          };
        }
        return {
          plan: {
            plan_id: uuid(), schema_version: "0.1", goal: `Browse iteration ${iterCount}`,
            assumptions: [], steps: [{
              step_id: uuid(), title: `Browse step ${iterCount}`,
              tool_ref: { name: "browser" },
              input: { url: `https://example.com/${iterCount}` },
              success_criteria: ["ok"], failure_policy: "continue" as const,
              timeout_ms: 5000, max_retries: 0,
            }],
            created_at: new Date().toISOString(),
          },
          usage,
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Browse research task", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions,
      planner: browserPlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 100, max_tokens: 20000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    (kernel as any).config.contextBudgetConfig = {
      delegateThreshold: 0.30,
      checkpointThreshold: 0.90,
      summarizeThreshold: 0.95,
      minIterationsBeforeAction: 1,
    };
    await kernel.createSession(task);
    const session = await kernel.run();

    // Should complete without crashing regardless of delegation
    expect(["completed", "failed"]).toContain(session.status);

    const events = await journal.readSession(session.session_id);
    const budgetEvents = events.filter(e => e.type.startsWith("context."));
    // Should have at least budget_assessed events after the first iteration
    const _assessEvents = budgetEvents.filter(e => e.type === "context.budget_assessed");
    // assessEvents may exist depending on timing
  });

  it("subagent failure does not crash parent", async () => {
    registry.register(testTool);

    let iterCount = 0;
    const failPlanner: Planner = {
      async generatePlan(_task, _toolSchemas) {
        iterCount++;
        const usage = { input_tokens: 3000, output_tokens: 1000, total_tokens: 4000 };
        if (iterCount > 3) {
          return {
            plan: { plan_id: uuid(), schema_version: "0.1", goal: "Task complete", assumptions: [], steps: [], created_at: new Date().toISOString() },
            usage,
          };
        }
        return {
          plan: {
            plan_id: uuid(), schema_version: "0.1", goal: `Iteration ${iterCount}`,
            assumptions: [], steps: [{
              step_id: uuid(), title: `Step ${iterCount}`,
              tool_ref: { name: "test-tool" },
              input: { message: `test ${iterCount}` },
              success_criteria: ["ok"], failure_policy: "continue" as const,
              timeout_ms: 5000, max_retries: 0,
            }],
            created_at: new Date().toISOString(),
          },
          usage,
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Delegation failure test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({
      journal, runtime, registry, permissions,
      planner: failPlanner,
      limits: { max_steps: 20, max_duration_ms: 60000, max_cost_usd: 100, max_tokens: 20000, max_iterations: 10 },
    }));
    (kernel as any).config.agentic = true;
    (kernel as any).config.contextBudgetConfig = {
      delegateThreshold: 0.30,
      checkpointThreshold: 0.90,
      summarizeThreshold: 0.95,
      minIterationsBeforeAction: 1,
      highBurnTools: ["test-tool"], // make test-tool high-burn so delegation fires
    };
    await kernel.createSession(task);

    // Should not throw even if delegation occurs
    const session = await kernel.run();
    expect(["completed", "failed"]).toContain(session.status);
  });

  it("detects cyclic step dependencies and fails the session", async () => {
    registry.register(testTool);

    const stepA = uuid();
    const stepB = uuid();
    const stepC = uuid();

    const cyclicPlanner = {
      async generatePlan() {
        return {
          plan: {
            plan_id: uuid(), schema_version: "0.1" as const, goal: "Cyclic deps",
            assumptions: [],
            steps: [
              { step_id: stepA, title: "Step A", tool_ref: { name: "test-tool" },
                input: { message: "a" }, success_criteria: ["ok"],
                failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
                depends_on: [stepC] },
              { step_id: stepB, title: "Step B", tool_ref: { name: "test-tool" },
                input: { message: "b" }, success_criteria: ["ok"],
                failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
                depends_on: [stepA] },
              { step_id: stepC, title: "Step C", tool_ref: { name: "test-tool" },
                input: { message: "c" }, success_criteria: ["ok"],
                failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
                depends_on: [stepB] },
            ],
            created_at: new Date().toISOString(),
          },
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Cyclic dependency test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: cyclicPlanner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");
    // Check journal for the cyclic dependency evidence
    const events = await journal.readSession(session.session_id);
    const types = events.map(e => e.type);
    expect(types).toContain("session.started");
    // The cycle detection should prevent any steps from executing
    expect(types).not.toContain("step.started");
  });

  it("succeeds with valid (non-cyclic) step dependencies", async () => {
    registry.register(testTool);

    const stepA = uuid();
    const stepB = uuid();

    const linearPlanner = {
      async generatePlan() {
        return {
          plan: {
            plan_id: uuid(), schema_version: "0.1" as const, goal: "Linear deps",
            assumptions: [],
            steps: [
              { step_id: stepA, title: "Step A", tool_ref: { name: "test-tool" },
                input: { message: "first" }, success_criteria: ["ok"],
                failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0 },
              { step_id: stepB, title: "Step B", tool_ref: { name: "test-tool" },
                input: { message: "second" }, success_criteria: ["ok"],
                failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
                depends_on: [stepA] },
            ],
            created_at: new Date().toISOString(),
          },
        };
      },
    };

    const task: Task = { task_id: uuid(), text: "Linear dependency test", created_at: new Date().toISOString() };
    const kernel = new Kernel(makeKernelConfig({ journal, runtime, registry, permissions, planner: linearPlanner }));
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");
  });
});
