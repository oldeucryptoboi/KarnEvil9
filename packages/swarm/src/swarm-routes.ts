import type { RouteHandler } from "@karnevil9/schemas";
import type { MeshManager } from "./mesh-manager.js";
import type { WorkDistributor } from "./work-distributor.js";
import type { SwarmTaskRequest, SwarmTaskResult, HeartbeatMessage, GossipMessage, JoinMessage, LeaveMessage } from "./types.js";

export interface SwarmRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

export function createSwarmRoutes(
  meshManager: MeshManager,
  workDistributor?: WorkDistributor,
  swarmToken?: string,
): SwarmRoute[] {
  const identity: RouteHandler = async (_req, res) => {
    res.json(meshManager.getIdentity());
  };

  const peers: RouteHandler = async (req, res) => {
    let peerList = meshManager.getPeers();
    const statusFilter = req.query.status;
    if (statusFilter) {
      peerList = peerList.filter((p) => p.status === statusFilter);
    }
    res.json({
      self: meshManager.getIdentity(),
      peers: peerList.map((p) => ({
        node_id: p.identity.node_id,
        display_name: p.identity.display_name,
        api_url: p.identity.api_url,
        capabilities: p.identity.capabilities,
        status: p.status,
        last_heartbeat_at: p.last_heartbeat_at,
        last_latency_ms: p.last_latency_ms,
        joined_at: p.joined_at,
      })),
      total: peerList.length,
    });
  };

  /** Reject request if swarm token is configured and not provided. */
  const requireToken = (req: Parameters<RouteHandler>[0], res: Parameters<RouteHandler>[1]): boolean => {
    if (!swarmToken) return false; // no token configured — open mesh
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== swarmToken) {
      res.status(401).json({ error: "Unauthorized: invalid or missing swarm token" });
      return true; // rejected
    }
    return false;
  };

  const heartbeat: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const body = req.body as HeartbeatMessage | undefined;
    if (!body || typeof body.node_id !== "string") {
      res.status(400).json({ error: "node_id is required" });
      return;
    }
    const recorded = meshManager.handleHeartbeat(body, 0);
    if (!recorded) {
      res.status(404).json({ error: "Unknown peer" });
      return;
    }
    res.json({ ok: true });
  };

  const join: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const body = req.body as JoinMessage | undefined;
    if (!body?.identity || typeof body.identity.node_id !== "string") {
      res.status(400).json({ error: "identity with node_id is required" });
      return;
    }
    const entry = meshManager.handleJoin(body.identity);
    res.json({ ok: true, status: entry.status });
  };

  const leave: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const body = req.body as LeaveMessage | undefined;
    if (!body || typeof body.node_id !== "string") {
      res.status(400).json({ error: "node_id is required" });
      return;
    }
    meshManager.handleLeave(body.node_id);
    res.json({ ok: true });
  };

  const gossip: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const body = req.body as GossipMessage | undefined;
    if (!body || typeof body.sender_node_id !== "string" || !Array.isArray(body.peers)) {
      res.status(400).json({ error: "sender_node_id and peers[] are required" });
      return;
    }
    const response = meshManager.handleGossip(body);
    res.json(response);
  };

  const taskHandler: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const body = req.body as SwarmTaskRequest | undefined;
    if (!body || typeof body.task_id !== "string" || typeof body.task_text !== "string") {
      res.status(400).json({ error: "task_id and task_text are required" });
      return;
    }
    if (typeof body.nonce !== "string") {
      res.status(400).json({ error: "nonce is required" });
      return;
    }
    const result = await meshManager.handleTaskRequest(body);
    if (result.accepted) {
      res.json({ accepted: true });
    } else {
      res.json({ accepted: false, reason: result.reason });
    }
  };

  const resultHandler: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const body = req.body as SwarmTaskResult | undefined;
    if (!body || typeof body.task_id !== "string") {
      res.status(400).json({ error: "task_id is required" });
      return;
    }
    meshManager.handleTaskResult(body);
    if (workDistributor) {
      workDistributor.resolveTask(body);
    }
    res.json({ ok: true });
  };

  const status: RouteHandler = async (_req, res) => {
    res.json({
      running: meshManager.isRunning,
      node_id: meshManager.getIdentity().node_id,
      display_name: meshManager.getIdentity().display_name,
      peer_count: meshManager.peerCount,
      active_peers: meshManager.getActivePeers().length,
      active_delegations: workDistributor?.activeCount ?? 0,
    });
  };

  return [
    { method: "GET", path: "/plugins/swarm/identity", handler: identity },
    { method: "GET", path: "/plugins/swarm/peers", handler: peers },
    { method: "POST", path: "/plugins/swarm/heartbeat", handler: heartbeat },
    { method: "POST", path: "/plugins/swarm/join", handler: join },
    { method: "POST", path: "/plugins/swarm/leave", handler: leave },
    { method: "POST", path: "/plugins/swarm/gossip", handler: gossip },
    { method: "POST", path: "/plugins/swarm/task", handler: taskHandler },
    { method: "POST", path: "/plugins/swarm/result", handler: resultHandler },
    { method: "GET", path: "/plugins/swarm/status", handler: status },
  ];
}
