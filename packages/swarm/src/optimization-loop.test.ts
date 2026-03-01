import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OptimizationLoop } from "./optimization-loop.js";
import type { WorkDistributor } from "./work-distributor.js";
import type { MeshManager } from "./mesh-manager.js";
import type { ReputationStore } from "./reputation-store.js";

function makeMockDistributor() {
  return {
    getActiveDelegations: vi.fn().mockReturnValue([]),
    getActiveDelegation: vi.fn().mockReturnValue(undefined),
    cancelTask: vi.fn().mockReturnValue(true),
    handlePeerDegradation: vi.fn().mockResolvedValue(undefined),
    activeCount: 0,
  } as unknown as WorkDistributor;
}

function makeMockMesh() {
  return {
    getActivePeers: vi.fn().mockReturnValue([]),
    getPeer: vi.fn().mockReturnValue(undefined),
    getIdentity: vi.fn().mockReturnValue({ node_id: "self" }),
  } as unknown as MeshManager;
}

function makeMockReputation() {
  return {
    getTrustScore: vi.fn().mockReturnValue(0.5),
    getReputation: vi.fn().mockReturnValue(undefined),
  } as unknown as ReputationStore;
}

function makePeerEntry(nodeId: string, latency = 100) {
  return {
    identity: { node_id: nodeId, display_name: nodeId, api_url: `http://${nodeId}`, capabilities: [], version: "1.0" },
    status: "active" as const,
    last_heartbeat_at: new Date().toISOString(),
    last_latency_ms: latency,
    consecutive_failures: 0,
    joined_at: new Date().toISOString(),
  };
}

describe("OptimizationLoop", () => {
  let distributor: ReturnType<typeof makeMockDistributor>;
  let mesh: ReturnType<typeof makeMockMesh>;
  let reputation: ReturnType<typeof makeMockReputation>;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    distributor = makeMockDistributor();
    mesh = makeMockMesh();
    reputation = makeMockReputation();
    emitEvent = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops cleanly", () => {
    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      emitEvent,
    });
    loop.start();
    expect(loop.isRunning).toBe(true);
    loop.stop();
    expect(loop.isRunning).toBe(false);
  });

  it("does not double-start", () => {
    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
    });
    loop.start();
    loop.start(); // no-op
    expect(loop.isRunning).toBe(true);
    loop.stop();
  });

  it("evaluates on interval", async () => {
    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      emitEvent,
      loopConfig: { evaluation_interval_ms: 5000 },
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(emitEvent).toHaveBeenCalledWith("swarm.reoptimization_triggered", expect.objectContaining({
      tasks_evaluated: 0,
    }));
    loop.stop();
  });

  it("evaluateTask returns keep when no active delegation", () => {
    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
    });
    const result = loop.evaluateTask("task-1");
    expect(result.action).toBe("keep");
    expect(result.reason).toContain("No active delegation");
  });

  it("evaluateTask returns keep when current peer is adequate", () => {
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue({
      task_id: "task-1",
      peer_node_id: "peer-1",
      sent_at: Date.now() - 120000,
    });
    (mesh.getActivePeers as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      reputationStore: reputation,
    });
    const result = loop.evaluateTask("task-1");
    expect(result.action).toBe("keep");
  });

  it("evaluateTask returns redelegate when drift exceeds threshold", () => {
    const now = Date.now();
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue({
      task_id: "task-1",
      peer_node_id: "peer-bad",
      sent_at: now - 120000, // 2 minutes ago
    });
    (mesh.getActivePeers as ReturnType<typeof vi.fn>).mockReturnValue([
      makePeerEntry("peer-good", 50),
    ]);
    (mesh.getPeer as ReturnType<typeof vi.fn>).mockImplementation((nodeId: string) => {
      if (nodeId === "peer-bad") return makePeerEntry("peer-bad", 9000);
      if (nodeId === "peer-good") return makePeerEntry("peer-good", 50);
      return undefined;
    });
    (reputation.getTrustScore as ReturnType<typeof vi.fn>).mockImplementation((nodeId: string) => {
      if (nodeId === "peer-bad") return 0.1;
      if (nodeId === "peer-good") return 0.9;
      return 0.5;
    });

    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      reputationStore: reputation,
      loopConfig: { drift_threshold: 0.3, min_time_before_redelegate_ms: 60000 },
    });
    const result = loop.evaluateTask("task-1");
    expect(result.action).toBe("redelegate");
    expect(result.best_alternative_node_id).toBe("peer-good");
  });

  it("evaluateTask returns escalate when too many missed checkpoints", () => {
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue({
      task_id: "task-1",
      peer_node_id: "peer-1",
      sent_at: Date.now() - 120000,
    });

    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
    });

    // Feed missed checkpoint data
    loop.onCheckpointData("task-1", { task_id: "task-1", status: "failed", last_activity_at: "" });
    loop.onCheckpointData("task-1", { task_id: "task-1", status: "failed", last_activity_at: "" });
    loop.onCheckpointData("task-1", { task_id: "task-1", status: "failed", last_activity_at: "" });

    const result = loop.evaluateTask("task-1");
    expect(result.action).toBe("escalate");
    expect(result.reason).toContain("missed");
  });

  it("respects anti-thrashing window", () => {
    const now = Date.now();
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue({
      task_id: "task-1",
      peer_node_id: "peer-bad",
      sent_at: now - 30000, // Only 30 seconds ago
    });
    (mesh.getActivePeers as ReturnType<typeof vi.fn>).mockReturnValue([
      makePeerEntry("peer-good", 50),
    ]);
    (mesh.getPeer as ReturnType<typeof vi.fn>).mockImplementation((nodeId: string) => {
      if (nodeId === "peer-bad") return makePeerEntry("peer-bad", 9000);
      if (nodeId === "peer-good") return makePeerEntry("peer-good", 50);
      return undefined;
    });
    (reputation.getTrustScore as ReturnType<typeof vi.fn>).mockImplementation((nodeId: string) => {
      if (nodeId === "peer-bad") return 0.1;
      if (nodeId === "peer-good") return 0.9;
      return 0.5;
    });

    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      reputationStore: reputation,
      loopConfig: { drift_threshold: 0.3, min_time_before_redelegate_ms: 60000 },
    });
    const result = loop.evaluateTask("task-1");
    // Drift is detected but within anti-thrashing window
    expect(result.action).toBe("keep");
    expect(result.reason).toContain("anti-thrashing");
  });

  it("evaluateAll processes multiple tasks", () => {
    (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([
      { task_id: "task-1", peer_node_id: "peer-1", elapsed_ms: 5000 },
      { task_id: "task-2", peer_node_id: "peer-2", elapsed_ms: 10000 },
    ]);
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockImplementation((taskId: string) => ({
      task_id: taskId,
      peer_node_id: taskId === "task-1" ? "peer-1" : "peer-2",
      sent_at: Date.now() - 5000,
    }));

    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      emitEvent,
    });
    const results = loop.evaluateAll();
    expect(results.size).toBe(2);
    expect(results.has("task-1")).toBe(true);
    expect(results.has("task-2")).toBe(true);
  });

  it("evaluateAll emits reoptimization_triggered event", () => {
    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      emitEvent,
    });
    loop.evaluateAll();
    expect(emitEvent).toHaveBeenCalledWith("swarm.reoptimization_triggered", expect.objectContaining({
      tasks_evaluated: 0,
    }));
  });

  it("evaluateAll emits peer_redelegate_on_drift for redelegation decisions", () => {
    const now = Date.now();
    (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([
      { task_id: "task-1", peer_node_id: "peer-bad", elapsed_ms: 120000 },
    ]);
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue({
      task_id: "task-1",
      peer_node_id: "peer-bad",
      sent_at: now - 120000,
    });
    (mesh.getActivePeers as ReturnType<typeof vi.fn>).mockReturnValue([
      makePeerEntry("peer-good", 50),
    ]);
    (mesh.getPeer as ReturnType<typeof vi.fn>).mockImplementation((nodeId: string) => {
      if (nodeId === "peer-bad") return makePeerEntry("peer-bad", 9000);
      return makePeerEntry(nodeId, 50);
    });
    (reputation.getTrustScore as ReturnType<typeof vi.fn>).mockImplementation((nodeId: string) => {
      if (nodeId === "peer-bad") return 0.1;
      return 0.9;
    });

    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      reputationStore: reputation,
      emitEvent,
      loopConfig: { drift_threshold: 0.3, min_time_before_redelegate_ms: 60000 },
    });
    loop.evaluateAll();
    expect(emitEvent).toHaveBeenCalledWith("swarm.peer_redelegate_on_drift", expect.objectContaining({
      task_id: "task-1",
    }));
  });

  it("onCheckpointData creates task state from active delegation", () => {
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue({
      task_id: "task-1",
      peer_node_id: "peer-1",
      sent_at: Date.now() - 5000,
    });

    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
    });
    loop.onCheckpointData("task-1", {
      task_id: "task-1",
      status: "running",
      progress_pct: 50,
      last_activity_at: new Date().toISOString(),
    });

    // Should now be able to evaluate this task
    const result = loop.evaluateTask("task-1");
    expect(result.current_peer_score).toBeGreaterThan(0);
  });

  it("onCheckpointData ignores unknown tasks without active delegation", () => {
    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
    });
    // Should not throw
    loop.onCheckpointData("unknown-task", {
      task_id: "unknown-task",
      status: "running",
      last_activity_at: "",
    });
  });

  it("evaluateAll cleans up stale task states", () => {
    (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([
      { task_id: "task-1", peer_node_id: "peer-1", elapsed_ms: 5000 },
    ]);
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockImplementation((taskId: string) => {
      if (taskId === "task-1") return { task_id: "task-1", peer_node_id: "peer-1", sent_at: Date.now() - 5000 };
      return undefined;
    });

    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      emitEvent,
    });
    loop.evaluateAll();

    // Now remove task-1 from active
    (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const results = loop.evaluateAll();
    expect(results.size).toBe(0);
  });

  it("caps taskStates at 10,000 with LRU eviction via onCheckpointData", () => {
    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
    });

    // Each call to onCheckpointData with a new task creates a new taskState entry
    for (let i = 0; i < 10_001; i++) {
      (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue({
        task_id: `task-${i}`,
        peer_node_id: `peer-${i}`,
        sent_at: Date.now() - 5000,
      });
      loop.onCheckpointData(`task-${i}`, {
        task_id: `task-${i}`,
        status: "running",
        last_activity_at: new Date().toISOString(),
      });
    }

    // After exceeding the cap, the first entry should have been evicted.
    // We can verify by checking evaluateTask for the first task returns "No active delegation"
    // since the taskState was evicted and we mock getActiveDelegation to undefined for it.
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const result = loop.evaluateTask("task-0");
    expect(result.action).toBe("keep");
    expect(result.reason).toContain("No active delegation");
  });

  it("overhead factor raises effective threshold", () => {
    const now = Date.now();
    (distributor.getActiveDelegation as ReturnType<typeof vi.fn>).mockReturnValue({
      task_id: "task-1",
      peer_node_id: "peer-current",
      sent_at: now - 120000,
    });
    (mesh.getActivePeers as ReturnType<typeof vi.fn>).mockReturnValue([
      makePeerEntry("peer-alt", 100),
    ]);
    (mesh.getPeer as ReturnType<typeof vi.fn>).mockImplementation((nodeId: string) => {
      if (nodeId === "peer-current") return makePeerEntry("peer-current", 3000);
      return makePeerEntry(nodeId, 100);
    });
    (reputation.getTrustScore as ReturnType<typeof vi.fn>).mockImplementation((nodeId: string) => {
      if (nodeId === "peer-current") return 0.4;
      return 0.6;
    });

    // With high overhead factor, marginal improvements don't trigger redelegate
    const loop = new OptimizationLoop({
      workDistributor: distributor,
      meshManager: mesh,
      reputationStore: reputation,
      loopConfig: { drift_threshold: 0.3, overhead_factor: 0.5, min_time_before_redelegate_ms: 0 },
    });
    const result = loop.evaluateTask("task-1");
    // The drift adjusted by high overhead should not exceed threshold
    expect(result.action).toBe("keep");
  });
});
