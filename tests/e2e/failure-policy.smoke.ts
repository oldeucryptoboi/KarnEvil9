import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import type { Task, Plan, PlanResult, Planner, Step, FailurePolicy } from "@karnevil9/schemas";

const TOOLS_DIR = join(import.meta.dirname ?? ".", "../../tools/examples");

/** Planner that returns a custom list of steps. */
function makeMultiStepPlanner(steps: Step[]): Planner {
  return {
    async generatePlan(task: Task): Promise<PlanResult> {
      return {
        plan: {
          plan_id: uuid(),
          schema_version: "0.1",
          goal: task.text,
          assumptions: ["Test planner for failure policy"],
          steps,
          created_at: new Date().toISOString(),
        },
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "test" },
      };
    },
  };
}

function makeStep(toolName: string, failurePolicy: FailurePolicy, opts?: { dependsOn?: string[] }): Step {
  return {
    step_id: uuid(),
    title: `Execute ${toolName} (${failurePolicy})`,
    tool_ref: { name: toolName },
    input: toolName === "shell-exec" ? { command: "echo test" } : { path: "test.txt" },
    success_criteria: ["Executes"],
    failure_policy: failurePolicy,
    timeout_ms: 10000,
    max_retries: 0,
    ...(opts?.dependsOn ? { depends_on: opts.dependsOn } : {}),
  };
}

describe("Failure Policy Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-failure-policy-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("abort policy: session fails when step fails", async () => {
    // Register a handler that always fails
    runtime.registerHandler("read-file", async () => {
      throw new Error("Deliberate failure for abort test");
    });

    const step = makeStep("read-file", "abort");
    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeMultiStepPlanner([step]),
      mode: "real",
      limits: { max_steps: 10, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Abort policy test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const sessionFailed = events.find(e => e.type === "session.failed");
    expect(sessionFailed).toBeDefined();
    expect(String(sessionFailed!.payload.reason)).toContain("abort");
  });

  it("continue policy: subsequent steps still execute after failure", async () => {
    const failStepId = uuid();
    const succeedStepId = uuid();

    const failStep: Step = {
      step_id: failStepId,
      title: "Failing step (continue)",
      tool_ref: { name: "read-file" },
      input: { path: "test.txt" },
      success_criteria: ["Runs"],
      failure_policy: "continue",
      timeout_ms: 10000,
      max_retries: 0,
    };

    const succeedStep: Step = {
      step_id: succeedStepId,
      title: "Succeeding step",
      tool_ref: { name: "shell-exec" },
      input: { command: "echo success" },
      success_criteria: ["Runs"],
      failure_policy: "abort",
      timeout_ms: 10000,
      max_retries: 0,
    };

    // read-file handler fails, shell-exec handler succeeds
    runtime.registerHandler("read-file", async () => {
      throw new Error("Deliberate read failure");
    });
    runtime.registerHandler("shell-exec", async () => {
      return { exit_code: 0, stdout: "success\n", stderr: "" };
    });

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeMultiStepPlanner([failStep, succeedStep]),
      mode: "real",
      limits: { max_steps: 10, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: ["echo"], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Continue policy test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    // With continue policy, session should complete despite the failed step
    expect(session.status).toBe("completed");

    const events = await journal.readAll();
    const stepEvents = events.filter(e => e.type === "step.failed" || e.type === "step.succeeded");
    // Both steps executed: one failed, one succeeded
    expect(stepEvents).toHaveLength(2);
    expect(stepEvents.some(e => e.type === "step.failed" && e.payload.step_id === failStepId)).toBe(true);
    expect(stepEvents.some(e => e.type === "step.succeeded" && e.payload.step_id === succeedStepId)).toBe(true);
  });

  it("abort policy: dependent steps are skipped when their dependency fails", async () => {
    const parentId = uuid();
    const childId = uuid();

    const parentStep: Step = {
      step_id: parentId,
      title: "Parent step (fails)",
      tool_ref: { name: "read-file" },
      input: { path: "test.txt" },
      success_criteria: ["Runs"],
      failure_policy: "abort",
      timeout_ms: 10000,
      max_retries: 0,
    };

    const childStep: Step = {
      step_id: childId,
      title: "Child step (depends on parent)",
      tool_ref: { name: "shell-exec" },
      input: { command: "echo child" },
      success_criteria: ["Runs"],
      failure_policy: "abort",
      timeout_ms: 10000,
      max_retries: 0,
      depends_on: [parentId],
    };

    runtime.registerHandler("read-file", async () => {
      throw new Error("Parent failure");
    });
    runtime.registerHandler("shell-exec", async () => {
      return { exit_code: 0, stdout: "child\n", stderr: "" };
    });

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeMultiStepPlanner([parentStep, childStep]),
      mode: "real",
      limits: { max_steps: 10, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: ["echo"], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Dependency skip test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    // The child step should never have started
    const events = await journal.readAll();
    const childStarted = events.find(e => e.type === "step.started" && e.payload.step_id === childId);
    expect(childStarted).toBeUndefined();
  });

  it("replan policy in agentic mode: triggers replanning after failure", async () => {
    let planCallCount = 0;
    const replanStepId = uuid();

    const replanPlanner: Planner = {
      async generatePlan(task: Task, _schemas, stateSnapshot): Promise<PlanResult> {
        planCallCount++;
        if (planCallCount === 1) {
          // First plan: step that will fail with replan policy
          return {
            plan: {
              plan_id: uuid(),
              schema_version: "0.1",
              goal: task.text,
              assumptions: ["First attempt"],
              steps: [{
                step_id: replanStepId,
                title: "Failing step (replan)",
                tool_ref: { name: "read-file" },
                input: { path: "test.txt" },
                success_criteria: ["Runs"],
                failure_policy: "replan",
                timeout_ms: 10000,
                max_retries: 0,
              }],
              created_at: new Date().toISOString(),
            },
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "test" },
          };
        }
        // Second plan: signal done (empty steps)
        return {
          plan: {
            plan_id: uuid(),
            schema_version: "0.1",
            goal: "Task complete",
            assumptions: ["Replanned successfully"],
            steps: [],
            created_at: new Date().toISOString(),
          },
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "test" },
        };
      },
    };

    runtime.registerHandler("read-file", async () => {
      throw new Error("Deliberate failure to trigger replan");
    });

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: replanPlanner,
      mode: "real",
      agentic: true,
      limits: { max_steps: 10, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000, max_iterations: 5 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Replan policy test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    // Planner was called at least twice (initial + replan)
    expect(planCallCount).toBeGreaterThanOrEqual(2);

    const events = await journal.readAll();
    const planReceived = events.filter(e => e.type === "planner.plan_received");
    expect(planReceived.length).toBeGreaterThanOrEqual(2);
  });
});
