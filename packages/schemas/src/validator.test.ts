import { describe, it, expect } from "vitest";
import { v4 as uuid } from "uuid";
import {
  validatePlanData,
  validateToolManifestData,
  validateJournalEventData,
  validatePluginManifestData,
  validateToolInput,
  validateToolOutput,
  clearSchemaCache,
} from "./validator.js";

describe("validatePlanData", () => {
  const validPlan = () => ({
    plan_id: uuid(),
    schema_version: "0.1",
    goal: "Test goal",
    assumptions: ["assumption 1"],
    steps: [
      {
        step_id: uuid(),
        title: "Step one",
        tool_ref: { name: "my-tool" },
        input: { key: "value" },
        success_criteria: ["it works"],
        failure_policy: "abort",
        timeout_ms: 5000,
        max_retries: 0,
      },
    ],
    created_at: new Date().toISOString(),
  });

  it("accepts a valid plan", () => {
    const result = validatePlanData(validPlan());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects plan missing required fields", () => {
    const result = validatePlanData({ plan_id: "x" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects plan with invalid schema_version", () => {
    const plan = validPlan();
    (plan as any).schema_version = "2.0";
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("rejects plan with empty steps array", () => {
    const plan = validPlan();
    plan.steps = [];
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("rejects plan with invalid failure_policy", () => {
    const plan = validPlan();
    (plan.steps[0] as any).failure_policy = "ignore";
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("rejects step with timeout_ms below minimum", () => {
    const plan = validPlan();
    plan.steps[0]!.timeout_ms = 10;
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("accepts plan with artifacts", () => {
    const plan = { ...validPlan(), artifacts: [{ name: "output.txt", type: "file" }] };
    const result = validatePlanData(plan);
    expect(result.valid).toBe(true);
  });

  it("rejects plan with additional properties", () => {
    const plan = { ...validPlan(), extra_field: true };
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("rejects step with max_retries above maximum (10)", () => {
    const plan = validPlan();
    plan.steps[0]!.max_retries = 11;
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("rejects step with max_retries as float", () => {
    const plan = validPlan();
    (plan.steps[0] as any).max_retries = 2.5;
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("rejects step with empty success_criteria", () => {
    const plan = validPlan();
    (plan.steps[0] as any).success_criteria = [];
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("rejects step with empty tool_ref.name", () => {
    const plan = validPlan();
    plan.steps[0]!.tool_ref.name = "";
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("accepts step with timeout_ms at exact minimum (100)", () => {
    const plan = validPlan();
    plan.steps[0]!.timeout_ms = 100;
    const result = validatePlanData(plan);
    expect(result.valid).toBe(true);
  });

  it("rejects step with negative max_retries", () => {
    const plan = validPlan();
    (plan.steps[0] as any).max_retries = -1;
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("accepts plan with depends_on array", () => {
    const plan = validPlan();
    const step2 = {
      step_id: uuid(),
      title: "Step two",
      tool_ref: { name: "other-tool" },
      input: { key: "value" },
      success_criteria: ["it works"],
      failure_policy: "abort" as const,
      timeout_ms: 5000,
      max_retries: 0,
      depends_on: [plan.steps[0]!.step_id],
    };
    plan.steps.push(step2);
    const result = validatePlanData(plan);
    expect(result.valid).toBe(true);
  });

  it("rejects step with empty step_id", () => {
    const plan = validPlan();
    plan.steps[0]!.step_id = "";
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });

  it("rejects plan with empty goal", () => {
    const plan = validPlan();
    plan.steps[0]!.title = "ok"; // keep step valid
    (plan as any).goal = "";
    const result = validatePlanData(plan);
    expect(result.valid).toBe(false);
  });
});

describe("validateToolManifestData", () => {
  const validManifest = () => ({
    name: "test-tool",
    version: "1.0.0",
    description: "A test tool",
    runner: "internal",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    permissions: ["filesystem:read:workspace"],
    timeout_ms: 5000,
    supports: { mock: true, dry_run: false },
  });

  it("accepts a valid manifest", () => {
    const result = validateToolManifestData(validManifest());
    expect(result.valid).toBe(true);
  });

  it("rejects manifest with invalid name pattern", () => {
    const m = validManifest();
    m.name = "Bad Name!";
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("rejects manifest with invalid runner", () => {
    const m = validManifest();
    (m as any).runner = "wasm";
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("rejects manifest with invalid permission format", () => {
    const m = validManifest();
    m.permissions = ["bad"];
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("rejects manifest with timeout_ms above maximum", () => {
    const m = validManifest();
    m.timeout_ms = 999999;
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("accepts manifest with mock_responses", () => {
    const m = { ...validManifest(), mock_responses: [{ data: "test" }] };
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(true);
  });

  it("rejects manifest missing required fields", () => {
    const result = validateToolManifestData({ name: "x" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts manifest with timeout_ms at exact minimum (100)", () => {
    const m = validManifest();
    m.timeout_ms = 100;
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(true);
  });

  it("rejects manifest with timeout_ms below minimum", () => {
    const m = validManifest();
    m.timeout_ms = 99;
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("accepts manifest with timeout_ms at exact maximum (600000)", () => {
    const m = validManifest();
    m.timeout_ms = 600000;
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(true);
  });

  it("accepts manifest with name at maxLength (64 chars)", () => {
    const m = validManifest();
    m.name = "a".repeat(64);
    const result = validateToolManifestData(m);
    expect(result.valid).toBe(true);
  });
});

describe("validateJournalEventData", () => {
  const validEvent = () => ({
    event_id: uuid(),
    timestamp: new Date().toISOString(),
    session_id: uuid(),
    type: "session.created",
    payload: {},
  });

  it("accepts a valid event", () => {
    const result = validateJournalEventData(validEvent());
    expect(result.valid).toBe(true);
  });

  it("rejects event with invalid type", () => {
    const e = validEvent();
    (e as any).type = "invalid.event";
    const result = validateJournalEventData(e);
    expect(result.valid).toBe(false);
  });

  it("rejects event with invalid timestamp format", () => {
    const e = validEvent();
    e.timestamp = "not-a-date";
    const result = validateJournalEventData(e);
    expect(result.valid).toBe(false);
  });

  it("accepts event with hash_prev", () => {
    const e = { ...validEvent(), hash_prev: "abc123" };
    const result = validateJournalEventData(e);
    expect(result.valid).toBe(true);
  });

  it("rejects event missing required fields", () => {
    const result = validateJournalEventData({});
    expect(result.valid).toBe(false);
  });

  it("accepts policy.violated event type", () => {
    const result = validateJournalEventData({ ...validEvent(), type: "policy.violated" });
    expect(result.valid).toBe(true);
  });

  it("accepts session.checkpoint event type", () => {
    const result = validateJournalEventData({ ...validEvent(), type: "session.checkpoint" });
    expect(result.valid).toBe(true);
  });

  it("accepts limit.exceeded event type", () => {
    const result = validateJournalEventData({ ...validEvent(), type: "limit.exceeded" });
    expect(result.valid).toBe(true);
  });

  it("accepts event with valid seq field", () => {
    const result = validateJournalEventData({ ...validEvent(), seq: 0 });
    expect(result.valid).toBe(true);
  });

  it("rejects event with negative seq", () => {
    const result = validateJournalEventData({ ...validEvent(), seq: -1 });
    expect(result.valid).toBe(false);
  });

  it("accepts swarm event types", () => {
    for (const type of ["swarm.peer_joined", "swarm.task_delegated", "swarm.peer_left"]) {
      const result = validateJournalEventData({ ...validEvent(), type });
      expect(result.valid).toBe(true);
    }
  });

  it("accepts scheduler event types", () => {
    for (const type of ["scheduler.job_triggered", "scheduler.job_skipped", "scheduler.schedule_created"]) {
      const result = validateJournalEventData({ ...validEvent(), type });
      expect(result.valid).toBe(true);
    }
  });
});

describe("KarnEvil9Error", () => {
  it("has correct code, message, and data", async () => {
    const { KarnEvil9Error, ErrorCodes } = await import("./types.js");
    const err = new KarnEvil9Error("POLICY_VIOLATION", "test message", { detail: 42 });
    expect(err.code).toBe(ErrorCodes.POLICY_VIOLATION);
    expect(err.message).toBe("test message");
    expect(err.data).toEqual({ detail: 42 });
    expect(err.name).toBe("KarnEvil9Error");
    expect(err instanceof Error).toBe(true);
  });

  it("works without data parameter", async () => {
    const { KarnEvil9Error } = await import("./types.js");
    const err = new KarnEvil9Error("TIMEOUT", "timed out");
    expect(err.code).toBe("TIMEOUT");
    expect(err.data).toBeUndefined();
  });
});

describe("validateToolInput", () => {
  const schema = {
    type: "object",
    required: ["url", "method"],
    properties: {
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "POST"] },
    },
    additionalProperties: false,
  };

  it("accepts valid input", () => {
    const result = validateToolInput({ url: "https://example.com", method: "GET" }, schema);
    expect(result.valid).toBe(true);
  });

  it("rejects input missing required fields", () => {
    const result = validateToolInput({ url: "https://example.com" }, schema);
    expect(result.valid).toBe(false);
  });

  it("rejects input with invalid enum value", () => {
    const result = validateToolInput({ url: "https://example.com", method: "DELETE" }, schema);
    expect(result.valid).toBe(false);
  });

  it("rejects input with additional properties", () => {
    const result = validateToolInput({ url: "https://example.com", method: "GET", extra: true }, schema);
    expect(result.valid).toBe(false);
  });
});

describe("validateToolOutput", () => {
  const schema = {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "integer" },
      body: { type: "string" },
    },
    additionalProperties: false,
  };

  it("accepts valid output", () => {
    const result = validateToolOutput({ status: 200, body: "ok" }, schema);
    expect(result.valid).toBe(true);
  });

  it("rejects output with wrong type", () => {
    const result = validateToolOutput({ status: "200" }, schema);
    expect(result.valid).toBe(false);
  });

  it("accepts output with only required fields", () => {
    const result = validateToolOutput({ status: 200 }, schema);
    expect(result.valid).toBe(true);
  });
});

describe("validatePluginManifestData", () => {
  const validManifest = () => ({
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    description: "A test plugin",
    entry: "index.js",
    permissions: [],
    provides: {
      hooks: ["before_step"],
    },
  });

  it("accepts a valid plugin manifest", () => {
    const result = validatePluginManifestData(validManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects manifest missing required fields", () => {
    const result = validatePluginManifestData({ id: "x" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects invalid id pattern", () => {
    const m = validManifest();
    m.id = "UPPERCASE_NOT_ALLOWED!";
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("rejects invalid hook name", () => {
    const m = validManifest();
    (m.provides.hooks as string[]) = ["nonexistent_hook"];
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("accepts manifest with all provides types", () => {
    const m = {
      ...validManifest(),
      provides: {
        tools: ["my-tool"],
        hooks: ["before_step", "after_step"],
        routes: ["status"],
        commands: ["my-cmd"],
        planners: ["custom"],
        services: ["bg"],
      },
    };
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(true);
  });

  it("rejects manifest with additional properties", () => {
    const m = { ...validManifest(), extra_field: true };
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("accepts plugin id at maxLength (64 chars)", () => {
    const m = validManifest();
    m.id = "a".repeat(64);
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(true);
  });

  it("rejects plugin id exceeding maxLength", () => {
    const m = validManifest();
    m.id = "a".repeat(65);
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("accepts plugin id with hyphens and underscores", () => {
    const m = validManifest();
    m.id = "my-cool_plugin-2";
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(true);
  });

  it("rejects plugin id with uppercase letters", () => {
    const m = validManifest();
    m.id = "MyPlugin";
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(false);
  });

  it("accepts manifest with empty provides object", () => {
    const m = { ...validManifest(), provides: {} };
    const result = validatePluginManifestData(m);
    expect(result.valid).toBe(true);
  });
});

describe("validateJournalEventData (plugin events)", () => {
  const validEvent = () => ({
    event_id: uuid(),
    timestamp: new Date().toISOString(),
    session_id: uuid(),
    type: "plugin.loaded",
    payload: {},
  });

  it("accepts plugin.loaded event", () => {
    const result = validateJournalEventData(validEvent());
    expect(result.valid).toBe(true);
  });

  it("accepts plugin.discovered event", () => {
    const result = validateJournalEventData({ ...validEvent(), type: "plugin.discovered" });
    expect(result.valid).toBe(true);
  });

  it("accepts plugin.hook_fired event", () => {
    const result = validateJournalEventData({ ...validEvent(), type: "plugin.hook_fired" });
    expect(result.valid).toBe(true);
  });

  it("accepts plugin.hook_circuit_open event", () => {
    const result = validateJournalEventData({ ...validEvent(), type: "plugin.hook_circuit_open" });
    expect(result.valid).toBe(true);
  });

  it("accepts plugin.service_started event", () => {
    const result = validateJournalEventData({ ...validEvent(), type: "plugin.service_started" });
    expect(result.valid).toBe(true);
  });

  it("accepts plugin.failed event", () => {
    const result = validateJournalEventData({ ...validEvent(), type: "plugin.failed" });
    expect(result.valid).toBe(true);
  });
});

describe("schema compilation guards", () => {
  it("rejects schemas exceeding max serialized size", () => {
    clearSchemaCache();
    // Create a schema with a very long enum array to exceed 100KB
    const hugeEnum = Array.from({ length: 20000 }, (_, i) => `value_${i}_${"x".repeat(5)}`);
    const hugeSchema = {
      type: "object",
      properties: { field: { type: "string", enum: hugeEnum } },
    };
    expect(() => validateToolInput({ field: "test" }, hugeSchema)).toThrow("Schema too large");
  });

  it("rejects deeply nested schemas", () => {
    clearSchemaCache();
    // Build a 25-level deep nested schema
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 25; i++) {
      schema = { type: "object", properties: { nested: schema } };
    }
    expect(() => validateToolInput({ nested: {} }, schema)).toThrow("Schema too deeply nested");
  });

  it("accepts schemas within size and depth limits", () => {
    clearSchemaCache();
    // A normal-sized schema with moderate nesting
    const schema = {
      type: "object",
      properties: {
        a: { type: "object", properties: { b: { type: "string" } } },
      },
    };
    const result = validateToolInput({ a: { b: "hello" } }, schema);
    expect(result.valid).toBe(true);
  });
});

describe("schema compilation cache", () => {
  const inputSchema = {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
    },
    additionalProperties: false,
  };

  const outputSchema = {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "integer" },
    },
    additionalProperties: false,
  };

  it("validateToolInput caches compiled validators", () => {
    clearSchemaCache();
    const result1 = validateToolInput({ name: "test" }, inputSchema);
    expect(result1.valid).toBe(true);

    const result2 = validateToolInput({ name: "other", count: 5 }, inputSchema);
    expect(result2.valid).toBe(true);

    const result3 = validateToolInput({ bad: true }, inputSchema);
    expect(result3.valid).toBe(false);
  });

  it("validateToolOutput caches compiled validators", () => {
    clearSchemaCache();
    const result1 = validateToolOutput({ status: 200 }, outputSchema);
    expect(result1.valid).toBe(true);

    const result2 = validateToolOutput({ status: 404 }, outputSchema);
    expect(result2.valid).toBe(true);

    const result3 = validateToolOutput({ status: "bad" }, outputSchema);
    expect(result3.valid).toBe(false);
  });

  it("clearSchemaCache resets the cache", () => {
    clearSchemaCache();

    // Compile a schema by using it
    const result1 = validateToolInput({ name: "test" }, inputSchema);
    expect(result1.valid).toBe(true);

    // Clear the cache
    clearSchemaCache();

    // Use the same schema again — should recompile and still work
    const result2 = validateToolInput({ name: "after-clear" }, inputSchema);
    expect(result2.valid).toBe(true);

    // Verify invalid input is still correctly rejected
    const result3 = validateToolInput({}, inputSchema);
    expect(result3.valid).toBe(false);
  });
});
