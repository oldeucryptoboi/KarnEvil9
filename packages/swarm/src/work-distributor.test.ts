import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WorkDistributor } from "./work-distributor.js";
import { MeshManager } from "./mesh-manager.js";
import type { SwarmConfig, SwarmNodeIdentity } from "./types.js";
import { DEFAULT_SWARM_CONFIG } from "./types.js";

function makeConfig(): SwarmConfig {
  return {
    ...DEFAULT_SWARM_CONFIG,
    api_url: "http://localhost:3100",
    capabilities: ["read-file"],
    mdns: false,
    seeds: [],
    heartbeat_interval_ms: 100000,
    sweep_interval_ms: 100000,
  };
}

function makeIdentity(id: string, caps: string[] = ["read-file"]): SwarmNodeIdentity {
  return {
    node_id: id,
    display_name: `Node ${id}`,
    api_url: `http://${id}:3100`,
    capabilities: caps,
    version: "0.1.0",
  };
}

describe("WorkDistributor", () => {
  let mesh: MeshManager;
  let distributor: WorkDistributor;

  beforeEach(async () => {
    mesh = new MeshManager({ config: makeConfig() });
    await mesh.start();
    distributor = new WorkDistributor({
      meshManager: mesh,
      strategy: "round_robin",
      delegation_timeout_ms: 5000,
      max_retries: 2,
    });
  });

  afterEach(async () => {
    // Don't cancelAll() here — individual tests manage their own delegations.
    // Calling cancelAll() in afterEach can cause unhandled rejections for
    // promises that are being awaited in the test body.
    await mesh.stop();
  });

  it("should throw when no peers available", async () => {
    await expect(distributor.distribute("task", "session-1")).rejects.toThrow("No suitable peers");
  });

  it("should distribute task and resolve on result", async () => {
    mesh.handleJoin(makeIdentity("peer-1"));

    vi.spyOn(mesh, "delegateTask").mockResolvedValue({
      accepted: true,
      taskId: "task-123",
    });

    const promise = distributor.distribute("Do something", "session-1");

    // Wait for the delegation to be registered
    await new Promise((r) => setTimeout(r, 20));

    // Simulate peer returning result
    const resolved = distributor.resolveTask({
      task_id: "task-123",
      peer_node_id: "peer-1",
      peer_session_id: "peer-session-1",
      status: "completed",
      findings: [{ step_title: "step1", tool_name: "read-file", status: "succeeded", summary: "done" }],
      tokens_used: 100,
      cost_usd: 0.01,
      duration_ms: 5000,
    });

    expect(resolved).toBe(true);
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
  });

  it("should return false for resolving unknown task", () => {
    expect(distributor.resolveTask({
      task_id: "unknown",
      peer_node_id: "peer-1",
      peer_session_id: "session-1",
      status: "completed",
      findings: [],
      tokens_used: 0,
      cost_usd: 0,
      duration_ms: 0,
    })).toBe(false);
  });

  it("should retry with next peer on rejection", async () => {
    mesh.handleJoin(makeIdentity("peer-1"));
    mesh.handleJoin(makeIdentity("peer-2"));

    let callCount = 0;
    vi.spyOn(mesh, "delegateTask").mockImplementation(async (_nodeId) => {
      callCount++;
      if (callCount === 1) {
        return { accepted: false, taskId: "", reason: "Busy" };
      }
      return { accepted: true, taskId: "task-456" };
    });

    const promise = distributor.distribute("Do something", "session-1");

    // Wait for delegation to be registered (first peer rejects synchronously, second accepts)
    await new Promise((r) => setTimeout(r, 20));

    distributor.resolveTask({
      task_id: "task-456",
      peer_node_id: "peer-2",
      peer_session_id: "peer-session-2",
      status: "completed",
      findings: [],
      tokens_used: 50,
      cost_usd: 0.005,
      duration_ms: 1000,
    });

    const result = await promise;
    expect(result.status).toBe("completed");
    expect(callCount).toBe(2);
  });

  it("should track active delegations", async () => {
    mesh.handleJoin(makeIdentity("peer-1"));

    vi.spyOn(mesh, "delegateTask").mockResolvedValue({
      accepted: true,
      taskId: "task-789",
    });

    expect(distributor.activeCount).toBe(0);

    const promise = distributor.distribute("Do something", "session-1");
    // Wait for the delegation to be registered
    await new Promise((r) => setTimeout(r, 10));

    expect(distributor.activeCount).toBe(1);
    const delegations = distributor.getActiveDelegations();
    expect(delegations[0]!.task_id).toBe("task-789");
    expect(delegations[0]!.peer_node_id).toBe("peer-1");

    distributor.resolveTask({
      task_id: "task-789",
      peer_node_id: "peer-1",
      peer_session_id: "session-1",
      status: "completed",
      findings: [],
      tokens_used: 0,
      cost_usd: 0,
      duration_ms: 0,
    });

    await promise;
    expect(distributor.activeCount).toBe(0);
  });

  it("should cancel all active delegations", async () => {
    mesh.handleJoin(makeIdentity("peer-1"));

    vi.spyOn(mesh, "delegateTask").mockResolvedValue({
      accepted: true,
      taskId: "task-cancel",
    });

    const promise = distributor.distribute("Do something", "session-1");
    await new Promise((r) => setTimeout(r, 10));

    expect(distributor.activeCount).toBe(1);
    distributor.cancelAll();
    expect(distributor.activeCount).toBe(0);

    await expect(promise).rejects.toThrow("cancelled");
  });

  it("should use capability_match strategy", async () => {
    distributor = new WorkDistributor({
      meshManager: mesh,
      strategy: "capability_match",
      delegation_timeout_ms: 5000,
      max_retries: 2,
    });

    mesh.handleJoin(makeIdentity("peer-1", ["read-file"]));
    mesh.handleJoin(makeIdentity("peer-2", ["shell-exec"]));

    vi.spyOn(mesh, "delegateTask").mockResolvedValue({
      accepted: true,
      taskId: "task-cap",
    });

    const promise = distributor.distribute("Do something", "session-1", {
      tool_allowlist: ["shell-exec"],
    });

    await new Promise((r) => setTimeout(r, 10));

    // Should only have tried peer-2 (which has shell-exec)
    expect(mesh.delegateTask).toHaveBeenCalledWith("peer-2", "Do something", "session-1", {
      tool_allowlist: ["shell-exec"],
    }, undefined, undefined);

    distributor.resolveTask({
      task_id: "task-cap",
      peer_node_id: "peer-2",
      peer_session_id: "session-2",
      status: "completed",
      findings: [],
      tokens_used: 0,
      cost_usd: 0,
      duration_ms: 0,
    });

    await promise;
  });

  it("should fail after exhausting all peers and retries", async () => {
    mesh.handleJoin(makeIdentity("peer-1"));

    vi.spyOn(mesh, "delegateTask").mockResolvedValue({
      accepted: false,
      taskId: "",
      reason: "Busy",
    });

    await expect(
      distributor.distribute("Do something", "session-1"),
    ).rejects.toThrow("rejected");
  });

  it("should timeout delegation", async () => {
    distributor = new WorkDistributor({
      meshManager: mesh,
      strategy: "round_robin",
      delegation_timeout_ms: 50,
      max_retries: 0,
    });

    mesh.handleJoin(makeIdentity("peer-1"));

    vi.spyOn(mesh, "delegateTask").mockResolvedValue({
      accepted: true,
      taskId: "task-timeout",
    });

    await expect(
      distributor.distribute("Do something", "session-1"),
    ).rejects.toThrow("timed out");
  });

  it("should round-robin between peers", async () => {
    mesh.handleJoin(makeIdentity("peer-1"));
    mesh.handleJoin(makeIdentity("peer-2"));
    mesh.handleJoin(makeIdentity("peer-3"));

    const delegatedTo: string[] = [];

    vi.spyOn(mesh, "delegateTask").mockImplementation(async (nodeId) => {
      delegatedTo.push(nodeId);
      return { accepted: true, taskId: `task-${delegatedTo.length}` };
    });

    // Distribute 3 tasks, each should resolve immediately
    for (let i = 0; i < 3; i++) {
      const promise = distributor.distribute("task", "session-1");
      await new Promise((r) => setTimeout(r, 10));
      distributor.resolveTask({
        task_id: `task-${i + 1}`,
        peer_node_id: delegatedTo[i]!,
        peer_session_id: "session-1",
        status: "completed",
        findings: [],
        tokens_used: 0,
        cost_usd: 0,
        duration_ms: 0,
      });
      await promise;
    }

    // All three different peers should have been tried first
    const unique = new Set(delegatedTo);
    expect(unique.size).toBe(3);
  });
});
