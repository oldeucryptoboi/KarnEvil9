import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CheckpointSerializer } from "./checkpoint-serializer.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskCheckpoint } from "./types.js";

function makeCheckpointInput(overrides: Partial<Omit<TaskCheckpoint, "checkpoint_id">> = {}): Omit<TaskCheckpoint, "checkpoint_id"> {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    state: { step: 3, partial_result: "abc" },
    findings_so_far: 2,
    tokens_used: 150,
    cost_usd: 0.015,
    duration_ms: 8000,
    timestamp: "2026-02-19T10:00:00.000Z",
    ...overrides,
  };
}

describe("CheckpointSerializer", () => {
  let tmpDir: string;
  let serializer: CheckpointSerializer;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cp-test-"));
    emitEvent = vi.fn();
    serializer = new CheckpointSerializer(join(tmpDir, "checkpoints.jsonl"), emitEvent);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Basic Save & Retrieve ──────────────────────────────────────

  it("should return a checkpoint with a generated checkpoint_id", () => {
    const cp = serializer.saveCheckpoint(makeCheckpointInput());
    expect(cp.checkpoint_id).toBeDefined();
    expect(typeof cp.checkpoint_id).toBe("string");
    expect(cp.checkpoint_id.length).toBeGreaterThan(0);
  });

  it("should store checkpoint and retrieve with getLatest", () => {
    const cp = serializer.saveCheckpoint(makeCheckpointInput());
    const latest = serializer.getLatest("task-1");
    expect(latest).toBeDefined();
    expect(latest!.checkpoint_id).toBe(cp.checkpoint_id);
    expect(latest!.task_id).toBe("task-1");
  });

  it("should return the last checkpoint when multiple saved for same task", () => {
    serializer.saveCheckpoint(makeCheckpointInput({ findings_so_far: 1 }));
    serializer.saveCheckpoint(makeCheckpointInput({ findings_so_far: 2 }));
    const cp3 = serializer.saveCheckpoint(makeCheckpointInput({ findings_so_far: 3 }));

    const latest = serializer.getLatest("task-1");
    expect(latest!.checkpoint_id).toBe(cp3.checkpoint_id);
    expect(latest!.findings_so_far).toBe(3);
  });

  it("should return all checkpoints for a task in order", () => {
    serializer.saveCheckpoint(makeCheckpointInput({ findings_so_far: 1 }));
    serializer.saveCheckpoint(makeCheckpointInput({ findings_so_far: 2 }));
    serializer.saveCheckpoint(makeCheckpointInput({ findings_so_far: 3 }));

    const all = serializer.getAll("task-1");
    expect(all).toHaveLength(3);
    expect(all[0]!.findings_so_far).toBe(1);
    expect(all[1]!.findings_so_far).toBe(2);
    expect(all[2]!.findings_so_far).toBe(3);
  });

  it("should report canResume true after saving, false for unknown task", () => {
    expect(serializer.canResume("task-1")).toBe(false);
    serializer.saveCheckpoint(makeCheckpointInput());
    expect(serializer.canResume("task-1")).toBe(true);
    expect(serializer.canResume("unknown-task")).toBe(false);
  });

  // ─── FIFO Eviction ──────────────────────────────────────────────

  it("should evict oldest checkpoints when exceeding max per task (FIFO)", () => {
    for (let i = 0; i < 11; i++) {
      serializer.saveCheckpoint(makeCheckpointInput({ findings_so_far: i }));
    }

    const all = serializer.getAll("task-1");
    expect(all).toHaveLength(10);
    // First checkpoint (findings_so_far=0) should be evicted
    expect(all[0]!.findings_so_far).toBe(1);
    expect(all[9]!.findings_so_far).toBe(10);
  });

  // ─── getCheckpointById ──────────────────────────────────────────

  it("should find a checkpoint by its ID", () => {
    const cp = serializer.saveCheckpoint(makeCheckpointInput());
    const found = serializer.getCheckpointById(cp.checkpoint_id);
    expect(found).toBeDefined();
    expect(found!.checkpoint_id).toBe(cp.checkpoint_id);
    expect(found!.task_id).toBe("task-1");
  });

  it("should return undefined for unknown checkpoint ID", () => {
    serializer.saveCheckpoint(makeCheckpointInput());
    expect(serializer.getCheckpointById("nonexistent-id")).toBeUndefined();
  });

  // ─── Empty State ────────────────────────────────────────────────

  it("should return undefined from getLatest for empty state", () => {
    expect(serializer.getLatest("task-1")).toBeUndefined();
  });

  it("should return false from canResume for empty state", () => {
    expect(serializer.canResume("any-task")).toBe(false);
  });

  it("should return empty array from getAll for empty state", () => {
    expect(serializer.getAll("task-1")).toEqual([]);
  });

  // ─── taskCount ──────────────────────────────────────────────────

  it("should track distinct tasks with taskCount", () => {
    expect(serializer.taskCount).toBe(0);
    serializer.saveCheckpoint(makeCheckpointInput({ task_id: "task-1" }));
    expect(serializer.taskCount).toBe(1);
    serializer.saveCheckpoint(makeCheckpointInput({ task_id: "task-2" }));
    expect(serializer.taskCount).toBe(2);
    // Same task again should not increase count
    serializer.saveCheckpoint(makeCheckpointInput({ task_id: "task-1" }));
    expect(serializer.taskCount).toBe(2);
  });

  // ─── Event Emission ─────────────────────────────────────────────

  it("should emit checkpoint_saved event on save", () => {
    const cp = serializer.saveCheckpoint(makeCheckpointInput());
    expect(emitEvent).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith("swarm.checkpoint_saved", {
      checkpoint_id: cp.checkpoint_id,
      task_id: "task-1",
      peer_node_id: "peer-1",
      findings_so_far: 2,
    });
  });

  // ─── Multiple Tasks ─────────────────────────────────────────────

  it("should track multiple tasks independently", () => {
    serializer.saveCheckpoint(makeCheckpointInput({ task_id: "task-A", findings_so_far: 10 }));
    serializer.saveCheckpoint(makeCheckpointInput({ task_id: "task-B", findings_so_far: 20 }));

    expect(serializer.getLatest("task-A")!.findings_so_far).toBe(10);
    expect(serializer.getLatest("task-B")!.findings_so_far).toBe(20);
    expect(serializer.getAll("task-A")).toHaveLength(1);
    expect(serializer.getAll("task-B")).toHaveLength(1);
  });

  // ─── Data Round-Trip ────────────────────────────────────────────

  it("should preserve checkpoint data correctly (state, findings_so_far, etc.)", () => {
    const input = makeCheckpointInput({
      state: { deeply: { nested: true }, arr: [1, 2, 3] },
      findings_so_far: 42,
      tokens_used: 999,
      cost_usd: 1.23,
      duration_ms: 60000,
      timestamp: "2026-02-19T12:34:56.789Z",
    });
    const cp = serializer.saveCheckpoint(input);

    expect(cp.task_id).toBe("task-1");
    expect(cp.peer_node_id).toBe("peer-1");
    expect(cp.state).toEqual({ deeply: { nested: true }, arr: [1, 2, 3] });
    expect(cp.findings_so_far).toBe(42);
    expect(cp.tokens_used).toBe(999);
    expect(cp.cost_usd).toBe(1.23);
    expect(cp.duration_ms).toBe(60000);
    expect(cp.timestamp).toBe("2026-02-19T12:34:56.789Z");
  });

  // ─── Persistence ────────────────────────────────────────────────

  it("should round-trip through save and load", async () => {
    serializer.saveCheckpoint(makeCheckpointInput({ task_id: "task-1", findings_so_far: 5 }));
    serializer.saveCheckpoint(makeCheckpointInput({ task_id: "task-2", findings_so_far: 10 }));
    await serializer.save();

    const serializer2 = new CheckpointSerializer(join(tmpDir, "checkpoints.jsonl"));
    await serializer2.load();

    expect(serializer2.taskCount).toBe(2);
    expect(serializer2.getLatest("task-1")!.findings_so_far).toBe(5);
    expect(serializer2.getLatest("task-2")!.findings_so_far).toBe(10);
    expect(serializer2.canResume("task-1")).toBe(true);
    expect(serializer2.canResume("task-2")).toBe(true);
  });

  it("should handle loading from non-existent file without error", async () => {
    const serializer2 = new CheckpointSerializer(join(tmpDir, "nonexistent.jsonl"));
    await serializer2.load();
    expect(serializer2.taskCount).toBe(0);
    expect(serializer2.getAll("any")).toEqual([]);
  });

  it("should create directory if needed on save", async () => {
    const nestedPath = join(tmpDir, "sub", "dir", "checkpoints.jsonl");
    const serializer2 = new CheckpointSerializer(nestedPath);
    serializer2.saveCheckpoint(makeCheckpointInput());
    await serializer2.save();

    const serializer3 = new CheckpointSerializer(nestedPath);
    await serializer3.load();
    expect(serializer3.taskCount).toBe(1);
  });

  // ─── Checkpoint Fields Preserved ────────────────────────────────

  it("should preserve all checkpoint fields exactly", () => {
    const input: Omit<TaskCheckpoint, "checkpoint_id"> = {
      task_id: "task-xyz",
      peer_node_id: "peer-abc",
      state: { key: "value" },
      findings_so_far: 7,
      tokens_used: 500,
      cost_usd: 0.05,
      duration_ms: 30000,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const cp = serializer.saveCheckpoint(input);

    expect(cp.task_id).toBe(input.task_id);
    expect(cp.peer_node_id).toBe(input.peer_node_id);
    expect(cp.state).toEqual(input.state);
    expect(cp.findings_so_far).toBe(input.findings_so_far);
    expect(cp.tokens_used).toBe(input.tokens_used);
    expect(cp.cost_usd).toBe(input.cost_usd);
    expect(cp.duration_ms).toBe(input.duration_ms);
    expect(cp.timestamp).toBe(input.timestamp);
  });

  // ─── All Fields Populated ───────────────────────────────────────

  it("should handle saveCheckpoint with all fields populated", () => {
    const input = makeCheckpointInput({
      task_id: "full-task",
      peer_node_id: "full-peer",
      state: { phase: "analysis", buffer: [1, 2, 3], meta: { x: true } },
      findings_so_far: 100,
      tokens_used: 50000,
      cost_usd: 5.0,
      duration_ms: 120000,
      timestamp: "2026-02-19T23:59:59.999Z",
    });
    const cp = serializer.saveCheckpoint(input);

    expect(cp.checkpoint_id).toBeDefined();
    expect(cp.task_id).toBe("full-task");
    expect(cp.peer_node_id).toBe("full-peer");
    expect(cp.state).toEqual({ phase: "analysis", buffer: [1, 2, 3], meta: { x: true } });
    expect(cp.findings_so_far).toBe(100);
    expect(cp.tokens_used).toBe(50000);
    expect(cp.cost_usd).toBe(5.0);
    expect(cp.duration_ms).toBe(120000);
    expect(cp.timestamp).toBe("2026-02-19T23:59:59.999Z");
  });
});
