import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir, readFile } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import {
  ActiveMemory,
  LongTermMemory,
  WorkingMemoryManager,
  TaskStateManager,
  extractLesson,
} from "@karnevil9/memory";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import { MockPlanner } from "@karnevil9/planner";
import type {
  Plan,
  StepResult,
  MemoryLesson,
  Task,
  ToolManifest,
  ApprovalDecision,
} from "@karnevil9/schemas";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/manifests");

// ─── Helpers ──────────────────────────────────────────────────────────

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

function makePlan(toolNames: string[], goal = "Test goal"): Plan {
  return {
    plan_id: uuid(),
    schema_version: "0.1",
    goal,
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
  };
}

// ─── Test suite ───────────────────────────────────────────────────────

describe("Memory & Learning Smoke Tests", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-memory-${uuid()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  // ─── 1. ActiveMemory lesson persistence ──────────────────────────

  describe("ActiveMemory lesson persistence", () => {
    it("add lessons, close, reopen — lessons persist and are searchable", async () => {
      const filePath = join(testDir, "active-memory.jsonl");

      // Session 1: create, add lessons, save
      const mem1 = new ActiveMemory(filePath);
      await mem1.load();
      expect(mem1.getLessons()).toHaveLength(0);

      mem1.addLesson(makeLesson({ task_summary: "Deploy the application to production server" }));
      mem1.addLesson(makeLesson({ task_summary: "Parse configuration YAML from disk" }));
      mem1.addLesson(makeLesson({ task_summary: "Run database migration scripts" }));
      await mem1.save();

      // Verify file exists on disk
      const rawContent = await readFile(filePath, "utf-8");
      const lines = rawContent.trim().split("\n");
      expect(lines).toHaveLength(3);

      // Session 2: reopen from disk, verify persistence
      const mem2 = new ActiveMemory(filePath);
      await mem2.load();
      expect(mem2.getLessons()).toHaveLength(3);

      // Verify searchable
      const results = mem2.search("configuration YAML");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.task_summary).toContain("configuration");
    });

    it("concurrent saves do not corrupt the file", async () => {
      const filePath = join(testDir, "concurrent.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      mem.addLesson(makeLesson({ task_summary: "Concurrent write A" }));
      const p1 = mem.save();
      mem.addLesson(makeLesson({ task_summary: "Concurrent write B" }));
      const p2 = mem.save();
      await Promise.all([p1, p2]);

      const mem2 = new ActiveMemory(filePath);
      await mem2.load();
      expect(mem2.getLessons()).toHaveLength(2);
      const summaries = mem2.getLessons().map(l => l.task_summary);
      expect(summaries).toContain("Concurrent write A");
      expect(summaries).toContain("Concurrent write B");
    });
  });

  // ─── 2. Cross-session lesson learning ────────────────────────────

  describe("Cross-session lesson learning", () => {
    it("lessons from session 1 surface when searched from session 2 context", async () => {
      const filePath = join(testDir, "cross-session.jsonl");

      // Session 1: a developer learns about deploying to Kubernetes
      const mem1 = new ActiveMemory(filePath);
      await mem1.load();
      mem1.addLesson(makeLesson({
        task_summary: "Deploy microservice to Kubernetes cluster",
        lesson: "Used shell-exec to run kubectl apply. Namespace must be specified.",
        tool_names: ["shell-exec"],
        session_id: "session-1",
      }));
      mem1.addLesson(makeLesson({
        task_summary: "Read database credentials from vault",
        lesson: "Used http-request to fetch secrets from Vault API.",
        tool_names: ["http-request"],
        session_id: "session-1",
      }));
      await mem1.save();

      // Session 2: new session searches for Kubernetes-related tasks
      const mem2 = new ActiveMemory(filePath);
      await mem2.load();
      const results = mem2.search("Deploy application to Kubernetes");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.task_summary).toContain("Kubernetes");
      expect(results[0]!.session_id).toBe("session-1");
    });

    it("lessons accumulate across multiple sessions", async () => {
      const filePath = join(testDir, "multi-session.jsonl");

      // Session 1
      const mem1 = new ActiveMemory(filePath);
      await mem1.load();
      mem1.addLesson(makeLesson({ task_summary: "Session 1 work", session_id: "s1" }));
      await mem1.save();

      // Session 2
      const mem2 = new ActiveMemory(filePath);
      await mem2.load();
      expect(mem2.getLessons()).toHaveLength(1);
      mem2.addLesson(makeLesson({ task_summary: "Session 2 work", session_id: "s2" }));
      await mem2.save();

      // Session 3: verify both are present
      const mem3 = new ActiveMemory(filePath);
      await mem3.load();
      expect(mem3.getLessons()).toHaveLength(2);
      const sessionIds = mem3.getLessons().map(l => l.session_id);
      expect(sessionIds).toContain("s1");
      expect(sessionIds).toContain("s2");
    });
  });

  // ─── 3. Lesson relevance scoring ────────────────────────────────

  describe("Lesson relevance scoring", () => {
    it("most relevant lesson ranks highest in search results", async () => {
      const filePath = join(testDir, "relevance.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      // Add lessons with varying relevance to a "database migration" query
      mem.addLesson(makeLesson({
        task_summary: "Configure nginx reverse proxy settings",
        lesson: "Updated nginx.conf with upstream servers.",
        tool_names: ["write-file"],
      }));
      mem.addLesson(makeLesson({
        task_summary: "Run database migration scripts for PostgreSQL",
        lesson: "Executed migration using shell-exec with psql commands.",
        tool_names: ["shell-exec"],
      }));
      mem.addLesson(makeLesson({
        task_summary: "Monitor application health endpoints",
        lesson: "Used http-request to check /health routes.",
        tool_names: ["http-request"],
      }));

      const results = mem.search("database migration PostgreSQL");
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The database/PostgreSQL lesson should rank first
      expect(results[0]!.task_summary).toContain("database");
      expect(results[0]!.task_summary).toContain("PostgreSQL");
    });

    it("tool name matching boosts relevance score", async () => {
      const filePath = join(testDir, "tool-boost.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      mem.addLesson(makeLesson({
        task_summary: "Process files from directory listing",
        lesson: "Listed files and processed them.",
        tool_names: ["shell-exec"],
      }));
      mem.addLesson(makeLesson({
        task_summary: "Process files from directory listing",
        lesson: "Read files individually for processing.",
        tool_names: ["read-file"],
      }));

      // Search with tool name hint — read-file should be boosted
      const results = mem.search("Process files from directory", ["read-file"]);
      expect(results.length).toBe(2);
      expect(results[0]!.tool_names).toContain("read-file");
    });

    it("search updates relevance_count and last_retrieved_at", async () => {
      const filePath = join(testDir, "metadata.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      const lesson = makeLesson({ task_summary: "Important database operation" });
      mem.addLesson(lesson);
      expect(lesson.relevance_count).toBe(0);
      expect(lesson.last_retrieved_at).toBeUndefined();

      mem.search("database operation");
      expect(lesson.relevance_count).toBe(1);
      expect(lesson.last_retrieved_at).toBeDefined();

      const firstRetrieved = lesson.last_retrieved_at;
      mem.search("database operation");
      expect(lesson.relevance_count).toBe(2);
      expect(lesson.last_retrieved_at).toBeDefined();
      // Timestamps may be the same if executed fast, but count must increase
    });

    it("returns at most 5 search results", async () => {
      const filePath = join(testDir, "max-results.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      for (let i = 0; i < 20; i++) {
        mem.addLesson(makeLesson({
          task_summary: `Deploy application version ${i} to production`,
        }));
      }

      const results = mem.search("Deploy application production");
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });

  // ─── 4. Lesson pruning ──────────────────────────────────────────

  describe("Lesson pruning", () => {
    it("evicts least-relevant lessons when over MAX_LESSONS (100)", async () => {
      const filePath = join(testDir, "pruning.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      // Add 100 lessons with ascending relevance_count
      for (let i = 0; i < 100; i++) {
        mem.addLesson(makeLesson({
          task_summary: `Task number ${i}`,
          relevance_count: i,
        }));
      }
      expect(mem.getLessons()).toHaveLength(100);

      // Add one more with moderate relevance — should evict the least relevant (count=0)
      mem.addLesson(makeLesson({
        task_summary: "Task overflow",
        relevance_count: 50,
      }));
      expect(mem.getLessons()).toHaveLength(100);

      const summaries = mem.getLessons().map(l => l.task_summary);
      expect(summaries).not.toContain("Task number 0");
      expect(summaries).toContain("Task overflow");
    });

    it("most recent lessons survive pruning", async () => {
      const filePath = join(testDir, "prune-recent.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      // Fill to 100 with relevance_count=0
      for (let i = 0; i < 100; i++) {
        mem.addLesson(makeLesson({
          task_summary: `Old task ${i}`,
          relevance_count: 0,
          created_at: new Date(Date.now() - (100 - i) * 1000).toISOString(),
        }));
      }

      // Add one more — this triggers eviction; oldest created_at with count=0 should go
      mem.addLesson(makeLesson({
        task_summary: "Brand new task",
        relevance_count: 0,
      }));
      expect(mem.getLessons()).toHaveLength(100);

      // The brand new task should survive (most recent created_at)
      const summaries = mem.getLessons().map(l => l.task_summary);
      expect(summaries).toContain("Brand new task");
    });

    it("old unretrieved lessons are pruned on load", async () => {
      const filePath = join(testDir, "prune-old.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      // Add an old lesson (60 days ago) with no retrievals
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60);
      mem.addLesson(makeLesson({
        task_summary: "Ancient unretrieved task",
        created_at: oldDate.toISOString(),
        relevance_count: 0,
      }));

      // Add a fresh lesson
      mem.addLesson(makeLesson({ task_summary: "Fresh task" }));
      await mem.save();

      // Reload — prune should remove the old unretrieved lesson
      const mem2 = new ActiveMemory(filePath);
      await mem2.load();
      expect(mem2.getLessons()).toHaveLength(1);
      expect(mem2.getLessons()[0]!.task_summary).toBe("Fresh task");
    });

    it("old lessons with high relevance survive pruning on load", async () => {
      const filePath = join(testDir, "prune-relevant.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60);
      mem.addLesson(makeLesson({
        task_summary: "Old but highly relevant",
        created_at: oldDate.toISOString(),
        relevance_count: 10,
      }));
      await mem.save();

      const mem2 = new ActiveMemory(filePath);
      await mem2.load();
      expect(mem2.getLessons()).toHaveLength(1);
      expect(mem2.getLessons()[0]!.task_summary).toBe("Old but highly relevant");
    });
  });

  // ─── 5. WorkingMemoryManager lifecycle ───────────────────────────

  describe("WorkingMemoryManager lifecycle", () => {
    it("set, get, has, delete, clear — full lifecycle", () => {
      const wm = new WorkingMemoryManager("e2e-session-1");

      // Set and get
      wm.set("api_key", "sk-test-123");
      wm.set("counter", 42);
      wm.set("nested", { foo: { bar: "baz" } });

      expect(wm.get("api_key")).toBe("sk-test-123");
      expect(wm.get("counter")).toBe(42);
      expect(wm.get("nested")).toEqual({ foo: { bar: "baz" } });
      expect(wm.has("api_key")).toBe(true);
      expect(wm.has("missing")).toBe(false);
      expect(wm.get("missing")).toBeUndefined();

      // List
      expect(wm.list()).toHaveLength(3);

      // Delete
      wm.delete("counter");
      expect(wm.has("counter")).toBe(false);
      expect(wm.get("counter")).toBeUndefined();
      expect(wm.list()).toHaveLength(2);

      // Clear
      wm.clear();
      expect(wm.list()).toHaveLength(0);
      expect(wm.has("api_key")).toBe(false);
    });

    it("sessions are isolated from each other", () => {
      const wm1 = new WorkingMemoryManager("session-A");
      const wm2 = new WorkingMemoryManager("session-B");

      wm1.set("key", "value-A");
      wm2.set("key", "value-B");

      expect(wm1.get("key")).toBe("value-A");
      expect(wm2.get("key")).toBe("value-B");

      wm1.clear();
      expect(wm1.list()).toHaveLength(0);
      expect(wm2.list()).toHaveLength(1);
    });

    it("overwrites existing keys without increasing entry count", () => {
      const wm = new WorkingMemoryManager("e2e-overwrite");
      wm.set("k", "v1");
      wm.set("k", "v2");
      expect(wm.get("k")).toBe("v2");
      expect(wm.list()).toHaveLength(1);
    });
  });

  // ─── 6. TaskStateManager plan/step tracking ──────────────────────

  describe("TaskStateManager plan/step tracking", () => {
    it("full lifecycle: set plan, update steps, track artifacts, snapshot", () => {
      const tsm = new TaskStateManager("e2e-session-task");

      // Initially no plan
      expect(tsm.getPlan()).toBeNull();
      expect(tsm.getAllStepResults()).toHaveLength(0);

      // Set a plan
      const plan = makePlan(["read-file", "write-file", "shell-exec"], "Build and deploy app");
      tsm.setPlan(plan);
      expect(tsm.getPlan()).toBe(plan);
      expect(tsm.getPlan()!.goal).toBe("Build and deploy app");

      // Record step results
      const result1: StepResult = {
        step_id: "step-0",
        status: "succeeded",
        output: { content: "file data" },
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        attempts: 1,
      };
      tsm.setStepResult("step-0", result1);
      expect(tsm.getStepResult("step-0")).toBe(result1);
      expect(tsm.getStepResult("step-1")).toBeUndefined();

      const result2: StepResult = {
        step_id: "step-1",
        status: "failed",
        error: { code: "PERMISSION_DENIED", message: "Cannot write" },
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        attempts: 2,
      };
      tsm.setStepResult("step-1", result2);

      const result3: StepResult = {
        step_id: "step-2",
        status: "succeeded",
        output: { exit_code: 0 },
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        attempts: 1,
      };
      tsm.setStepResult("step-2", result3);

      expect(tsm.getAllStepResults()).toHaveLength(3);

      // Track artifacts
      tsm.setArtifact("build-output", "/tmp/build/app.js");
      tsm.setArtifact("deploy-log", { lines: ["deployed", "healthy"] });
      expect(tsm.getArtifact("build-output")).toBe("/tmp/build/app.js");
      expect(tsm.getArtifact("deploy-log")).toEqual({ lines: ["deployed", "healthy"] });
      expect(tsm.getArtifact("nonexistent")).toBeUndefined();

      // Snapshot
      const snap = tsm.getSnapshot();
      expect(snap.session_id).toBe("e2e-session-task");
      expect(snap.has_plan).toBe(true);
      expect(snap.plan_goal).toBe("Build and deploy app");
      expect(snap.total_steps).toBe(3);
      expect(snap.completed_steps).toBe(2);
      expect(snap.failed_steps).toBe(1);

      const titles = snap.step_titles as Record<string, string>;
      expect(titles["step-0"]).toBe("Step 0");
      expect(titles["step-1"]).toBe("Step 1");
      expect(titles["step-2"]).toBe("Step 2");

      const artifacts = snap.artifacts as Record<string, unknown>;
      expect(artifacts["build-output"]).toBe("/tmp/build/app.js");
    });

    it("snapshot without plan returns safe defaults", () => {
      const tsm = new TaskStateManager("e2e-no-plan");
      const snap = tsm.getSnapshot();
      expect(snap.has_plan).toBe(false);
      expect(snap.plan_goal).toBeNull();
      expect(snap.total_steps).toBe(0);
      expect(snap.completed_steps).toBe(0);
      expect(snap.failed_steps).toBe(0);
      expect(snap.step_titles).toEqual({});
    });

    it("updating an existing step result replaces it", () => {
      const tsm = new TaskStateManager("e2e-update-step");
      const plan = makePlan(["read-file"]);
      tsm.setPlan(plan);

      tsm.setStepResult("step-0", {
        step_id: "step-0", status: "failed",
        started_at: new Date().toISOString(), attempts: 1,
      });
      expect(tsm.getStepResult("step-0")!.status).toBe("failed");

      // Retry succeeded
      tsm.setStepResult("step-0", {
        step_id: "step-0", status: "succeeded",
        output: { data: "ok" },
        started_at: new Date().toISOString(), attempts: 2,
      });
      expect(tsm.getStepResult("step-0")!.status).toBe("succeeded");
      expect(tsm.getAllStepResults()).toHaveLength(1);
    });
  });

  // ─── 7. LongTermMemory persistence ──────────────────────────────

  describe("LongTermMemory persistence", () => {
    it("write, read, search, list — full lifecycle", () => {
      const ltm = new LongTermMemory();

      // Write entries
      ltm.write("db-host", "postgres.internal:5432", "config");
      ltm.write("api-base-url", "https://api.example.com/v2", "environment");
      ltm.write("max-retries", 3, "defaults");

      // Read
      const dbHost = ltm.read("db-host");
      expect(dbHost).toBeDefined();
      expect(dbHost!.value).toBe("postgres.internal:5432");
      expect(dbHost!.source).toBe("config");
      expect(dbHost!.created_at).toBeTruthy();

      // Search by key
      const pgResults = ltm.search("db-host");
      expect(pgResults).toHaveLength(1);
      expect(pgResults[0]!.key).toBe("db-host");

      // Search by value
      const apiResults = ltm.search("example.com");
      expect(apiResults).toHaveLength(1);
      expect(apiResults[0]!.key).toBe("api-base-url");

      // Case-insensitive search
      expect(ltm.search("POSTGRES")).toHaveLength(1);

      // List
      expect(ltm.list()).toHaveLength(3);
      expect(ltm.size).toBe(3);
    });

    it("overwrite preserves single entry count", () => {
      const ltm = new LongTermMemory();
      ltm.write("key", "old-value", "v1");
      ltm.write("key", "new-value", "v2");

      expect(ltm.size).toBe(1);
      expect(ltm.read("key")!.value).toBe("new-value");
      expect(ltm.read("key")!.source).toBe("v2");
    });

    it("evicts oldest when maxItems exceeded", () => {
      const ltm = new LongTermMemory(3);

      ltm.write("first", "v1", "s");
      ltm.write("second", "v2", "s");
      ltm.write("third", "v3", "s");
      expect(ltm.size).toBe(3);

      ltm.write("fourth", "v4", "s");
      expect(ltm.size).toBe(3);
      expect(ltm.read("first")).toBeUndefined();
      expect(ltm.read("fourth")!.value).toBe("v4");
    });

    it("simulates cross-session usage via separate instances", () => {
      // LongTermMemory is in-memory, so we simulate "persistence" by
      // transferring data between instances via list/write
      const ltm1 = new LongTermMemory();
      ltm1.write("learned-pattern", "Always retry on 503", "session-1");
      ltm1.write("api-endpoint", "https://internal.api/v3", "session-1");

      // "Persist" by serializing
      const exported = ltm1.list();

      // "Restore" into a new instance
      const ltm2 = new LongTermMemory();
      for (const item of exported) {
        ltm2.write(item.key, item.value, item.source);
      }

      expect(ltm2.size).toBe(2);
      expect(ltm2.read("learned-pattern")!.value).toBe("Always retry on 503");
      expect(ltm2.search("internal")).toHaveLength(1);
    });
  });

  // ─── 8. Memory integration with Kernel ──────────────────────────

  describe("Memory integration with Kernel", () => {
    let journal: Journal;
    let registry: ToolRegistry;
    let permissions: PermissionEngine;
    let runtime: ToolRuntime;

    const testTool: ToolManifest = {
      name: "test-tool", version: "1.0.0", description: "Echoes input",
      runner: "internal",
      input_schema: { type: "object", properties: { message: { type: "string" } }, additionalProperties: false },
      output_schema: { type: "object", properties: { echo: { type: "string" } }, additionalProperties: false },
      permissions: [], timeout_ms: 5000,
      supports: { mock: true as const, dry_run: true },
      mock_responses: [{ echo: "mock echo" }],
    };

    beforeEach(async () => {
      journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
      await journal.init();
      registry = new ToolRegistry();
      await registry.loadFromDirectory(TOOLS_DIR);
      registry.register(testTool);
      const autoApprove = async (): Promise<ApprovalDecision> => "allow_session";
      permissions = new PermissionEngine(journal, autoApprove);
      runtime = new ToolRuntime(registry, permissions, journal);
    });

    afterEach(async () => {
      await journal.close();
    });

    it("kernel extracts lesson into ActiveMemory after session completes", async () => {
      const memPath = join(testDir, "kernel-memory.jsonl");
      const activeMem = new ActiveMemory(memPath);
      await activeMem.load();
      expect(activeMem.getLessons()).toHaveLength(0);

      const task: Task = {
        task_id: uuid(),
        text: "Read and echo a test message",
        created_at: new Date().toISOString(),
      };

      const kernel = new Kernel({
        journal,
        toolRegistry: registry,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        mode: "mock",
        limits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
        policy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
        activeMemory: activeMem,
      });

      await kernel.createSession(task);
      const session = await kernel.run();
      expect(session.status).toBe("completed");

      // Lesson should have been extracted and persisted
      expect(activeMem.getLessons().length).toBeGreaterThanOrEqual(1);
      const lesson = activeMem.getLessons()[0]!;
      expect(lesson.outcome).toBe("succeeded");
      expect(lesson.session_id).toBe(session.session_id);

      // Verify journal has the memory.lesson_extracted event
      const events = await journal.readSession(session.session_id);
      const memEvents = events.filter(e => e.type === "memory.lesson_extracted");
      expect(memEvents.length).toBeGreaterThanOrEqual(1);

      // Verify the lesson was saved to disk
      const rawContent = await readFile(memPath, "utf-8");
      expect(rawContent.trim().length).toBeGreaterThan(0);
      const parsed = JSON.parse(rawContent.trim().split("\n")[0]!);
      expect(parsed.lesson_id).toBeDefined();
      expect(parsed.outcome).toBe("succeeded");
    });

    it("lessons from a completed kernel session are searchable in new sessions", async () => {
      const memPath = join(testDir, "kernel-search.jsonl");
      const activeMem = new ActiveMemory(memPath);
      await activeMem.load();

      // Run kernel session 1
      const task1: Task = {
        task_id: uuid(),
        text: "Read and echo a test message about Kubernetes deployment",
        created_at: new Date().toISOString(),
      };

      const kernel1 = new Kernel({
        journal,
        toolRegistry: registry,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        mode: "mock",
        limits: { max_steps: 10, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 10000 },
        policy: { allowed_paths: ["/tmp"], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
        activeMemory: activeMem,
      });

      await kernel1.createSession(task1);
      await kernel1.run();
      expect(activeMem.getLessons().length).toBeGreaterThanOrEqual(1);

      // Simulate session 2: reopen memory from disk and search
      const activeMem2 = new ActiveMemory(memPath);
      await activeMem2.load();
      const results = activeMem2.search("Kubernetes deployment");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.outcome).toBe("succeeded");
    });
  });

  // ─── extractLesson integration ──────────────────────────────────

  describe("extractLesson integration", () => {
    it("extracts lesson from a completed plan with mixed results", () => {
      const plan = makePlan(["read-file", "write-file", "shell-exec"]);
      const stepResults: StepResult[] = [
        { step_id: "step-0", status: "succeeded", output: { data: "ok" }, started_at: new Date().toISOString(), attempts: 1 },
        { step_id: "step-1", status: "failed", error: { code: "EACCES", message: "Permission denied" }, started_at: new Date().toISOString(), attempts: 1 },
        { step_id: "step-2", status: "succeeded", output: { exit_code: 0 }, started_at: new Date().toISOString(), attempts: 1 },
      ];

      const lesson = extractLesson("Deploy my application", plan, stepResults, "failed", "e2e-session");
      expect(lesson).not.toBeNull();
      expect(lesson!.outcome).toBe("failed");
      expect(lesson!.lesson).toContain("Permission denied");
      expect(lesson!.tool_names).toContain("read-file");
      expect(lesson!.tool_names).toContain("write-file");
      expect(lesson!.tool_names).toContain("shell-exec");
      expect(lesson!.session_id).toBe("e2e-session");
    });

    it("stores extracted lesson in ActiveMemory and retrieves it", async () => {
      const filePath = join(testDir, "extract-and-store.jsonl");
      const mem = new ActiveMemory(filePath);
      await mem.load();

      const plan = makePlan(["http-request"]);
      const stepResults: StepResult[] = [
        { step_id: "step-0", status: "succeeded", output: { status: 200 }, started_at: new Date().toISOString(), attempts: 1 },
      ];

      const lesson = extractLesson("Fetch weather data from API", plan, stepResults, "completed");
      expect(lesson).not.toBeNull();
      mem.addLesson(lesson!);
      await mem.save();

      // Reopen and search
      const mem2 = new ActiveMemory(filePath);
      await mem2.load();
      const results = mem2.search("weather data from");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.tool_names).toContain("http-request");
    });
  });
});
