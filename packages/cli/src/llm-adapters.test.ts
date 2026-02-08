import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPlanner } from "./llm-adapters.js";
import { MockPlanner, LLMPlanner } from "@openvger/planner";

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
