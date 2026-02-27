import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSwarmDistributeHandler, createSwarmPeersHandler, swarmDistributeManifest, swarmPeersManifest } from "./swarm-tool.js";
import { MeshManager } from "./mesh-manager.js";
import { WorkDistributor } from "./work-distributor.js";
import type { SwarmConfig } from "./types.js";
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

const emptyPolicy = { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };

describe("swarm-distribute tool", () => {
  let mesh: MeshManager;
  let distributor: WorkDistributor;
  let handler: ReturnType<typeof createSwarmDistributeHandler>;

  beforeEach(async () => {
    mesh = new MeshManager({ config: makeConfig() });
    await mesh.start();
    distributor = new WorkDistributor({
      meshManager: mesh,
      strategy: "round_robin",
      delegation_timeout_ms: 5000,
      max_retries: 2,
    });
    handler = createSwarmDistributeHandler(mesh, distributor);
  });

  afterEach(async () => {
    distributor.cancelAll();
    await mesh.stop();
  });

  it("should have correct manifest", () => {
    expect(swarmDistributeManifest.name).toBe("swarm-distribute");
    expect(swarmDistributeManifest.runner).toBe("internal");
    expect(swarmDistributeManifest.permissions).toContain("swarm:delegate:tasks");
  });

  it("should return mock response in mock mode", async () => {
    const result = await handler({ task_text: "do something" }, "mock", emptyPolicy) as Record<string, unknown>;
    expect(result.status).toBe("completed");
    expect(result.peer_node_id).toBe("mock-peer");
  });

  it("should return dry_run info", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });

    const result = await handler({ task_text: "do something" }, "dry_run", emptyPolicy) as Record<string, unknown>;
    expect(result.dry_run).toBe(true);
    expect(result.available_peers).toBe(1);
  });

  it("should throw for missing task_text", async () => {
    await expect(handler({}, "live", emptyPolicy)).rejects.toThrow("task_text is required");
  });

  it("should distribute task in real mode", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });

    vi.spyOn(mesh, "delegateTask").mockResolvedValue({ accepted: true, taskId: "task-1" });

    const promise = handler({ task_text: "analyze logs" }, "live", emptyPolicy);
    await new Promise((r) => setTimeout(r, 10));

    distributor.resolveTask({
      task_id: "task-1",
      peer_node_id: "peer-1",
      peer_session_id: "session-1",
      status: "completed",
      findings: [{ step_title: "analyze", tool_name: "read-file", status: "succeeded", summary: "found issue" }],
      tokens_used: 200,
      cost_usd: 0.02,
      duration_ms: 3000,
    });

    const result = await promise as Record<string, unknown>;
    expect(result.status).toBe("completed");
    expect((result.findings as unknown[]).length).toBe(1);
    expect(result.peer_node_id).toBe("peer-1");
  });
});

describe("swarm-peers tool", () => {
  let mesh: MeshManager;
  let handler: ReturnType<typeof createSwarmPeersHandler>;

  beforeEach(async () => {
    mesh = new MeshManager({ config: makeConfig() });
    await mesh.start();
    handler = createSwarmPeersHandler(mesh);
  });

  afterEach(async () => {
    await mesh.stop();
  });

  it("should have correct manifest", () => {
    expect(swarmPeersManifest.name).toBe("swarm-peers");
    expect(swarmPeersManifest.permissions).toContain("swarm:read:peers");
  });

  it("should return mock response", async () => {
    const result = await handler({}, "mock", emptyPolicy) as Record<string, unknown>;
    expect(result.total).toBe(0);
    expect((result.peers as unknown[]).length).toBe(0);
  });

  it("should list peers in real mode", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });

    const result = await handler({}, "live", emptyPolicy) as Record<string, unknown>;
    expect(result.total).toBe(1);
    expect((result.self as Record<string, unknown>).node_id).toBeTruthy();
  });

  it("should filter by status", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });
    mesh.handleLeave("peer-1");

    const result = await handler({ status_filter: "active" }, "live", emptyPolicy) as Record<string, unknown>;
    expect(result.total).toBe(0);
  });
});
