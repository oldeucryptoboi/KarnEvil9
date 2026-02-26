import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import type { Task, PlanResult, Planner, Step } from "@karnevil9/schemas";

const TOOLS_DIR = join(import.meta.dirname ?? ".", "../../tools/examples");

function makeStep(toolName: string, opts?: { stepId?: string }): Step {
  return {
    step_id: opts?.stepId ?? uuid(),
    title: `Execute ${toolName}`,
    tool_ref: { name: toolName },
    input: toolName === "shell-exec" ? { command: "echo test" } : { path: "test.txt" },
    success_criteria: ["Executes successfully"],
    failure_policy: "abort",
    timeout_ms: 10000,
    max_retries: 0,
  };
}

function makePlanResult(goal: string, steps: Step[]): PlanResult {
  return {
    plan: {
      plan_id: uuid(),
      schema_version: "0.1",
      goal,
      assumptions: ["Test planner"],
      steps,
      created_at: new Date().toISOString(),
    },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "test" },
  };
}

describe("Agentic Completion Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-agentic-completion-${uuid()}`);
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

  it("planner signals completion with empty steps after successful execution", async () => {
    let planCallCount = 0;

    const planner: Planner = {
      async generatePlan(task: Task): Promise<PlanResult> {
        planCallCount++;
        if (planCallCount === 1) {
          return makePlanResult(task.text, [makeStep("read-file")]);
        }
        // Second call: signal done
        return makePlanResult("Task complete", []);
      },
    };

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner,
      mode: "mock",
      agentic: true,
      limits: { max_steps: 10, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000, max_iterations: 5 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Agentic completion test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("completed");
    expect(planCallCount).toBe(2);

    const events = await journal.readAll();
    const planReceived = events.filter(e => e.type === "planner.plan_received");
    expect(planReceived).toHaveLength(2);

    const stepSucceeded = events.filter(e => e.type === "step.succeeded");
    expect(stepSucceeded).toHaveLength(1);

    const limitExceeded = events.find(e => e.type === "limit.exceeded");
    expect(limitExceeded).toBeUndefined();
  });

  it("iteration-0 empty plan is rejected", async () => {
    const planner: Planner = {
      async generatePlan(_task: Task): Promise<PlanResult> {
        return makePlanResult("Nothing to do", []);
      },
    };

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner,
      mode: "mock",
      agentic: true,
      limits: { max_steps: 10, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000, max_iterations: 5 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Empty plan test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const rejected = events.find(e => e.type === "planner.plan_rejected");
    expect(rejected).toBeDefined();
    expect(String(rejected!.payload.reason)).toContain("first iteration");
  });

  it("multi-iteration execution completes after work is done", async () => {
    let planCallCount = 0;

    const planner: Planner = {
      async generatePlan(task: Task): Promise<PlanResult> {
        planCallCount++;
        if (planCallCount <= 2) {
          return makePlanResult(`Iteration ${planCallCount}`, [makeStep("read-file")]);
        }
        // Third call: signal done
        return makePlanResult("Task complete", []);
      },
    };

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner,
      mode: "mock",
      agentic: true,
      limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000, max_iterations: 10 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Multi-iteration test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("completed");
    expect(planCallCount).toBe(3);

    const events = await journal.readAll();
    const planReceived = events.filter(e => e.type === "planner.plan_received");
    expect(planReceived).toHaveLength(3);

    const stepSucceeded = events.filter(e => e.type === "step.succeeded");
    expect(stepSucceeded).toHaveLength(2);
  });
});
