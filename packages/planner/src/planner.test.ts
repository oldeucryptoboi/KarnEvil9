import { describe, it, expect } from "vitest";
import { v4 as uuid } from "uuid";
import type { Task, ToolSchemaForPlanner } from "@openflaw/schemas";
import { MockPlanner, LLMPlanner } from "./planner.js";

const makeTask = (text = "Test task"): Task => ({
  task_id: uuid(),
  text,
  created_at: new Date().toISOString(),
});

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
    output_schema: {
      type: "object",
      required: ["content"],
      properties: { content: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "write-file",
    version: "1.0.0",
    description: "Write a file",
    input_schema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      required: ["bytes_written"],
      properties: { bytes_written: { type: "integer" } },
      additionalProperties: false,
    },
  },
];

describe("MockPlanner", () => {
  it("generates a plan from available tools", async () => {
    const planner = new MockPlanner();
    const plan = await planner.generatePlan(makeTask(), toolSchemas, {}, {});
    expect(plan.plan_id).toBeTruthy();
    expect(plan.schema_version).toBe("0.1");
    expect(plan.goal).toBe("Test task");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.tool_ref.name).toBe("read-file");
  });

  it("generates mock input matching required properties", async () => {
    const planner = new MockPlanner();
    const plan = await planner.generatePlan(makeTask(), toolSchemas, {}, {});
    const input = plan.steps[0]!.input;
    expect(input).toHaveProperty("path");
    expect(typeof input.path).toBe("string");
  });

  it("throws when no tools available", async () => {
    const planner = new MockPlanner();
    await expect(planner.generatePlan(makeTask(), [], {}, {})).rejects.toThrow("No tools available");
  });

  it("generates input for various property types", async () => {
    const schemas: ToolSchemaForPlanner[] = [{
      name: "multi-type",
      version: "1.0.0",
      description: "Multi-type tool",
      input_schema: {
        type: "object",
        required: ["str", "num", "int", "bool", "arr", "obj"],
        properties: {
          str: { type: "string" },
          num: { type: "number" },
          int: { type: "integer" },
          bool: { type: "boolean" },
          arr: { type: "array" },
          obj: { type: "object" },
        },
      },
      output_schema: { type: "object" },
    }];
    const planner = new MockPlanner();
    const plan = await planner.generatePlan(makeTask(), schemas, {}, {});
    const input = plan.steps[0]!.input;
    expect(typeof input.str).toBe("string");
    expect(typeof input.num).toBe("number");
    expect(typeof input.int).toBe("number");
    expect(typeof input.bool).toBe("boolean");
    expect(Array.isArray(input.arr)).toBe(true);
    expect(typeof input.obj).toBe("object");
  });

  it("uses enum value for string properties with enum", async () => {
    const schemas: ToolSchemaForPlanner[] = [{
      name: "enum-tool",
      version: "1.0.0",
      description: "Enum tool",
      input_schema: {
        type: "object",
        required: ["method"],
        properties: {
          method: { type: "string", enum: ["GET", "POST"] },
        },
      },
      output_schema: { type: "object" },
    }];
    const planner = new MockPlanner();
    const plan = await planner.generatePlan(makeTask(), schemas, {}, {});
    expect(plan.steps[0]!.input.method).toBe("GET");
  });
});

describe("LLMPlanner", () => {
  it("parses valid JSON response from model", async () => {
    const mockPlan = {
      plan_id: uuid(),
      schema_version: "0.1",
      goal: "Read a file",
      assumptions: ["File exists"],
      steps: [{
        step_id: uuid(),
        title: "Read file",
        tool_ref: { name: "read-file" },
        input: { path: "/tmp/test.txt" },
        success_criteria: ["File read successfully"],
        failure_policy: "abort",
        timeout_ms: 5000,
        max_retries: 0,
      }],
      created_at: new Date().toISOString(),
    };

    const callModel = async () => JSON.stringify(mockPlan);
    const planner = new LLMPlanner(callModel);
    const plan = await planner.generatePlan(makeTask(), toolSchemas, {}, {});
    expect(plan.plan_id).toBe(mockPlan.plan_id);
    expect(plan.steps).toHaveLength(1);
  });

  it("strips markdown code fences from response", async () => {
    const mockPlan = {
      plan_id: uuid(),
      schema_version: "0.1",
      goal: "Test",
      assumptions: [],
      steps: [{
        step_id: uuid(),
        title: "Step",
        tool_ref: { name: "read-file" },
        input: { path: "x" },
        success_criteria: ["done"],
        failure_policy: "abort",
        timeout_ms: 5000,
        max_retries: 0,
      }],
      created_at: new Date().toISOString(),
    };

    const callModel = async () => "```json\n" + JSON.stringify(mockPlan) + "\n```";
    const planner = new LLMPlanner(callModel);
    const plan = await planner.generatePlan(makeTask(), toolSchemas, {}, {});
    expect(plan.plan_id).toBe(mockPlan.plan_id);
  });

  it("throws on invalid JSON response", async () => {
    const callModel = async () => "This is not JSON at all";
    const planner = new LLMPlanner(callModel);
    await expect(planner.generatePlan(makeTask(), toolSchemas, {}, {})).rejects.toThrow("invalid JSON");
  });

  it("adds created_at if missing from response", async () => {
    const mockPlan = {
      plan_id: uuid(),
      schema_version: "0.1",
      goal: "Test",
      assumptions: [],
      steps: [{
        step_id: uuid(),
        title: "Step",
        tool_ref: { name: "read-file" },
        input: { path: "x" },
        success_criteria: ["done"],
        failure_policy: "abort",
        timeout_ms: 5000,
        max_retries: 0,
      }],
      // no created_at
    };

    const callModel = async () => JSON.stringify(mockPlan);
    const planner = new LLMPlanner(callModel);
    const plan = await planner.generatePlan(makeTask(), toolSchemas, {}, {});
    expect(plan.created_at).toBeTruthy();
  });
});
