import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import type { Task, PlanResult, Planner, Step, ApprovalDecision, PermissionRequest } from "@karnevil9/schemas";

const TOOLS_DIR = join(import.meta.dirname ?? ".", "../../tools/manifests");

/** Planner that produces N sequential steps all using the same tool. */
function makeNStepPlanner(toolName: string, n: number): Planner {
  return {
    async generatePlan(task: Task): Promise<PlanResult> {
      const steps: Step[] = [];
      for (let i = 0; i < n; i++) {
        steps.push({
          step_id: uuid(),
          title: `Step ${i + 1}: ${toolName}`,
          tool_ref: { name: toolName },
          input: { path: `file-${i}.txt` },
          success_criteria: ["Executes"],
          failure_policy: "abort",
          timeout_ms: 10000,
          max_retries: 0,
        });
      }
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
}

describe("Permission Scoping Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-perm-scope-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("allow_once: prompt is called for every step", async () => {
    let promptCallCount = 0;
    const permissions = new PermissionEngine(journal, async (_req: PermissionRequest): Promise<ApprovalDecision> => {
      promptCallCount++;
      return "allow_once";
    });
    runtime = new ToolRuntime(registry, permissions, journal);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeNStepPlanner("read-file", 3),
      mode: "mock",
      limits: { max_steps: 10, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "allow_once test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    // Each step requires its own prompt because allow_once is cleared after each step
    expect(promptCallCount).toBe(3);
  });

  it("allow_session: prompt is called only once for the session", async () => {
    let promptCallCount = 0;
    const permissions = new PermissionEngine(journal, async (_req: PermissionRequest): Promise<ApprovalDecision> => {
      promptCallCount++;
      return "allow_session";
    });
    runtime = new ToolRuntime(registry, permissions, journal);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeNStepPlanner("read-file", 3),
      mode: "mock",
      limits: { max_steps: 10, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "allow_session test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    // Only the first step triggers a prompt; subsequent steps use cached grant
    expect(promptCallCount).toBe(1);
  });

  it("deny: step fails with permission denied", async () => {
    let promptCallCount = 0;
    const permissions = new PermissionEngine(journal, async (_req: PermissionRequest): Promise<ApprovalDecision> => {
      promptCallCount++;
      return "deny";
    });
    runtime = new ToolRuntime(registry, permissions, journal);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeNStepPlanner("read-file", 1),
      mode: "mock",
      limits: { max_steps: 10, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    });

    const task: Task = { task_id: uuid(), text: "deny test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    expect(promptCallCount).toBe(1);

    const events = await journal.readAll();
    const stepFailed = events.find(e => e.type === "step.failed");
    expect(stepFailed).toBeDefined();
    expect(String(stepFailed!.payload.error?.code ?? stepFailed!.payload.error)).toContain("PERMISSION_DENIED");
  });

  it("preGrantedScopes bypass prompt entirely", async () => {
    let promptCallCount = 0;
    const permissions = new PermissionEngine(journal, async (_req: PermissionRequest): Promise<ApprovalDecision> => {
      promptCallCount++;
      return "deny"; // Would deny if ever reached
    });
    runtime = new ToolRuntime(registry, permissions, journal);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeNStepPlanner("read-file", 2),
      mode: "mock",
      limits: { max_steps: 10, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      preGrantedScopes: ["filesystem:read:workspace"],
    });

    const task: Task = { task_id: uuid(), text: "preGrant test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    // Prompt was never called — pre-granted scopes bypassed it
    expect(promptCallCount).toBe(0);
  });
});
