import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import type { Plan, StepResult, MemoryLesson } from "@jarvis/schemas";
import { ActiveMemory, extractLesson } from "./memory.js";

const TEST_DIR = resolve(import.meta.dirname ?? ".", "../../.test-memory-data");
const TEST_FILE = resolve(TEST_DIR, "memory.jsonl");

describe("ActiveMemory", () => {
  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  function makeLesson(overrides: Partial<MemoryLesson> = {}): MemoryLesson {
    return {
      lesson_id: uuid(),
      task_summary: "Read a file",
      outcome: "succeeded",
      lesson: "Completed using read-file. 1 step(s) succeeded.",
      tool_names: ["read-file"],
      created_at: new Date().toISOString(),
      session_id: uuid(),
      relevance_count: 0,
      ...overrides,
    };
  }

  it("loads from empty file (no file exists)", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();
    expect(mem.getLessons()).toHaveLength(0);
  });

  it("saves and loads lessons", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();
    mem.addLesson(makeLesson({ task_summary: "Task A" }));
    mem.addLesson(makeLesson({ task_summary: "Task B" }));
    await mem.save();

    // Load from file
    const mem2 = new ActiveMemory(TEST_FILE);
    await mem2.load();
    expect(mem2.getLessons()).toHaveLength(2);
    expect(mem2.getLessons()[0]!.task_summary).toBe("Task A");
  });

  it("searches by task text keywords", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();
    mem.addLesson(makeLesson({ task_summary: "Read the configuration file" }));
    mem.addLesson(makeLesson({ task_summary: "Fetch API data from endpoint" }));
    mem.addLesson(makeLesson({ task_summary: "Write a new config file" }));

    const results = mem.search("configuration file");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.task_summary).toContain("configuration");
  });

  it("search boosts tool name matches", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();
    mem.addLesson(makeLesson({
      task_summary: "Some task about files",
      tool_names: ["http-request"],
    }));
    mem.addLesson(makeLesson({
      task_summary: "Another task about files",
      tool_names: ["read-file"],
    }));

    const results = mem.search("task about files", ["read-file"]);
    expect(results.length).toBe(2);
    // read-file should be boosted to first
    expect(results[0]!.tool_names).toContain("read-file");
  });

  it("increments relevance_count on retrieval", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();
    const lesson = makeLesson({ task_summary: "Read the important file" });
    mem.addLesson(lesson);
    expect(lesson.relevance_count).toBe(0);

    mem.search("important file");
    expect(lesson.relevance_count).toBe(1);

    mem.search("important file");
    expect(lesson.relevance_count).toBe(2);
  });

  it("evicts least-relevant lessons when over MAX_LESSONS (100)", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();

    // Add 100 lessons
    for (let i = 0; i < 100; i++) {
      mem.addLesson(makeLesson({ task_summary: `Task ${i}`, relevance_count: i }));
    }
    expect(mem.getLessons()).toHaveLength(100);

    // Add one more — should evict the least relevant (relevance_count=0)
    mem.addLesson(makeLesson({ task_summary: "Task 100", relevance_count: 50 }));
    expect(mem.getLessons()).toHaveLength(100);

    // The lesson with relevance_count=0 should be evicted
    const summaries = mem.getLessons().map(l => l.task_summary);
    expect(summaries).not.toContain("Task 0");
    expect(summaries).toContain("Task 100");
  });

  it("returns max 5 search results", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();
    for (let i = 0; i < 20; i++) {
      mem.addLesson(makeLesson({ task_summary: `Read important file number ${i}` }));
    }
    const results = mem.search("Read important file");
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("prunes old unretrieved lessons on load", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();

    // Add a lesson with old date and no retrievals
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    mem.addLesson(makeLesson({
      task_summary: "Old unretrieved",
      created_at: oldDate.toISOString(),
      relevance_count: 0,
    }));

    // Add a recent lesson
    mem.addLesson(makeLesson({ task_summary: "Recent task" }));
    await mem.save();

    // Reload — should prune old lesson
    const mem2 = new ActiveMemory(TEST_FILE);
    await mem2.load();
    expect(mem2.getLessons()).toHaveLength(1);
    expect(mem2.getLessons()[0]!.task_summary).toBe("Recent task");
  });

  it("keeps old lessons that have been retrieved", async () => {
    const mem = new ActiveMemory(TEST_FILE);
    await mem.load();

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    mem.addLesson(makeLesson({
      task_summary: "Old but retrieved",
      created_at: oldDate.toISOString(),
      relevance_count: 5,
    }));
    await mem.save();

    const mem2 = new ActiveMemory(TEST_FILE);
    await mem2.load();
    expect(mem2.getLessons()).toHaveLength(1);
  });
});

describe("extractLesson", () => {
  const makePlan = (toolNames: string[]): Plan => ({
    plan_id: uuid(),
    schema_version: "0.1",
    goal: "Test goal",
    assumptions: [],
    steps: toolNames.map((name, i) => ({
      step_id: `step-${i}`,
      title: `Step ${i}`,
      tool_ref: { name },
      input: {},
      success_criteria: ["done"],
      failure_policy: "abort" as const,
      timeout_ms: 5000,
      max_retries: 0,
    })),
    created_at: new Date().toISOString(),
  });

  it("extracts succeeded lesson from completed session", () => {
    const plan = makePlan(["read-file"]);
    const stepResults: StepResult[] = [{
      step_id: "step-0", status: "succeeded",
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson("Read my file", plan, stepResults, "completed");
    expect(lesson).not.toBeNull();
    expect(lesson!.outcome).toBe("succeeded");
    expect(lesson!.tool_names).toEqual(["read-file"]);
    expect(lesson!.lesson).toContain("read-file");
    expect(lesson!.task_summary).toBe("Read my file");
  });

  it("extracts failed lesson with error messages", () => {
    const plan = makePlan(["write-file"]);
    const stepResults: StepResult[] = [{
      step_id: "step-0", status: "failed",
      error: { code: "PERMISSION_DENIED", message: "Access denied" },
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson("Write to protected file", plan, stepResults, "failed");
    expect(lesson).not.toBeNull();
    expect(lesson!.outcome).toBe("failed");
    expect(lesson!.lesson).toContain("Access denied");
  });

  it("returns null for empty plan", () => {
    const plan = makePlan([]);
    const lesson = extractLesson("Empty plan", plan, [], "completed");
    expect(lesson).toBeNull();
  });

  it("deduplicates tool names", () => {
    const plan = makePlan(["read-file", "read-file"]);
    const stepResults: StepResult[] = [
      { step_id: "step-0", status: "succeeded", started_at: new Date().toISOString(), attempts: 1 },
      { step_id: "step-1", status: "succeeded", started_at: new Date().toISOString(), attempts: 1 },
    ];

    const lesson = extractLesson("Read two files", plan, stepResults, "completed");
    expect(lesson!.tool_names).toEqual(["read-file"]);
  });

  it("truncates long task text to 200 chars", () => {
    const longText = "x".repeat(500);
    const plan = makePlan(["read-file"]);
    const stepResults: StepResult[] = [{
      step_id: "step-0", status: "succeeded",
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson(longText, plan, stepResults, "completed");
    expect(lesson!.task_summary.length).toBe(200);
  });

  it("returns null for running session status", () => {
    const plan = makePlan(["read-file"]);
    expect(extractLesson("task", plan, [], "running")).toBeNull();
  });

  it("returns null for created session status", () => {
    const plan = makePlan(["read-file"]);
    expect(extractLesson("task", plan, [], "created")).toBeNull();
  });

  it("returns null for planning session status", () => {
    const plan = makePlan(["read-file"]);
    expect(extractLesson("task", plan, [], "planning")).toBeNull();
  });

  it("redacts Bearer tokens from task summary", () => {
    const plan = makePlan(["http-request"]);
    const results: StepResult[] = [{
      step_id: "step-0", status: "succeeded",
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson(
      "Fetch data with Bearer abc123secret from API",
      plan, results, "completed"
    );
    expect(lesson!.task_summary).toContain("[REDACTED]");
    expect(lesson!.task_summary).not.toContain("abc123secret");
  });

  it("redacts GitHub personal access tokens", () => {
    const plan = makePlan(["http-request"]);
    const results: StepResult[] = [{
      step_id: "step-0", status: "succeeded",
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson(
      "Clone repo with ghp_1234567890abcdef token",
      plan, results, "completed"
    );
    expect(lesson!.task_summary).toContain("[REDACTED]");
    expect(lesson!.task_summary).not.toContain("ghp_");
  });

  it("redacts OpenAI/Anthropic sk- keys", () => {
    const plan = makePlan(["http-request"]);
    const results: StepResult[] = [{
      step_id: "step-0", status: "succeeded",
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson(
      "Call API with sk-proj-abcdefghijklmnop key",
      plan, results, "completed"
    );
    expect(lesson!.task_summary).toContain("[REDACTED]");
    expect(lesson!.task_summary).not.toContain("sk-proj");
  });

  it("redacts AWS access key IDs", () => {
    const plan = makePlan(["http-request"]);
    const results: StepResult[] = [{
      step_id: "step-0", status: "succeeded",
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson(
      "Upload to S3 with AKIAIOSFODNN7EXAMPLE credentials",
      plan, results, "completed"
    );
    expect(lesson!.task_summary).toContain("[REDACTED]");
    expect(lesson!.task_summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("failed lesson with no error messages uses fallback", () => {
    const plan = makePlan(["write-file"]);
    const results: StepResult[] = [{
      step_id: "step-0", status: "failed",
      started_at: new Date().toISOString(), attempts: 1,
      // No error property
    }];

    const lesson = extractLesson("Write task", plan, results, "failed");
    expect(lesson!.outcome).toBe("failed");
    expect(lesson!.lesson).toContain("1 failed step(s)");
    expect(lesson!.lesson).toContain("write-file");
  });

  it("uses sessionId when provided", () => {
    const plan = makePlan(["read-file"]);
    const results: StepResult[] = [{
      step_id: "step-0", status: "succeeded",
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson("task", plan, results, "completed", "custom-session-id");
    expect(lesson!.session_id).toBe("custom-session-id");
  });

  it("falls back to plan_id when sessionId not provided", () => {
    const plan = makePlan(["read-file"]);
    const results: StepResult[] = [{
      step_id: "step-0", status: "succeeded",
      started_at: new Date().toISOString(), attempts: 1,
    }];

    const lesson = extractLesson("task", plan, results, "completed");
    expect(lesson!.session_id).toBe(plan.plan_id);
  });
});
