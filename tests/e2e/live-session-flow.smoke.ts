import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime, readFileHandler, shellExecHandler } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import type { Task, Plan, PlanResult, Planner, Step } from "@karnevil9/schemas";

const TOOLS_DIR = join(import.meta.dirname ?? ".", "../../tools/manifests");

function makeStep(toolName: string, input: Record<string, unknown>): Step {
  return {
    step_id: uuid(),
    title: `Execute ${toolName}`,
    tool_ref: { name: toolName },
    input,
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
      assumptions: ["Live session test"],
      steps,
      created_at: new Date().toISOString(),
    },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "test" },
  };
}

describe("Live Session Flow Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-live-flow-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);
    runtime.registerHandler("read-file", readFileHandler);
    runtime.registerHandler("shell-exec", shellExecHandler);
  });

  afterEach(async () => {
    await journal.close();
    await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  it("full live lifecycle: read file + shell exec with real output", async () => {
    const targetFile = join(testDir, "hello.txt");
    await writeFile(targetFile, "Live mode works!");

    let callCount = 0;
    const planner: Planner = {
      async generatePlan(_task: Task): Promise<PlanResult> {
        callCount++;
        return makePlanResult("Read a file and list it", [
          makeStep("read-file", { path: targetFile }),
          makeStep("shell-exec", { command: `echo "verified"` }),
        ]);
      },
    };

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner,
      mode: "live",
      limits: { max_steps: 10, max_duration_ms: 15000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [testDir], allowed_endpoints: [], allowed_commands: ["echo"], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Live smoke test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("completed");
    expect(session.mode).toBe("live");
    expect(callCount).toBe(1);

    // Verify journal events
    const events = await journal.readAll();
    const sessionEvents = events.filter(e => e.session_id === session.session_id);
    const eventTypes = sessionEvents.map(e => e.type);

    expect(eventTypes).toContain("session.created");
    expect(eventTypes).toContain("session.completed");
    expect(eventTypes).toContain("step.succeeded");

    // Verify real file content in output
    const stepSucceeded = sessionEvents.filter(e => e.type === "step.succeeded");
    expect(stepSucceeded.length).toBe(2);

    const readOutput = stepSucceeded[0]!.payload.output as { content: string; exists: boolean };
    expect(readOutput.content).toBe("Live mode works!");
    expect(readOutput.exists).toBe(true);

    const shellOutput = stepSucceeded[1]!.payload.output as { stdout: string; exit_code: number };
    expect(shellOutput.stdout.trim()).toBe("verified");
    expect(shellOutput.exit_code).toBe(0);

    // Verify hash chain integrity
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("agentic live mode: multi-iteration with real tool execution", async () => {
    const targetFile = join(testDir, "data.txt");
    await writeFile(targetFile, "iteration-1-data");

    let iteration = 0;
    const planner: Planner = {
      async generatePlan(_task: Task): Promise<PlanResult> {
        iteration++;
        if (iteration === 1) {
          return makePlanResult("Read data file", [
            makeStep("read-file", { path: targetFile }),
          ]);
        }
        // Second iteration: done
        return makePlanResult("Task complete", []);
      },
    };

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner,
      mode: "live",
      agentic: true,
      limits: { max_steps: 10, max_duration_ms: 15000, max_cost_usd: 10, max_tokens: 100000, max_iterations: 5 },
      policy: { allowed_paths: [testDir], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Agentic live test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("completed");
    expect(iteration).toBe(2);

    // Verify two plan phases occurred
    const events = await journal.readAll();
    const planReceived = events.filter(e => e.type === "planner.plan_received");
    expect(planReceived.length).toBe(2);

    // Verify real output from first iteration
    const stepSucceeded = events.find(e => e.type === "step.succeeded");
    expect(stepSucceeded).toBeDefined();
    const output = stepSucceeded!.payload.output as { content: string };
    expect(output.content).toBe("iteration-1-data");
  });

  it("live mode abort mid-execution", async () => {
    const planner: Planner = {
      async generatePlan(_task: Task): Promise<PlanResult> {
        return makePlanResult("Slow task", [
          makeStep("shell-exec", { command: "sleep 5" }),
        ]);
      },
    };

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner,
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [testDir], allowed_endpoints: [], allowed_commands: ["sleep"], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "Abort test", created_at: new Date().toISOString() };
    await kernel.createSession(task);

    // Start run and abort after 500ms
    const runPromise = kernel.run();
    setTimeout(() => kernel.abort(), 500);

    const session = await runPromise;
    expect(session.status).toBe("aborted");

    const events = await journal.readAll();
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain("session.created");
    expect(eventTypes).toContain("session.aborted");
  });

  it("concurrent live sessions produce isolated journal entries", async () => {
    const file1 = join(testDir, "file1.txt");
    const file2 = join(testDir, "file2.txt");
    await writeFile(file1, "session-one");
    await writeFile(file2, "session-two");

    function makeKernel(filePath: string): Kernel {
      const planner: Planner = {
        async generatePlan(_task: Task): Promise<PlanResult> {
          return makePlanResult("Read file", [makeStep("read-file", { path: filePath })]);
        },
      };
      return new Kernel({
        journal,
        toolRegistry: registry,
        toolRuntime: runtime,
        permissions,
        planner,
        mode: "live",
        limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
        policy: { allowed_paths: [testDir], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      });
    }

    const k1 = makeKernel(file1);
    const k2 = makeKernel(file2);

    const t1: Task = { task_id: uuid(), text: "Session 1", created_at: new Date().toISOString() };
    const t2: Task = { task_id: uuid(), text: "Session 2", created_at: new Date().toISOString() };

    await k1.createSession(t1);
    await k2.createSession(t2);

    const [s1, s2] = await Promise.all([k1.run(), k2.run()]);

    expect(s1.status).toBe("completed");
    expect(s2.status).toBe("completed");
    expect(s1.session_id).not.toBe(s2.session_id);

    // Each session has its own events
    const events = await journal.readAll();
    const s1Events = events.filter(e => e.session_id === s1.session_id);
    const s2Events = events.filter(e => e.session_id === s2.session_id);

    expect(s1Events.some(e => e.type === "step.succeeded")).toBe(true);
    expect(s2Events.some(e => e.type === "step.succeeded")).toBe(true);

    // Verify output isolation
    const s1Step = s1Events.find(e => e.type === "step.succeeded");
    const s2Step = s2Events.find(e => e.type === "step.succeeded");
    expect((s1Step!.payload.output as { content: string }).content).toBe("session-one");
    expect((s2Step!.payload.output as { content: string }).content).toBe("session-two");

    // Hash chain remains valid across concurrent writes
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });
});
