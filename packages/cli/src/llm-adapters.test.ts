import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPlanner } from "./llm-adapters.js";
import { MockPlanner, LLMPlanner } from "@karnevil9/planner";

/* ------------------------------------------------------------------ *
 *  SDK mocks — intercept dynamic import("@anthropic-ai/sdk") and     *
 *  import("openai") used by the adapter closures.                     *
 * ------------------------------------------------------------------ */

const { mockClaudeCreate, mockOpenAICreate } = vi.hoisted(() => ({
  mockClaudeCreate: vi.fn(),
  mockOpenAICreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: mockClaudeCreate };
    constructor(_opts: unknown) {}
  },
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    chat = { completions: { create: mockOpenAICreate } };
    constructor(_opts: unknown) {}
  },
}));

/* ------------------------------------------------------------------ *
 *  Shared fixtures                                                    *
 * ------------------------------------------------------------------ */

const VALID_PLAN = {
  plan_id: "test-plan-id",
  schema_version: "0.1",
  goal: "Test goal",
  assumptions: ["test"],
  steps: [{
    step_id: "step-1",
    title: "Read file",
    tool_ref: { name: "read-file" },
    input: { path: "test.txt" },
    success_criteria: ["File read"],
    failure_policy: "abort",
    timeout_ms: 30000,
    max_retries: 0,
  }],
  created_at: new Date().toISOString(),
};

const TOOL_SCHEMAS = [{
  name: "read-file",
  description: "Read a file",
  input_schema: { type: "object" as const, required: ["path"], properties: { path: { type: "string" } } },
}];

const TEST_TASK = { task_id: "t1", text: "Test task", created_at: new Date().toISOString() };

/* ------------------------------------------------------------------ *
 *  Original createPlanner factory tests                               *
 * ------------------------------------------------------------------ */

describe("createPlanner", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.OPENVGER_PLANNER = process.env.OPENVGER_PLANNER;
    savedEnv.OPENVGER_MODEL = process.env.OPENVGER_MODEL;
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;

    delete process.env.OPENVGER_PLANNER;
    delete process.env.OPENVGER_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("defaults to MockPlanner with no config", () => {
    const planner = createPlanner({});
    expect(planner).toBeInstanceOf(MockPlanner);
  });

  it("returns MockPlanner when --planner is 'mock'", () => {
    const planner = createPlanner({ planner: "mock" });
    expect(planner).toBeInstanceOf(MockPlanner);
  });

  it("--planner flag overrides OPENVGER_PLANNER env", () => {
    process.env.OPENVGER_PLANNER = "claude";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    // Flag says mock, env says claude — flag wins
    const planner = createPlanner({ planner: "mock" });
    expect(planner).toBeInstanceOf(MockPlanner);
  });

  it("falls back to OPENVGER_PLANNER env when no flag", () => {
    process.env.OPENVGER_PLANNER = "mock";
    const planner = createPlanner({});
    expect(planner).toBeInstanceOf(MockPlanner);
  });

  it("throws with clear message when ANTHROPIC_API_KEY is missing for claude", () => {
    expect(() => createPlanner({ planner: "claude" })).toThrow("ANTHROPIC_API_KEY");
  });

  it("returns LLMPlanner for valid claude config", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const planner = createPlanner({ planner: "claude" });
    expect(planner).toBeInstanceOf(LLMPlanner);
  });

  it("returns LLMPlanner for claude with custom model", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const planner = createPlanner({ planner: "claude", model: "claude-opus-4-20250514" });
    expect(planner).toBeInstanceOf(LLMPlanner);
  });

  it("throws with clear message when OPENAI_API_KEY is missing for openai", () => {
    expect(() => createPlanner({ planner: "openai" })).toThrow("OPENAI_API_KEY");
  });

  it("allows openai without key when OPENAI_BASE_URL is set", () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    const planner = createPlanner({ planner: "openai" });
    expect(planner).toBeInstanceOf(LLMPlanner);
  });

  it("returns LLMPlanner for valid openai config", () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const planner = createPlanner({ planner: "openai" });
    expect(planner).toBeInstanceOf(LLMPlanner);
  });

  it("throws on unknown planner type", () => {
    expect(() => createPlanner({ planner: "gemini" })).toThrow('Unknown planner type: "gemini"');
  });

  it("includes valid options in unknown planner error", () => {
    expect(() => createPlanner({ planner: "llama" })).toThrow("mock, claude, openai");
  });
});

/* ------------------------------------------------------------------ *
 *  Claude adapter — verify API call parameters                        *
 * ------------------------------------------------------------------ */

describe("Claude adapter parameters", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    savedEnv.KARNEVIL9_PLANNER = process.env.KARNEVIL9_PLANNER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.KARNEVIL9_PLANNER;
    mockClaudeCreate.mockReset();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("passes tools and tool_choice to messages.create", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const planner = createPlanner({ planner: "claude" });

    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "tu_1", name: "submit_plan", input: VALID_PLAN }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    await planner.generatePlan(TEST_TASK, TOOL_SCHEMAS, {}, {});

    expect(mockClaudeCreate).toHaveBeenCalledOnce();
    const args = mockClaudeCreate.mock.calls[0]![0];
    expect(args.tools).toEqual([{
      name: "submit_plan",
      description: "Submit the execution plan as structured JSON",
      input_schema: { type: "object" },
    }]);
    expect(args.tool_choice).toEqual({ type: "tool", name: "submit_plan" });
  });

  it("returns parsed tool_use input as plan", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const planner = createPlanner({ planner: "claude" });

    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "tu_1", name: "submit_plan", input: VALID_PLAN }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await planner.generatePlan(TEST_TASK, TOOL_SCHEMAS, {}, {});
    expect(result.plan.plan_id).toBe(VALID_PLAN.plan_id);
    expect(result.plan.goal).toBe(VALID_PLAN.goal);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      model: "claude-sonnet-4-6",
    });
  });

  it("throws when response has no tool_use block", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const planner = createPlanner({ planner: "claude" });

    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "text", text: "I cannot create a plan" }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    await expect(planner.generatePlan(TEST_TASK, TOOL_SCHEMAS, {}, {}))
      .rejects.toThrow("Claude returned no tool call");
  });
});

/* ------------------------------------------------------------------ *
 *  OpenAI adapter — verify API call parameters                        *
 * ------------------------------------------------------------------ */

describe("OpenAI adapter parameters", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    savedEnv.KARNEVIL9_PLANNER = process.env.KARNEVIL9_PLANNER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.KARNEVIL9_PLANNER;
    mockOpenAICreate.mockReset();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("passes response_format json_object to chat.completions.create", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const planner = createPlanner({ planner: "openai" });

    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    await planner.generatePlan(TEST_TASK, TOOL_SCHEMAS, {}, {});

    expect(mockOpenAICreate).toHaveBeenCalledOnce();
    const args = mockOpenAICreate.mock.calls[0]![0];
    expect(args.response_format).toEqual({ type: "json_object" });
  });
});
