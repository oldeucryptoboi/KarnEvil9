import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { v4 as uuid } from "uuid";
import {
  MeshManager,
  WorkDistributor,
  PeerTable,
} from "@karnevil9/swarm";
import type {
  SwarmConfig,
  SwarmNodeIdentity,
  SwarmTaskRequest,
  SwarmTaskResult,
  SwarmTaskConstraints,
} from "@karnevil9/swarm";
import { DEFAULT_SWARM_CONFIG } from "@karnevil9/swarm";

// ─── Helpers ───────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    ...DEFAULT_SWARM_CONFIG,
    api_url: `http://node-${uuid().slice(0, 8)}:3100`,
    capabilities: ["read-file", "shell-exec"],
    // Large intervals to prevent background timers from interfering
    heartbeat_interval_ms: 600_000,
    sweep_interval_ms: 600_000,
    mdns: false,
    seeds: [],
    gossip: false,
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<SwarmNodeIdentity> = {}): SwarmNodeIdentity {
  const id = overrides.node_id ?? `peer-${uuid().slice(0, 8)}`;
  return {
    node_id: id,
    display_name: overrides.display_name ?? `Node-${id}`,
    api_url: overrides.api_url ?? `http://${id}:3100`,
    capabilities: overrides.capabilities ?? ["read-file"],
    version: overrides.version ?? "0.1.0",
  };
}

function makeTaskResult(overrides: Partial<SwarmTaskResult> = {}): SwarmTaskResult {
  return {
    task_id: overrides.task_id ?? uuid(),
    peer_node_id: overrides.peer_node_id ?? "peer-1",
    peer_session_id: overrides.peer_session_id ?? uuid(),
    status: overrides.status ?? "completed",
    findings: overrides.findings ?? [],
    tokens_used: overrides.tokens_used ?? 100,
    cost_usd: overrides.cost_usd ?? 0.01,
    duration_ms: overrides.duration_ms ?? 1000,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Swarm Mesh E2E Smoke Tests
// ═══════════════════════════════════════════════════════════════════

describe("Swarm Mesh E2E Smoke", () => {
  // ─── 1. Mesh Formation ───────────────────────────────────────────

  describe("Mesh formation", () => {
    let mesh: MeshManager;

    beforeEach(() => {
      mesh = new MeshManager({ config: makeConfig() });
    });

    afterEach(async () => {
      if (mesh.isRunning) await mesh.stop();
    });

    it("creates a mesh, adds agents, and verifies topology", async () => {
      await mesh.start();
      expect(mesh.isRunning).toBe(true);

      // Add three agents with distinct capabilities
      const agentA = makeIdentity({
        node_id: "agent-a",
        capabilities: ["read-file", "shell-exec"],
      });
      const agentB = makeIdentity({
        node_id: "agent-b",
        capabilities: ["http-request", "browser"],
      });
      const agentC = makeIdentity({
        node_id: "agent-c",
        capabilities: ["read-file", "write-file"],
      });

      mesh.handleJoin(agentA);
      mesh.handleJoin(agentB);
      mesh.handleJoin(agentC);

      // Verify all agents are in the mesh
      expect(mesh.peerCount).toBe(3);
      const allPeers = mesh.getPeers();
      expect(allPeers).toHaveLength(3);

      // Verify each agent is discoverable by ID
      expect(mesh.getPeer("agent-a")).toBeDefined();
      expect(mesh.getPeer("agent-b")).toBeDefined();
      expect(mesh.getPeer("agent-c")).toBeDefined();

      // Verify all agents are active
      const activePeers = mesh.getActivePeers();
      expect(activePeers).toHaveLength(3);
      for (const peer of activePeers) {
        expect(peer.status).toBe("active");
      }

      // Verify capability-based lookup
      const readFilePeers = mesh.getPeersByCapability("read-file");
      expect(readFilePeers).toHaveLength(2); // agent-a and agent-c
      const nodeIds = readFilePeers.map((p) => p.identity.node_id).sort();
      expect(nodeIds).toEqual(["agent-a", "agent-c"]);

      const browserPeers = mesh.getPeersByCapability("browser");
      expect(browserPeers).toHaveLength(1);
      expect(browserPeers[0]!.identity.node_id).toBe("agent-b");
    });
  });

  // ─── 2. Task Delegation ──────────────────────────────────────────

  describe("Task delegation", () => {
    let mesh: MeshManager;

    afterEach(async () => {
      if (mesh?.isRunning) await mesh.stop();
    });

    it("submits a task and verifies it routes to the correct handler", async () => {
      const taskHandler = vi.fn().mockResolvedValue({ accepted: true });
      mesh = new MeshManager({
        config: makeConfig(),
        onTaskRequest: taskHandler,
      });
      await mesh.start();

      const request: SwarmTaskRequest = {
        task_id: "task-delegate-1",
        originator_node_id: "remote-node",
        originator_session_id: "session-1",
        task_text: "Analyze package.json for vulnerabilities",
        constraints: { tool_allowlist: ["read-file"], max_tokens: 1000 },
        correlation_id: uuid(),
        nonce: uuid(),
      };

      const result = await mesh.handleTaskRequest(request);
      expect(result.accepted).toBe(true);
      expect(taskHandler).toHaveBeenCalledTimes(1);
      expect(taskHandler).toHaveBeenCalledWith(request);
    });

    it("delegates a task to a remote peer via transport", async () => {
      mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();

      const peer = makeIdentity({ node_id: "worker-1" });
      mesh.handleJoin(peer);

      // Mock the transport to simulate a successful delegation
      vi.spyOn(mesh.getTransport(), "sendTaskRequest").mockResolvedValue({
        ok: true,
        status: 200,
        data: { accepted: true },
        latency_ms: 15,
      });

      const result = await mesh.delegateTask(
        "worker-1",
        "Read the README.md file",
        "session-abc",
        { tool_allowlist: ["read-file"] },
      );

      expect(result.accepted).toBe(true);
      expect(result.taskId).toBeTruthy();
    });

    it("rejects delegation to an inactive peer", async () => {
      mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();

      const peer = makeIdentity({ node_id: "gone-peer" });
      mesh.handleJoin(peer);
      mesh.handleLeave("gone-peer");

      const result = await mesh.delegateTask(
        "gone-peer",
        "Some task",
        "session-x",
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("not active");
    });
  });

  // ─── 3. Agent Communication ──────────────────────────────────────

  describe("Agent communication", () => {
    let meshA: MeshManager;
    let meshB: MeshManager;

    afterEach(async () => {
      if (meshA?.isRunning) await meshA.stop();
      if (meshB?.isRunning) await meshB.stop();
    });

    it("exchanges gossip messages between agents", async () => {
      meshA = new MeshManager({
        config: makeConfig({ node_name: "node-a" }),
      });
      meshB = new MeshManager({
        config: makeConfig({ node_name: "node-b" }),
      });

      await meshA.start();
      await meshB.start();

      // Node A knows about peer-x
      const peerX = makeIdentity({ node_id: "peer-x", api_url: "http://peer-x:3100" });
      meshA.handleJoin(peerX);

      // Node B sends gossip to Node A with info about peer-y
      const gossipResponse = meshA.handleGossip({
        sender_node_id: meshB.getIdentity().node_id,
        peers: [
          { node_id: "peer-y", api_url: "http://peer-y:3100", status: "active" },
        ],
      });

      // Node A returns its peer list in the gossip response
      expect(gossipResponse.sender_node_id).toBe(meshA.getIdentity().node_id);
      expect(gossipResponse.peers.length).toBeGreaterThanOrEqual(1);

      // Verify A's response includes peer-x
      const peerIds = gossipResponse.peers.map((p) => p.node_id);
      expect(peerIds).toContain("peer-x");
    });

    it("propagates heartbeats to track peer health", async () => {
      meshA = new MeshManager({
        config: makeConfig({ node_name: "node-a" }),
      });
      await meshA.start();

      const peer = makeIdentity({ node_id: "heartbeat-peer" });
      meshA.handleJoin(peer);

      // Send heartbeats with varying latencies
      meshA.handleHeartbeat(
        { node_id: "heartbeat-peer", timestamp: new Date().toISOString(), active_sessions: 2, load: 0.5 },
        50,
      );
      expect(meshA.getPeer("heartbeat-peer")?.last_latency_ms).toBe(50);

      meshA.handleHeartbeat(
        { node_id: "heartbeat-peer", timestamp: new Date().toISOString(), active_sessions: 3, load: 0.7 },
        30,
      );
      expect(meshA.getPeer("heartbeat-peer")?.last_latency_ms).toBe(30);
      expect(meshA.getPeer("heartbeat-peer")?.consecutive_failures).toBe(0);
    });

    it("handles task results between mesh manager instances", async () => {
      const receivedResults: SwarmTaskResult[] = [];
      meshA = new MeshManager({
        config: makeConfig({ node_name: "coordinator" }),
        onTaskResult: (result) => receivedResults.push(result),
      });
      await meshA.start();

      // Simulate receiving a task result from a remote peer
      const result = makeTaskResult({
        task_id: "cross-mesh-task",
        peer_node_id: "remote-worker",
        status: "completed",
        findings: [{ severity: "info", message: "All clear", tool: "read-file" }],
      });

      meshA.handleTaskResult(result);
      expect(receivedResults).toHaveLength(1);
      expect(receivedResults[0]!.task_id).toBe("cross-mesh-task");
      expect(receivedResults[0]!.status).toBe("completed");
    });
  });

  // ─── 4. Fault Tolerance ──────────────────────────────────────────

  describe("Fault tolerance", () => {
    let mesh: MeshManager;

    afterEach(async () => {
      if (mesh?.isRunning) await mesh.stop();
    });

    it("handles agent removal while remaining agents continue to function", async () => {
      const taskHandler = vi.fn().mockResolvedValue({ accepted: true });
      mesh = new MeshManager({
        config: makeConfig(),
        onTaskRequest: taskHandler,
      });
      await mesh.start();

      // Add three agents
      mesh.handleJoin(makeIdentity({ node_id: "agent-1", capabilities: ["read-file"] }));
      mesh.handleJoin(makeIdentity({ node_id: "agent-2", capabilities: ["shell-exec"] }));
      mesh.handleJoin(makeIdentity({ node_id: "agent-3", capabilities: ["read-file", "shell-exec"] }));
      expect(mesh.getActivePeers()).toHaveLength(3);

      // Agent-2 leaves the mesh
      mesh.handleLeave("agent-2");
      expect(mesh.getPeer("agent-2")?.status).toBe("left");

      // Remaining active agents should still be functional
      const activePeers = mesh.getActivePeers();
      expect(activePeers).toHaveLength(2);
      const activeIds = activePeers.map((p) => p.identity.node_id).sort();
      expect(activeIds).toEqual(["agent-1", "agent-3"]);

      // Tasks can still be accepted
      const request: SwarmTaskRequest = {
        task_id: "post-leave-task",
        originator_node_id: "external",
        originator_session_id: "session-2",
        task_text: "Continue processing after peer departure",
        correlation_id: uuid(),
        nonce: uuid(),
      };
      const result = await mesh.handleTaskRequest(request);
      expect(result.accepted).toBe(true);

      // Capability lookup excludes the departed agent
      const shellPeers = mesh.getPeersByCapability("shell-exec");
      expect(shellPeers).toHaveLength(1);
      expect(shellPeers[0]!.identity.node_id).toBe("agent-3");
    });

    it("rejects replayed nonces for replay-attack protection", async () => {
      const taskHandler = vi.fn().mockResolvedValue({ accepted: true });
      mesh = new MeshManager({
        config: makeConfig(),
        onTaskRequest: taskHandler,
      });
      await mesh.start();

      const nonce = uuid();
      const baseRequest: SwarmTaskRequest = {
        task_id: "task-original",
        originator_node_id: "attacker",
        originator_session_id: "session-x",
        task_text: "Legitimate request",
        correlation_id: uuid(),
        nonce,
      };

      // First request succeeds
      const first = await mesh.handleTaskRequest(baseRequest);
      expect(first.accepted).toBe(true);

      // Replay attempt with same nonce is rejected
      const replay = await mesh.handleTaskRequest({
        ...baseRequest,
        task_id: "task-replay",
      });
      expect(replay.accepted).toBe(false);
      expect(replay.reason).toContain("Replayed");
    });

    it("enforces delegation depth limits", async () => {
      const taskHandler = vi.fn().mockResolvedValue({ accepted: true });
      mesh = new MeshManager({
        config: makeConfig({ max_delegation_depth: 2 }),
        onTaskRequest: taskHandler,
      });
      await mesh.start();

      // Depth within limit should succeed
      const withinLimit: SwarmTaskRequest = {
        task_id: "task-depth-1",
        originator_node_id: "remote",
        originator_session_id: "s1",
        task_text: "Depth 1 task",
        correlation_id: uuid(),
        nonce: uuid(),
        delegation_depth: 1,
      };
      const ok = await mesh.handleTaskRequest(withinLimit);
      expect(ok.accepted).toBe(true);

      // Depth at limit should be rejected
      const atLimit: SwarmTaskRequest = {
        task_id: "task-depth-max",
        originator_node_id: "remote",
        originator_session_id: "s2",
        task_text: "Too deep",
        correlation_id: uuid(),
        nonce: uuid(),
        delegation_depth: 2,
      };
      const rejected = await mesh.handleTaskRequest(atLimit);
      expect(rejected.accepted).toBe(false);
      expect(rejected.reason).toContain("Delegation depth");
    });
  });

  // ─── 5. Mesh Manager Lifecycle ──────────────────────────────────

  describe("Mesh manager lifecycle", () => {
    it("starts and stops cleanly with no resource leaks", async () => {
      const mesh = new MeshManager({ config: makeConfig() });

      // Initially not running
      expect(mesh.isRunning).toBe(false);
      expect(mesh.peerCount).toBe(0);

      // Start the mesh
      await mesh.start();
      expect(mesh.isRunning).toBe(true);

      // Add some peers to build up state
      mesh.handleJoin(makeIdentity({ node_id: "lifecycle-peer-1" }));
      mesh.handleJoin(makeIdentity({ node_id: "lifecycle-peer-2" }));
      expect(mesh.peerCount).toBe(2);

      // Stop the mesh
      await mesh.stop();
      expect(mesh.isRunning).toBe(false);

      // Peer table should be cleared after stop
      expect(mesh.peerCount).toBe(0);
      expect(mesh.getPeers()).toHaveLength(0);
    });

    it("handles double-start gracefully", async () => {
      const mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();
      await mesh.start(); // Second start should be a no-op
      expect(mesh.isRunning).toBe(true);
      await mesh.stop();
    });

    it("handles double-stop gracefully", async () => {
      const mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();
      await mesh.stop();
      await mesh.stop(); // Second stop should be a no-op
      expect(mesh.isRunning).toBe(false);
    });

    it("preserves identity across start/stop cycles", async () => {
      const mesh = new MeshManager({ config: makeConfig({ node_name: "stable-node" }) });
      const identityBefore = mesh.getIdentity();

      await mesh.start();
      const identityDuring = mesh.getIdentity();
      await mesh.stop();
      const identityAfter = mesh.getIdentity();

      expect(identityBefore.node_id).toBe(identityDuring.node_id);
      expect(identityDuring.node_id).toBe(identityAfter.node_id);
      expect(identityAfter.display_name).toBe("stable-node");
    });

    it("notifies peers on graceful shutdown", async () => {
      const mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();

      const peer = makeIdentity({ node_id: "notified-peer" });
      mesh.handleJoin(peer);

      const sendLeaveSpy = vi.spyOn(mesh.getTransport(), "sendLeave").mockResolvedValue({
        ok: true,
        status: 200,
        latency_ms: 5,
      });

      await mesh.stop();

      // Verify leave message was sent to the peer
      expect(sendLeaveSpy).toHaveBeenCalledTimes(1);
      const [url, leaveMsg] = sendLeaveSpy.mock.calls[0]!;
      expect(url).toBe(peer.api_url);
      expect(leaveMsg).toMatchObject({
        node_id: mesh.getIdentity().node_id,
        reason: "shutdown",
      });
    });
  });

  // ─── 6. Concurrent Task Processing ──────────────────────────────

  describe("Concurrent task processing", () => {
    let mesh: MeshManager;
    let distributor: WorkDistributor;

    afterEach(async () => {
      if (distributor) distributor.cancelAll();
      if (mesh?.isRunning) await mesh.stop();
    });

    it("distributes multiple tasks across agents using round-robin", async () => {
      mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();

      // Add three agents
      const agents = ["worker-a", "worker-b", "worker-c"];
      for (const id of agents) {
        mesh.handleJoin(makeIdentity({
          node_id: id,
          capabilities: ["read-file", "shell-exec"],
        }));
      }

      // Mock transport to accept all task delegations
      const delegatedTo: string[] = [];
      vi.spyOn(mesh.getTransport(), "sendTaskRequest").mockImplementation(
        async (apiUrl: string) => {
          // Extract the node ID from the apiUrl pattern
          const nodeId = agents.find((a) => apiUrl.includes(a));
          if (nodeId) delegatedTo.push(nodeId);
          return { ok: true, status: 200, data: { accepted: true }, latency_ms: 10 };
        },
      );

      distributor = new WorkDistributor({
        meshManager: mesh,
        strategy: "round_robin",
        delegation_timeout_ms: 10_000,
        max_retries: 1,
      });

      // Submit three tasks concurrently
      const taskPromises = [
        distributor.distribute("Task 1: read config", "session-1"),
        distributor.distribute("Task 2: check deps", "session-1"),
        distributor.distribute("Task 3: lint code", "session-1"),
      ];

      // All three tasks should be in-flight
      // Give a tick for the promises to register
      await new Promise((r) => setTimeout(r, 50));
      expect(distributor.activeCount).toBe(3);

      // Verify tasks were distributed to different agents (round-robin)
      expect(delegatedTo).toHaveLength(3);
      // Round-robin should touch all three agents
      expect(new Set(delegatedTo).size).toBe(3);

      // Resolve the tasks by simulating results
      const activeDelegations = distributor.getActiveDelegations();
      for (const delegation of activeDelegations) {
        distributor.resolveTask(makeTaskResult({
          task_id: delegation.task_id,
          peer_node_id: delegation.peer_node_id,
          status: "completed",
        }));
      }

      // All tasks should now complete
      const results = await Promise.all(taskPromises);
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.status).toBe("completed");
      }

      // No active delegations remaining
      expect(distributor.activeCount).toBe(0);
    });

    it("distributes tasks based on capability matching", async () => {
      mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();

      // Specialized agents
      mesh.handleJoin(makeIdentity({
        node_id: "file-reader",
        capabilities: ["read-file", "write-file"],
      }));
      mesh.handleJoin(makeIdentity({
        node_id: "web-agent",
        capabilities: ["http-request", "browser"],
      }));

      vi.spyOn(mesh.getTransport(), "sendTaskRequest").mockResolvedValue({
        ok: true,
        status: 200,
        data: { accepted: true },
        latency_ms: 10,
      });

      distributor = new WorkDistributor({
        meshManager: mesh,
        strategy: "capability_match",
        delegation_timeout_ms: 10_000,
        max_retries: 1,
      });

      // Submit a task requiring read-file capability
      const taskPromise = distributor.distribute(
        "Read the package.json",
        "session-2",
        { tool_allowlist: ["read-file"] },
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(distributor.activeCount).toBe(1);

      // Verify the task was sent to the file-reader agent (capability match)
      const active = distributor.getActiveDelegations();
      expect(active).toHaveLength(1);
      expect(active[0]!.peer_node_id).toBe("file-reader");

      // Resolve and complete
      distributor.resolveTask(makeTaskResult({
        task_id: active[0]!.task_id,
        peer_node_id: "file-reader",
        status: "completed",
      }));

      const result = await taskPromise;
      expect(result.status).toBe("completed");
    });

    it("throws when no suitable peers are available", async () => {
      mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();

      // No agents in the mesh
      distributor = new WorkDistributor({
        meshManager: mesh,
        strategy: "round_robin",
        delegation_timeout_ms: 5_000,
        max_retries: 0,
      });

      await expect(
        distributor.distribute("Orphan task", "session-x"),
      ).rejects.toThrow("No suitable peers");
    });

    it("cancels active delegations cleanly", async () => {
      mesh = new MeshManager({ config: makeConfig() });
      await mesh.start();

      mesh.handleJoin(makeIdentity({ node_id: "cancel-peer" }));
      vi.spyOn(mesh.getTransport(), "sendTaskRequest").mockResolvedValue({
        ok: true,
        status: 200,
        data: { accepted: true },
        latency_ms: 10,
      });

      distributor = new WorkDistributor({
        meshManager: mesh,
        strategy: "round_robin",
        delegation_timeout_ms: 60_000,
        max_retries: 0,
      });

      const taskPromise = distributor.distribute("Long task", "session-c");
      await new Promise((r) => setTimeout(r, 50));
      expect(distributor.activeCount).toBe(1);

      // Cancel all active delegations
      distributor.cancelAll();
      expect(distributor.activeCount).toBe(0);

      // The task promise should reject
      await expect(taskPromise).rejects.toThrow("cancelled");
    });
  });
});
