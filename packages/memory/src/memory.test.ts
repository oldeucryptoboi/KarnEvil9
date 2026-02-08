import { describe, it, expect } from "vitest";
import { v4 as uuid } from "uuid";
import { TaskStateManager, WorkingMemoryManager, LongTermMemory } from "./memory.js";
import type { Plan, StepResult } from "@openvger/schemas";

describe("TaskStateManager", () => {
  const makePlan = (): Plan => ({
    plan_id: uuid(),
    schema_version: "0.1",
    goal: "Test goal",
    assumptions: [],
    steps: [
      {
        step_id: "step-1",
        title: "Step 1",
        tool_ref: { name: "test-tool" },
        input: {},
        success_criteria: ["done"],
        failure_policy: "abort",
        timeout_ms: 5000,
        max_retries: 0,
      },
      {
        step_id: "step-2",
        title: "Step 2",
        tool_ref: { name: "test-tool" },
        input: {},
        success_criteria: ["done"],
        failure_policy: "continue",
        timeout_ms: 5000,
        max_retries: 0,
      },
    ],
    created_at: new Date().toISOString(),
  });

  it("starts with no plan", () => {
    const mgr = new TaskStateManager("sess-1");
    expect(mgr.getPlan()).toBeNull();
  });

  it("sets and gets a plan", () => {
    const mgr = new TaskStateManager("sess-1");
    const plan = makePlan();
    mgr.setPlan(plan);
    expect(mgr.getPlan()).toBe(plan);
  });

  it("stores and retrieves step results", () => {
    const mgr = new TaskStateManager("sess-1");
    const result: StepResult = {
      step_id: "step-1",
      status: "succeeded",
      output: { data: "hello" },
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      attempts: 1,
    };
    mgr.setStepResult("step-1", result);
    expect(mgr.getStepResult("step-1")).toBe(result);
    expect(mgr.getStepResult("step-2")).toBeUndefined();
  });

  it("getAllStepResults returns all stored results", () => {
    const mgr = new TaskStateManager("sess-1");
    const r1: StepResult = { step_id: "step-1", status: "succeeded", started_at: new Date().toISOString(), attempts: 1 };
    const r2: StepResult = { step_id: "step-2", status: "failed", started_at: new Date().toISOString(), attempts: 2 };
    mgr.setStepResult("step-1", r1);
    mgr.setStepResult("step-2", r2);
    expect(mgr.getAllStepResults()).toHaveLength(2);
  });

  it("manages artifacts", () => {
    const mgr = new TaskStateManager("sess-1");
    mgr.setArtifact("output.txt", "file contents");
    expect(mgr.getArtifact("output.txt")).toBe("file contents");
    expect(mgr.getArtifact("missing")).toBeUndefined();
  });

  it("produces a snapshot", () => {
    const mgr = new TaskStateManager("sess-1");
    const plan = makePlan();
    mgr.setPlan(plan);
    const r1: StepResult = { step_id: "step-1", status: "succeeded", started_at: new Date().toISOString(), attempts: 1 };
    const r2: StepResult = { step_id: "step-2", status: "failed", started_at: new Date().toISOString(), attempts: 1 };
    mgr.setStepResult("step-1", r1);
    mgr.setStepResult("step-2", r2);
    mgr.setArtifact("result", 42);

    const snap = mgr.getSnapshot();
    expect(snap.session_id).toBe("sess-1");
    expect(snap.has_plan).toBe(true);
    expect(snap.plan_goal).toBe("Test goal");
    expect(snap.total_steps).toBe(2);
    expect(snap.completed_steps).toBe(1);
    expect(snap.failed_steps).toBe(1);
    // step_titles maps step IDs to titles from the plan
    const titles = snap.step_titles as Record<string, string>;
    expect(titles["step-1"]).toBe("Step 1");
    expect(titles["step-2"]).toBe("Step 2");
  });

  it("snapshot without plan has empty step_titles", () => {
    const mgr = new TaskStateManager("sess-1");
    const snap = mgr.getSnapshot();
    expect(snap.has_plan).toBe(false);
    expect(snap.plan_goal).toBeNull();
    expect(snap.total_steps).toBe(0);
    expect(snap.step_titles).toEqual({});
  });
});

describe("WorkingMemoryManager", () => {
  it("set/get/has/delete/clear", () => {
    const wm = new WorkingMemoryManager("sess-1");
    wm.set("key1", "value1");
    expect(wm.get("key1")).toBe("value1");
    expect(wm.has("key1")).toBe(true);
    expect(wm.has("key2")).toBe(false);
    expect(wm.get("missing")).toBeUndefined();

    wm.set("key2", { nested: true });
    expect(wm.list()).toHaveLength(2);

    wm.delete("key1");
    expect(wm.has("key1")).toBe(false);

    wm.clear();
    expect(wm.list()).toHaveLength(0);
  });

  it("list returns key-value pairs", () => {
    const wm = new WorkingMemoryManager("sess-1");
    wm.set("a", 1);
    wm.set("b", 2);
    const entries = wm.list();
    expect(entries).toEqual([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);
  });
});

describe("LongTermMemory", () => {
  it("write and read", () => {
    const ltm = new LongTermMemory();
    ltm.write("api-key", "sk-123", "user");
    const item = ltm.read("api-key");
    expect(item).toBeDefined();
    expect(item!.value).toBe("sk-123");
    expect(item!.source).toBe("user");
    expect(item!.created_at).toBeTruthy();
  });

  it("returns undefined for missing key", () => {
    const ltm = new LongTermMemory();
    expect(ltm.read("nonexistent")).toBeUndefined();
  });

  it("search by key substring", () => {
    const ltm = new LongTermMemory();
    ltm.write("database-url", "postgres://...", "config");
    ltm.write("api-endpoint", "https://...", "config");
    ltm.write("random-thing", "unrelated", "system");

    const results = ltm.search("database");
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("database-url");
  });

  it("search by value substring", () => {
    const ltm = new LongTermMemory();
    ltm.write("url", "https://example.com", "config");
    ltm.write("name", "test-project", "config");

    const results = ltm.search("example");
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("url");
  });

  it("search is case-insensitive", () => {
    const ltm = new LongTermMemory();
    ltm.write("MyKey", "MyValue", "test");
    expect(ltm.search("mykey")).toHaveLength(1);
    expect(ltm.search("MYVALUE")).toHaveLength(1);
  });

  it("list returns all items", () => {
    const ltm = new LongTermMemory();
    ltm.write("a", 1, "s");
    ltm.write("b", 2, "s");
    expect(ltm.list()).toHaveLength(2);
  });

  it("overwrite existing key", () => {
    const ltm = new LongTermMemory();
    ltm.write("key", "old", "s");
    ltm.write("key", "new", "s");
    expect(ltm.read("key")!.value).toBe("new");
    expect(ltm.list()).toHaveLength(1);
  });
});
