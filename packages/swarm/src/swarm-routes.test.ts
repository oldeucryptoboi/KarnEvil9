import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSwarmRoutes } from "./swarm-routes.js";
import { MeshManager } from "./mesh-manager.js";
import { WorkDistributor } from "./work-distributor.js";
import type { SwarmConfig } from "./types.js";
import { DEFAULT_SWARM_CONFIG } from "./types.js";
import type { SwarmRoute as RouteType } from "./swarm-routes.js";

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

function makeRequest(overrides: Partial<{ method: string; path: string; params: Record<string, string>; query: Record<string, string>; body: unknown }> = {}) {
  return {
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/",
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body,
  };
}

function makeResponse() {
  let responseData: unknown;
  let statusCode: number | undefined;
  const res = {
    json: (data: unknown) => { responseData = data; },
    text: (data: string) => { responseData = data; },
    status: (code: number) => {
      statusCode = code;
      return {
        json: (data: unknown) => { responseData = data; },
        text: (data: string) => { responseData = data; },
      };
    },
    getData: () => responseData,
    getStatus: () => statusCode,
  };
  return res;
}

describe("createSwarmRoutes", () => {
  let mesh: MeshManager;
  let distributor: WorkDistributor;
  let routes: RouteType[];

  beforeEach(async () => {
    mesh = new MeshManager({ config: makeConfig() });
    await mesh.start();
    distributor = new WorkDistributor({
      meshManager: mesh,
      strategy: "round_robin",
      delegation_timeout_ms: 5000,
      max_retries: 2,
    });
    routes = createSwarmRoutes(mesh, distributor);
  });

  afterEach(async () => {
    distributor.cancelAll();
    await mesh.stop();
  });

  function findRoute(method: string, path: string): RouteType {
    const route = routes.find((r) => r.method === method && r.path.endsWith(path));
    if (!route) throw new Error(`Route ${method} ${path} not found`);
    return route;
  }

  it("should register 38 routes", () => {
    expect(routes).toHaveLength(38);
  });

  it("GET identity should return node identity", async () => {
    const route = findRoute("GET", "/identity");
    const res = makeResponse();
    await route.handler(makeRequest(), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.node_id).toBeTruthy();
    expect(data.display_name).toBe("karnevil9-node");
  });

  it("GET peers should return peer list", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });

    const route = findRoute("GET", "/peers");
    const res = makeResponse();
    await route.handler(makeRequest(), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.total).toBe(1);
    expect((data.peers as unknown[]).length).toBe(1);
  });

  it("GET peers should filter by status", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });
    mesh.handleLeave("peer-1");

    const route = findRoute("GET", "/peers");
    const res = makeResponse();
    await route.handler(makeRequest({ query: { status: "active" } }), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.total).toBe(0);
  });

  it("POST heartbeat should record heartbeat", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });

    const route = findRoute("POST", "/heartbeat");
    const res = makeResponse();
    await route.handler(makeRequest({ body: { node_id: "peer-1", timestamp: new Date().toISOString(), active_sessions: 1, load: 0.5 } }), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });

  it("POST heartbeat should reject unknown peer", async () => {
    const route = findRoute("POST", "/heartbeat");
    const res = makeResponse();
    await route.handler(makeRequest({ body: { node_id: "unknown", timestamp: new Date().toISOString(), active_sessions: 0, load: 0 } }), res);
    expect(res.getStatus()).toBe(404);
  });

  it("POST heartbeat should validate input", async () => {
    const route = findRoute("POST", "/heartbeat");
    const res = makeResponse();
    await route.handler(makeRequest({ body: {} }), res);
    expect(res.getStatus()).toBe(400);
  });

  it("POST join should add a peer", async () => {
    const route = findRoute("POST", "/join");
    const res = makeResponse();
    await route.handler(makeRequest({
      body: {
        identity: {
          node_id: "peer-1",
          display_name: "Peer 1",
          api_url: "http://peer-1:3100",
          capabilities: ["read-file"],
          version: "0.1.0",
        },
      },
    }), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(mesh.peerCount).toBe(1);
  });

  it("POST leave should mark peer as left", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });

    const route = findRoute("POST", "/leave");
    const res = makeResponse();
    await route.handler(makeRequest({ body: { node_id: "peer-1" } }), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(mesh.getPeer("peer-1")?.status).toBe("left");
  });

  it("POST gossip should exchange peer lists", async () => {
    mesh.handleJoin({
      node_id: "peer-1",
      display_name: "Peer 1",
      api_url: "http://peer-1:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    });

    const route = findRoute("POST", "/gossip");
    const res = makeResponse();
    await route.handler(makeRequest({
      body: {
        sender_node_id: "peer-1",
        peers: [{ node_id: "peer-2", api_url: "http://peer-2:3100", status: "active" }],
      },
    }), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.sender_node_id).toBeTruthy();
    expect((data.peers as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("POST task should validate input", async () => {
    const route = findRoute("POST", "/task");
    const res = makeResponse();
    await route.handler(makeRequest({ body: {} }), res);
    expect(res.getStatus()).toBe(400);
  });

  it("POST result should handle incoming results", async () => {
    const route = findRoute("POST", "/result");
    const res = makeResponse();
    await route.handler(makeRequest({
      body: {
        task_id: "task-1",
        peer_node_id: "peer-1",
        peer_session_id: "session-1",
        status: "completed",
        findings: [],
        tokens_used: 100,
        cost_usd: 0.01,
        duration_ms: 5000,
      },
    }), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });

  it("GET status should return swarm status", async () => {
    const route = findRoute("GET", "/status");
    const res = makeResponse();
    await route.handler(makeRequest(), res);
    const data = res.getData() as Record<string, unknown>;
    expect(data.running).toBe(true);
    expect(data.peer_count).toBe(0);
    expect(data.active_delegations).toBe(0);
  });

  it("GET task status should return 501 without provider", async () => {
    const route = findRoute("GET", "/task/:taskId/status");
    const res = makeResponse();
    await route.handler(makeRequest({ params: { taskId: "task-1" } }), res);
    expect(res.getStatus()).toBe(501);
  });

  it("POST task cancel should invoke mesh cancel handler", async () => {
    const route = findRoute("POST", "/task/:taskId/cancel");
    const res = makeResponse();
    await route.handler(makeRequest({ params: { taskId: "task-1" } }), res);
    const data = res.getData() as Record<string, unknown>;
    // meshManager.handleCancelTask exists but no onTaskCancel callback, so cancelled=false
    expect(data.cancelled).toBe(false);
  });

  it("POST trigger should return 501 without handler", async () => {
    const route = findRoute("POST", "/trigger");
    const res = makeResponse();
    await route.handler(makeRequest({ body: { type: "task_cancel", task_id: "t-1", timestamp: new Date().toISOString() } }), res);
    expect(res.getStatus()).toBe(501);
  });

  it("POST trigger should validate body", async () => {
    const route = findRoute("POST", "/trigger");
    const res = makeResponse();
    await route.handler(makeRequest({ body: {} }), res);
    expect(res.getStatus()).toBe(400);
  });
});
