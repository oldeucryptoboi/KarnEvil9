import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime, readFileHandler, shellExecHandler } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import type { Task, Plan, PlanResult, Planner, ToolSchemaForPlanner } from "@karnevil9/schemas";

const TOOLS_DIR = join(import.meta.dirname ?? ".", "../../tools/examples");

/** Planner that produces a single step referencing the given tool with given input. */
function makeSingleStepPlanner(toolName: string, input: Record<string, unknown>): Planner {
  return {
    async generatePlan(task: Task): Promise<PlanResult> {
      return {
        plan: {
          plan_id: uuid(),
          schema_version: "0.1",
          goal: task.text,
          assumptions: ["Test planner"],
          steps: [{
            step_id: uuid(),
            title: `Execute ${toolName}`,
            tool_ref: { name: toolName },
            input,
            success_criteria: ["Tool executes successfully"],
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
}

describe("Real Tool Execution Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-real-tools-${uuid()}`);
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

  it("reads a real file with readFileHandler in real mode", async () => {
    // Create a file to read
    const targetFile = join(testDir, "hello.txt");
    await writeFile(targetFile, "Hello from e2e test!");

    runtime.registerHandler("read-file", readFileHandler);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("read-file", { path: targetFile }),
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [testDir], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Read a real file", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    // Verify real output was produced (not mock_responses)
    const events = await journal.readAll();
    const toolSucceeded = events.find(e => e.type === "tool.succeeded");
    expect(toolSucceeded).toBeDefined();

    const stepSucceeded = events.find(e => e.type === "step.succeeded");
    expect(stepSucceeded).toBeDefined();
    expect((stepSucceeded!.payload.output as { content: string }).content).toBe("Hello from e2e test!");
    expect((stepSucceeded!.payload.output as { exists: boolean }).exists).toBe(true);
  });

  it("executes a real shell command with shellExecHandler", async () => {
    runtime.registerHandler("shell-exec", shellExecHandler);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("shell-exec", { command: "echo hello-e2e" }),
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: ["echo"], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Execute a shell command", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readAll();
    const stepSucceeded = events.find(e => e.type === "step.succeeded");
    expect(stepSucceeded).toBeDefined();
    const output = stepSucceeded!.payload.output as { exit_code: number; stdout: string };
    expect(output.exit_code).toBe(0);
    expect(output.stdout).toContain("hello-e2e");
  });

  it("real mode without handler fails with EXECUTION_ERROR", async () => {
    // Don't register any handler — tool exists in registry but has no real handler
    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("read-file", { path: "/tmp/nonexistent" }),
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Read without handler", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const stepFailed = events.find(e => e.type === "step.failed");
    expect(stepFailed).toBeDefined();
  });

  it("mock mode returns mock_responses without a handler", async () => {
    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("read-file", { path: "test.txt" }),
      mode: "mock",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Mock mode test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readAll();
    const stepSucceeded = events.find(e => e.type === "step.succeeded");
    expect(stepSucceeded).toBeDefined();
    // Mock responses come from the tool.yaml mock_responses
    const output = stepSucceeded!.payload.output as { content: string; exists: boolean };
    expect(output.exists).toBe(true);
    expect(output.content).toContain("Example file content");
  });
});
