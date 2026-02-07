import { describe, it, expect } from "vitest";
import { v4 as uuid } from "uuid";
import {
  validatePlanData,
  validateToolManifestData,
  validateJournalEventData,
  validateToolInput,
  validateToolOutput,
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
