import { describe, it, expect } from "vitest";
import { v4 as uuid } from "uuid";
import type { Plan, Session, ToolSchemaForPlanner } from "@openvger/schemas";
import {
  toolInputCritic,
  stepLimitCritic,
  selfReferenceCritic,
  unknownToolCritic,
  runCritics,
} from "./critics.js";
import type { CriticContext } from "./critics.js";

const toolSchemas: ToolSchemaForPlanner[] = [
  {
    name: "read-file",
    version: "1.0.0",
    description: "Read a file",
    input_schema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    output_schema: { type: "object", properties: { content: { type: "string" } } },
  },
  {
    name: "write-file",
    version: "1.0.0",
    description: "Write a file",
    input_schema: {
      type: "object",
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" } },
      additionalProperties: false,
    },
    output_schema: { type: "object" },
  },
];

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: uuid(),
    status: "planning",
    mode: "mock",
    task: { task_id: uuid(), text: "test", created_at: new Date().toISOString() },
    active_plan_id: null,
    limits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
    policy: { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<CriticContext> = {}): CriticContext {
  return {
    session: makeSession(),
    toolSchemas,
    ...overrides,
  };
}

function makePlan(steps: Plan["steps"]): Plan {
  return {
    plan_id: uuid(),
    schema_version: "0.1",
    goal: "Test",
    assumptions: [],
    steps,
    created_at: new Date().toISOString(),
  };
}

describe("toolInputCritic", () => {
  it("passes when all required inputs are provided", () => {
    const plan = makePlan([{
      step_id: uuid(), title: "Read", tool_ref: { name: "read-file" },
      input: { path: "/tmp/test.txt" }, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const result = toolInputCritic(plan, makeContext());
    expect(result.passed).toBe(true);
  });

  it("fails when required input is missing", () => {
    const plan = makePlan([{
      step_id: uuid(), title: "Read", tool_ref: { name: "read-file" },
      input: {}, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const result = toolInputCritic(plan, makeContext());
    expect(result.passed).toBe(false);
    expect(result.severity).toBe("error");
    expect(result.message).toContain("path");
  });

  it("detects multiple missing inputs", () => {
    const plan = makePlan([{
      step_id: uuid(), title: "Write", tool_ref: { name: "write-file" },
      input: {}, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const result = toolInputCritic(plan, makeContext());
    expect(result.passed).toBe(false);
    expect(result.message).toContain("path");
    expect(result.message).toContain("content");
  });

  it("skips unknown tools (handled by unknownToolCritic)", () => {
    const plan = makePlan([{
      step_id: uuid(), title: "Unknown", tool_ref: { name: "nonexistent" },
      input: {}, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const result = toolInputCritic(plan, makeContext());
    expect(result.passed).toBe(true);
  });
});

describe("stepLimitCritic", () => {
  it("passes when under limit", () => {
    const plan = makePlan([{
      step_id: uuid(), title: "Step", tool_ref: { name: "read-file" },
      input: { path: "x" }, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const result = stepLimitCritic(plan, makeContext());
    expect(result.passed).toBe(true);
  });

  it("fails when over limit", () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({
      step_id: uuid(), title: `Step ${i}`, tool_ref: { name: "read-file" },
      input: { path: "x" }, success_criteria: ["done"],
      failure_policy: "abort" as const, timeout_ms: 5000, max_retries: 0,
    }));
    const plan = makePlan(steps);
    const result = stepLimitCritic(plan, makeContext());
    expect(result.passed).toBe(false);
    expect(result.message).toContain("15");
    expect(result.message).toContain("10");
  });
});

describe("selfReferenceCritic", () => {
  it("passes with no dependencies", () => {
    const plan = makePlan([{
      step_id: "s1", title: "Step", tool_ref: { name: "read-file" },
      input: { path: "x" }, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const result = selfReferenceCritic(plan, makeContext());
    expect(result.passed).toBe(true);
  });

  it("fails when step depends on itself", () => {
    const plan = makePlan([{
      step_id: "s1", title: "Self ref", tool_ref: { name: "read-file" },
      input: { path: "x" }, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
      depends_on: ["s1"],
    }]);
    const result = selfReferenceCritic(plan, makeContext());
    expect(result.passed).toBe(false);
    expect(result.message).toContain("depends on itself");
  });

  it("fails on circular dependency (A→B→A)", () => {
    const plan = makePlan([
      {
        step_id: "a", title: "A", tool_ref: { name: "read-file" },
        input: { path: "x" }, success_criteria: ["done"],
        failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
        depends_on: ["b"],
      },
      {
        step_id: "b", title: "B", tool_ref: { name: "read-file" },
        input: { path: "x" }, success_criteria: ["done"],
        failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
        depends_on: ["a"],
      },
    ]);
    const result = selfReferenceCritic(plan, makeContext());
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Circular dependency");
  });

  it("passes with valid linear dependencies", () => {
    const plan = makePlan([
      {
        step_id: "a", title: "A", tool_ref: { name: "read-file" },
        input: { path: "x" }, success_criteria: ["done"],
        failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
      },
      {
        step_id: "b", title: "B", tool_ref: { name: "read-file" },
        input: { path: "x" }, success_criteria: ["done"],
        failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
        depends_on: ["a"],
      },
    ]);
    const result = selfReferenceCritic(plan, makeContext());
    expect(result.passed).toBe(true);
  });
});

describe("unknownToolCritic", () => {
  it("passes when all tools are known", () => {
    const plan = makePlan([{
      step_id: uuid(), title: "Read", tool_ref: { name: "read-file" },
      input: { path: "x" }, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const result = unknownToolCritic(plan, makeContext());
    expect(result.passed).toBe(true);
  });

  it("fails when tool is unknown", () => {
    const plan = makePlan([{
      step_id: uuid(), title: "Bad", tool_ref: { name: "nonexistent" },
      input: {}, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const result = unknownToolCritic(plan, makeContext());
    expect(result.passed).toBe(false);
    expect(result.message).toContain("nonexistent");
  });
});

describe("runCritics", () => {
  it("runs all default critics and returns results", () => {
    const plan = makePlan([{
      step_id: uuid(), title: "Read", tool_ref: { name: "read-file" },
      input: { path: "x" }, success_criteria: ["done"],
      failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
    }]);
    const results = runCritics(plan, makeContext());
    expect(results).toHaveLength(4);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it("returns errors from multiple critics", () => {
    // Plan with unknown tool AND circular dependency
    const plan = makePlan([
      {
        step_id: "a", title: "A", tool_ref: { name: "nonexistent" },
        input: {}, success_criteria: ["done"],
        failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
        depends_on: ["b"],
      },
      {
        step_id: "b", title: "B", tool_ref: { name: "read-file" },
        input: { path: "x" }, success_criteria: ["done"],
        failure_policy: "abort", timeout_ms: 5000, max_retries: 0,
        depends_on: ["a"],
      },
    ]);
    const results = runCritics(plan, makeContext());
    const errors = results.filter(r => !r.passed);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts custom critics list", () => {
    const customCritic = () => ({
      passed: false, name: "custom", message: "custom error", severity: "error" as const,
    });
    const plan = makePlan([]);
    const results = runCritics(plan, makeContext(), [customCritic]);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("custom");
  });
});
