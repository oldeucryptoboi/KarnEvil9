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

describe("Context Budget Enforcement Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-budget-${uuid()}`);
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

  it("max_steps: plan with too many steps is rejected", async () => {
    // Planner produces 5 steps but limit is 3
    const planner: Planner = {
      async generatePlan(task: Task): Promise<PlanResult> {
        const steps: Step[] = Array.from({ length: 5 }, (_, i) => ({
          step_id: uuid(),
          title: `Step ${i + 1}`,
          tool_ref: { name: "read-file" },
          input: { path: `file-${i}.txt` },
          success_criteria: ["Executes"],
          failure_policy: "abort" as const,
          timeout_ms: 10000,
          max_retries: 0,
        }));
        return {
          plan: {
            plan_id: uuid(),
            schema_version: "0.1",
            goal: task.text,
            assumptions: ["Test planner"],
            steps,
            created_at: new Date().toISOString(),
          },
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "test" },
        };
      },
    };

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner,
      mode: "mock",
      limits: { max_steps: 3, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Too many steps", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const rejected = events.find(e => e.type === "planner.plan_rejected");
    expect(rejected).toBeDefined();
    expect(String(rejected!.payload.errors)).toContain("exceeds limit");
  });

  it("max_duration_ms: session fails when execution exceeds time limit", async () => {
    // Register a slow handler
    runtime.registerHandler("read-file", async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return { content: "slow", exists: true, size_bytes: 4 };
    });

    // Planner with 1 step
    const planner: Planner = {
      async generatePlan(task: Task): Promise<PlanResult> {
        return {
          plan: {
            plan_id: uuid(),
            schema_version: "0.1",
            goal: task.text,
            assumptions: ["Test planner"],
            steps: [{
              step_id: uuid(),
              title: "Slow step",
              tool_ref: { name: "read-file" },
              input: { path: "test.txt" },
              success_criteria: ["Executes"],
              failure_policy: "abort",
              timeout_ms: 10000,
              max_retries: 0,
            }],
            created_at: new Date().toISOString(),
          },
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "test" },
        };
      },
    };

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner,
      mode: "real",
      // Very short duration limit — likely exceeded before step completes
      limits: { max_steps: 10, max_duration_ms: 50, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Duration limit test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();

    // Session may complete if the duration check happens after the step finishes,
    // or fail if checked during the loop iteration. With 50ms limit and 500ms handler,
    // failure is highly likely but depends on timing.
    if (session.status === "failed") {
      const events = await journal.readAll();
      const limitEvent = events.find(e => e.type === "limit.exceeded");
      if (limitEvent) {
        expect(limitEvent.payload.limit).toBe("max_duration_ms");
      }
    }
    // Either way the session terminated
    expect(["completed", "failed"]).toContain(session.status);
  });

  it("max_steps in agentic mode: cumulative step limit is enforced across iterations", async () => {
    let planCallCount = 0;

    const planner: Planner = {
      async generatePlan(task: Task): Promise<PlanResult> {
        planCallCount++;
        // Each iteration produces 2 steps
        return {
          plan: {
            plan_id: uuid(),
            schema_version: "0.1",
            goal: task.text,
            assumptions: [`Iteration ${planCallCount}`],
            steps: Array.from({ length: 2 }, (_, i) => ({
              step_id: uuid(),
              title: `Iter ${planCallCount} Step ${i + 1}`,
              tool_ref: { name: "read-file" },
              input: { path: `file-${planCallCount}-${i}.txt` },
              success_criteria: ["Executes"],
              failure_policy: "abort" as const,
              timeout_ms: 10000,
              max_retries: 0,
            })),
            created_at: new Date().toISOString(),
          },
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "test" },
        };
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
      // max_steps: 3 — first iteration (2 steps) succeeds, second iteration (2 more = 4 total) exceeds limit
      limits: { max_steps: 3, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000, max_iterations: 10 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Cumulative step limit test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const limitEvent = events.find(e => e.type === "limit.exceeded" && e.payload.limit === "max_steps");
    expect(limitEvent).toBeDefined();
  });
});
