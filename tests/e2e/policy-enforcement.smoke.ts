import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime, readFileHandler, shellExecHandler } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import type { Task, PlanResult, Planner, PolicyProfile } from "@karnevil9/schemas";

const TOOLS_DIR = join(import.meta.dirname ?? ".", "../../tools/examples");

function makeSingleStepPlanner(toolName: string, input: Record<string, unknown>): Planner {
  return {
    async generatePlan(task: Task): Promise<PlanResult> {
      return {
        plan: {
          plan_id: uuid(),
          schema_version: "0.1",
          goal: task.text,
          assumptions: ["Policy enforcement test"],
          steps: [{
            step_id: uuid(),
            title: `Execute ${toolName}`,
            tool_ref: { name: toolName },
            input,
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
}

describe("Policy Enforcement Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-policy-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Create a ToolRuntime with the given policy (policy must be on the ToolRuntime for enforcement). */
  function makeRuntime(policy: PolicyProfile): ToolRuntime {
    return new ToolRuntime(registry, permissions, journal, policy);
  }

  it("path violation: read-file outside allowed_paths is blocked", async () => {
    const policy: PolicyProfile = { allowed_paths: [testDir], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false };
    const runtime = makeRuntime(policy);
    runtime.registerHandler("read-file", readFileHandler);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("read-file", { path: "/etc/hostname" }),
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy,
    });

    const task: Task = { task_id: uuid(), text: "Path violation test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const policyViolated = events.find(e => e.type === "policy.violated");
    expect(policyViolated).toBeDefined();
    expect(String(policyViolated!.payload.violation_message)).toContain("outside allowed paths");
  });

  it("command violation: disallowed command is blocked", async () => {
    const policy: PolicyProfile = { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: ["echo", "ls"], require_approval_for_writes: false };
    const runtime = makeRuntime(policy);
    runtime.registerHandler("shell-exec", shellExecHandler);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("shell-exec", { command: "rm /tmp/something" }),
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy,
    });

    const task: Task = { task_id: uuid(), text: "Command violation test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const policyViolated = events.find(e => e.type === "policy.violated");
    expect(policyViolated).toBeDefined();
    expect(String(policyViolated!.payload.violation_message)).toContain("not in allowed commands");
  });

  it("sensitive file protection: .env file read is blocked even within allowed_paths", async () => {
    const policy: PolicyProfile = { allowed_paths: [testDir], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false };
    const runtime = makeRuntime(policy);
    runtime.registerHandler("read-file", readFileHandler);

    const envPath = join(testDir, ".env");

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("read-file", { path: envPath }),
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy,
    });

    const task: Task = { task_id: uuid(), text: "Sensitive file test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const policyViolated = events.find(e => e.type === "policy.violated");
    expect(policyViolated).toBeDefined();
    expect(String(policyViolated!.payload.violation_message)).toContain("sensitive");
  });

  it("dangerous flags: command with dangerous flags is blocked", async () => {
    const policy: PolicyProfile = { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: ["find"], require_approval_for_writes: false };
    const runtime = makeRuntime(policy);
    runtime.registerHandler("shell-exec", shellExecHandler);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("shell-exec", { command: "find /tmp -name '*.log' -delete" }),
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy,
    });

    const task: Task = { task_id: uuid(), text: "Dangerous flags test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("failed");

    const events = await journal.readAll();
    const policyViolated = events.find(e => e.type === "policy.violated");
    expect(policyViolated).toBeDefined();
    expect(String(policyViolated!.payload.violation_message).toLowerCase()).toContain("dangerous");
  });

  it("allowed operations succeed within policy", async () => {
    const policy: PolicyProfile = { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: ["echo"], require_approval_for_writes: false };
    const runtime = makeRuntime(policy);
    runtime.registerHandler("shell-exec", shellExecHandler);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: makeSingleStepPlanner("shell-exec", { command: "echo policy-ok" }),
      mode: "live",
      limits: { max_steps: 5, max_duration_ms: 10000, max_cost_usd: 10, max_tokens: 100000 },
      policy,
    });

    const task: Task = { task_id: uuid(), text: "Allowed command test", created_at: new Date().toISOString() };
    await kernel.createSession(task);
    const session = await kernel.run();
    expect(session.status).toBe("completed");

    const events = await journal.readAll();
    const policyViolated = events.find(e => e.type === "policy.violated");
    expect(policyViolated).toBeUndefined();
  });
});
