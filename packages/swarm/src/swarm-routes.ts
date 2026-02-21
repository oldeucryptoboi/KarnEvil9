import type { RouteHandler } from "@karnevil9/schemas";
import type { MeshManager } from "./mesh-manager.js";
import type { WorkDistributor } from "./work-distributor.js";
import type { ReputationStore } from "./reputation-store.js";
import type { ContractStore } from "./delegation-contract.js";
import type { ExternalTriggerHandler } from "./external-trigger-handler.js";
import type { MonitoringStream, SSEResponse } from "./monitoring-stream.js";
import type { AnomalyDetector } from "./anomaly-detector.js";
import type { DisputeStore } from "./dispute-store.js";
import type { CredentialVerifier } from "./credential-verifier.js";
import type { DCTManager } from "./delegation-capability-token.js";
import type { SybilDetector } from "./sybil-detector.js";
import type { TaskAuction } from "./task-auction.js";
import type { EscrowManager } from "./escrow-manager.js";
import type { ConsensusVerifier } from "./consensus-verifier.js";
import type { CheckpointSerializer } from "./checkpoint-serializer.js";
import type {
  SwarmTaskRequest,
  SwarmTaskResult,
  HeartbeatMessage,
  GossipMessage,
  JoinMessage,
  LeaveMessage,
  ContractStatus,
  TaskCheckpointStatus,
  ExternalTrigger,
  MonitoringEventType,
  MonitoringLevel,
  TaskRFQ,
  BidObject,
  ProofOfWork,
  ContractSLO,
} from "./types.js";

export interface SwarmRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

export function createSwarmRoutes(
  meshManager: MeshManager,
  workDistributor?: WorkDistributor,
  swarmToken?: string,
  reputationStore?: ReputationStore,
  contractStore?: ContractStore,
  taskStatusProvider?: (taskId: string) => Promise<TaskCheckpointStatus | null>,
  externalTriggerHandler?: ExternalTriggerHandler,
  monitoringStream?: MonitoringStream,
  anomalyDetector?: AnomalyDetector,
  disputeStore?: DisputeStore,
  credentialVerifier?: CredentialVerifier,
  dctManager?: DCTManager,
  sybilDetector?: SybilDetector,
  taskAuction?: TaskAuction,
  escrowManager?: EscrowManager,
  consensusVerifier?: ConsensusVerifier,
  checkpointSerializer?: CheckpointSerializer,
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

    // Early depth check
    const maxDepth = meshManager.getSwarmToken() ? 3 : 3; // from config default
    if (body.delegation_depth !== undefined && body.delegation_depth >= maxDepth) {
      res.json({ accepted: false, reason: `Delegation depth ${body.delegation_depth} exceeds max ${maxDepth}` });
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

  // ─── Reputation Routes ──────────────────────────────────────────────

  const reputationList: RouteHandler = async (_req, res) => {
    if (!reputationStore) {
      res.json({ reputations: [], total: 0 });
      return;
    }
    const all = reputationStore.getAllReputations();
    res.json({ reputations: all, total: all.length });
  };

  const reputationGet: RouteHandler = async (req, res) => {
    if (!reputationStore) {
      res.status(404).json({ error: "Reputation store not configured" });
      return;
    }
    const nodeId = req.params.nodeId;
    if (!nodeId) {
      res.status(400).json({ error: "nodeId parameter is required" });
      return;
    }
    const rep = reputationStore.getReputation(nodeId);
    if (!rep) {
      res.json({ node_id: nodeId, trust_score: reputationStore.getTrustScore(nodeId) });
      return;
    }
    res.json(rep);
  };

  // ─── Contract Routes ──────────────────────────────────────────────

  const contractList: RouteHandler = async (req, res) => {
    if (!contractStore) {
      res.json({ contracts: [], total: 0 });
      return;
    }
    const statusFilter = req.query.status as ContractStatus | undefined;
    const contracts = statusFilter
      ? contractStore.getByStatus(statusFilter)
      : contractStore.getAll();
    res.json({ contracts, total: contracts.length });
  };

  const contractGet: RouteHandler = async (req, res) => {
    if (!contractStore) {
      res.status(404).json({ error: "Contract store not configured" });
      return;
    }
    const contractId = req.params.contractId;
    if (!contractId) {
      res.status(400).json({ error: "contractId parameter is required" });
      return;
    }
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: "Contract not found" });
      return;
    }
    res.json(contract);
  };

  // ─── Task Status Route (checkpoint polling) ────────────────────────

  const taskStatus: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const taskId = req.params.taskId;
    if (!taskId) {
      res.status(400).json({ error: "taskId parameter is required" });
      return;
    }
    if (!taskStatusProvider) {
      res.status(501).json({ error: "Task status provider not configured" });
      return;
    }
    const status_data = await taskStatusProvider(taskId);
    if (!status_data) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(status_data);
  };

  // ─── Task Cancel Route ────────────────────────────────────────────

  const taskCancel: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const taskId = req.params.taskId;
    if (!taskId) {
      res.status(400).json({ error: "taskId parameter is required" });
      return;
    }
    const result = meshManager.handleCancelTask(taskId);
    res.json(result);
  };

  // ─── Trigger Dispatch Route ───────────────────────────────────────

  const triggerDispatch: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const body = req.body as ExternalTrigger | undefined;
    if (!body || typeof body.type !== "string") {
      res.status(400).json({ error: "trigger type is required" });
      return;
    }
    if (!externalTriggerHandler) {
      res.status(501).json({ error: "External trigger handler not configured" });
      return;
    }
    const result = await externalTriggerHandler.dispatch(body);
    res.json(result);
  };

  // ─── SSE Events Route ──────────────────────────────────────────────

  const eventsSSE: RouteHandler = async (req, res) => {
    if (!monitoringStream) {
      res.status(501).json({ error: "SSE monitoring not configured" });
      return;
    }
    // Parse filter params
    const filter: { task_id?: string; peer_node_id?: string; event_types?: MonitoringEventType[]; level?: MonitoringLevel } = {};
    if (req.query.task_id) filter.task_id = req.query.task_id as string;
    if (req.query.peer_node_id) filter.peer_node_id = req.query.peer_node_id as string;
    if (req.query.types) {
      filter.event_types = (req.query.types as string).split(",") as MonitoringEventType[];
    }
    if (req.query.level) {
      filter.level = req.query.level as MonitoringLevel;
    }
    monitoringStream.subscribe(res as unknown as SSEResponse, filter);
  };

  // ─── Anomaly Routes ──────────────────────────────────────────────

  const anomaliesList: RouteHandler = async (_req, res) => {
    if (!anomalyDetector) {
      res.json({ anomalies: [], total: 0 });
      return;
    }
    const reports = anomalyDetector.getRecentReports();
    res.json({ anomalies: reports, total: reports.length });
  };

  const quarantineAdd: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!anomalyDetector) {
      res.status(501).json({ error: "Anomaly detector not configured" });
      return;
    }
    const nodeId = req.params.nodeId;
    if (!nodeId) {
      res.status(400).json({ error: "nodeId parameter is required" });
      return;
    }
    anomalyDetector.quarantinePeer(nodeId);
    res.json({ ok: true, quarantined: nodeId });
  };

  const quarantineRemove: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!anomalyDetector) {
      res.status(501).json({ error: "Anomaly detector not configured" });
      return;
    }
    const nodeId = req.params.nodeId;
    if (!nodeId) {
      res.status(400).json({ error: "nodeId parameter is required" });
      return;
    }
    anomalyDetector.unquarantinePeer(nodeId);
    res.json({ ok: true, unquarantined: nodeId });
  };

  // ─── Credential Routes ──────────────────────────────────────────

  const credentialsGet: RouteHandler = async (req, res) => {
    if (!credentialVerifier) {
      res.json({ credentials: [] });
      return;
    }
    const nodeId = req.params.nodeId;
    if (!nodeId) {
      res.status(400).json({ error: "nodeId parameter is required" });
      return;
    }
    const peer = meshManager.getPeer(nodeId);
    res.json({ credentials: peer?.identity.credentials ?? [] });
  };

  // ─── DCT Routes ──────────────────────────────────────────────────

  const tokensList: RouteHandler = async (_req, res) => {
    if (!dctManager) {
      res.json({ tokens: [], total: 0 });
      return;
    }
    const tokens = dctManager.getActiveTokens();
    res.json({ tokens, total: tokens.length });
  };

  const tokenRevoke: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!dctManager) {
      res.status(501).json({ error: "DCT manager not configured" });
      return;
    }
    const dctId = req.params.dctId;
    if (!dctId) {
      res.status(400).json({ error: "dctId parameter is required" });
      return;
    }
    dctManager.revoke(dctId);
    res.json({ ok: true, revoked: dctId });
  };

  // ─── Sybil Routes ─────────────────────────────────────────────────

  const sybilReports: RouteHandler = async (_req, res) => {
    if (!sybilDetector) {
      res.json({ reports: [], total: 0 });
      return;
    }
    const reports = sybilDetector.getReports();
    res.json({ reports, total: reports.length });
  };

  const powVerify: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!sybilDetector) {
      res.status(501).json({ error: "Sybil detector not configured" });
      return;
    }
    const body = req.body as ProofOfWork | undefined;
    if (!body || typeof body.challenge !== "string" || typeof body.solution !== "string") {
      res.status(400).json({ error: "challenge and solution are required" });
      return;
    }
    const valid = sybilDetector.verifyProofOfWork(body);
    res.json({ valid });
  };

  // ─── Auction Routes ───────────────────────────────────────────────

  const rfqReceive: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    const body = req.body as TaskRFQ | undefined;
    if (!body || typeof body.rfq_id !== "string") {
      res.status(400).json({ error: "rfq_id is required" });
      return;
    }
    // Acknowledge receipt — local bidding would be handled asynchronously
    res.json({ received: true, rfq_id: body.rfq_id });
  };

  const bidReceive: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!taskAuction) {
      res.status(501).json({ error: "Task auction not configured" });
      return;
    }
    const body = req.body as BidObject | undefined;
    if (!body || typeof body.bid_id !== "string" || typeof body.rfq_id !== "string") {
      res.status(400).json({ error: "bid_id and rfq_id are required" });
      return;
    }
    const result = taskAuction.receiveBid(body);
    res.json(result);
  };

  const auctionsList: RouteHandler = async (_req, res) => {
    if (!taskAuction) {
      res.json({ auctions: [], total: 0 });
      return;
    }
    const auctions = taskAuction.getActiveAuctions();
    res.json({ auctions, total: auctions.length });
  };

  // ─── Phase 5 Routes ────────────────────────────────────────────────

  // Escrow routes
  const escrowBalance: RouteHandler = async (req, res) => {
    if (!escrowManager) {
      res.json({ balance: 0, held: 0, free: 0 });
      return;
    }
    const nodeId = req.params.nodeId;
    if (!nodeId) {
      res.status(400).json({ error: "nodeId parameter is required" });
      return;
    }
    const account = escrowManager.getAccount(nodeId);
    if (!account) {
      res.json({ node_id: nodeId, balance: 0, held: 0, free: 0 });
      return;
    }
    res.json({ node_id: nodeId, balance: account.balance, held: account.held, free: account.balance - account.held });
  };

  const escrowDeposit: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!escrowManager) {
      res.status(501).json({ error: "Escrow manager not configured" });
      return;
    }
    const body = req.body as { node_id?: string; amount?: number } | undefined;
    if (!body || typeof body.node_id !== "string" || typeof body.amount !== "number") {
      res.status(400).json({ error: "node_id and amount are required" });
      return;
    }
    try {
      const account = escrowManager.deposit(body.node_id, body.amount);
      res.json({ ok: true, balance: account.balance, held: account.held });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  };

  // Consensus routes
  const consensusCreate: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!consensusVerifier) {
      res.status(501).json({ error: "Consensus verifier not configured" });
      return;
    }
    const taskId = req.params.taskId;
    if (!taskId) {
      res.status(400).json({ error: "taskId parameter is required" });
      return;
    }
    const body = req.body as { required_voters?: number; required_agreement?: number } | undefined;
    const round = consensusVerifier.createRound(taskId, body?.required_voters, body?.required_agreement);
    res.json({ round_id: round.round_id, task_id: round.task_id, status: round.status, required_voters: round.required_voters });
  };

  const consensusVote: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!consensusVerifier) {
      res.status(501).json({ error: "Consensus verifier not configured" });
      return;
    }
    const taskId = req.params.taskId;
    if (!taskId) {
      res.status(400).json({ error: "taskId parameter is required" });
      return;
    }
    const body = req.body as { node_id?: string; result_hash?: string; outcome_score?: number } | undefined;
    if (!body || typeof body.node_id !== "string" || typeof body.result_hash !== "string") {
      res.status(400).json({ error: "node_id and result_hash are required" });
      return;
    }
    const round = consensusVerifier.getRoundByTaskId(taskId);
    if (!round) {
      res.status(404).json({ error: "No consensus round for this task" });
      return;
    }
    const result = consensusVerifier.submitVerification(round.round_id, body.node_id, body.result_hash, body.outcome_score ?? 0);
    res.json(result);
  };

  const consensusStatus: RouteHandler = async (req, res) => {
    if (!consensusVerifier) {
      res.status(501).json({ error: "Consensus verifier not configured" });
      return;
    }
    const taskId = req.params.taskId;
    if (!taskId) {
      res.status(400).json({ error: "taskId parameter is required" });
      return;
    }
    const round = consensusVerifier.getRoundByTaskId(taskId);
    if (!round) {
      res.status(404).json({ error: "No consensus round for this task" });
      return;
    }
    // Convert Map to object for JSON serialization
    const votes: Record<string, unknown> = {};
    for (const [nodeId, vote] of round.votes) {
      votes[nodeId] = vote;
    }
    res.json({ round_id: round.round_id, task_id: round.task_id, status: round.status, votes, outcome: round.outcome });
  };

  // Renegotiation routes
  const contractRenegotiate: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!contractStore) {
      res.status(501).json({ error: "Contract store not configured" });
      return;
    }
    const contractId = req.params.contractId;
    if (!contractId) {
      res.status(400).json({ error: "contractId parameter is required" });
      return;
    }
    const body = req.body as { requester_node_id?: string; proposed_slo?: Record<string, unknown>; reason?: string } | undefined;
    if (!body || typeof body.requester_node_id !== "string" || typeof body.reason !== "string") {
      res.status(400).json({ error: "requester_node_id and reason are required" });
      return;
    }
    const request = contractStore.requestRenegotiation(contractId, body.requester_node_id, (body.proposed_slo ?? {}) as Partial<ContractSLO>, body.reason);
    if (!request) {
      res.status(400).json({ error: "Cannot renegotiate: contract not active or renegotiation already pending" });
      return;
    }
    res.json(request);
  };

  const contractRenegotiateAccept: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!contractStore) {
      res.status(501).json({ error: "Contract store not configured" });
      return;
    }
    const { contractId, requestId } = req.params;
    if (!contractId || !requestId) {
      res.status(400).json({ error: "contractId and requestId parameters are required" });
      return;
    }
    const outcome = contractStore.acceptRenegotiation(contractId, requestId);
    if (!outcome) {
      res.status(404).json({ error: "Renegotiation request not found or already resolved" });
      return;
    }
    res.json(outcome);
  };

  const contractRenegotiateReject: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!contractStore) {
      res.status(501).json({ error: "Contract store not configured" });
      return;
    }
    const { contractId, requestId } = req.params;
    if (!contractId || !requestId) {
      res.status(400).json({ error: "contractId and requestId parameters are required" });
      return;
    }
    const body = req.body as { reason?: string } | undefined;
    const outcome = contractStore.rejectRenegotiation(contractId, requestId, body?.reason);
    if (!outcome) {
      res.status(404).json({ error: "Renegotiation request not found or already resolved" });
      return;
    }
    res.json(outcome);
  };

  const contractRenegotiationList: RouteHandler = async (req, res) => {
    if (!contractStore) {
      res.json({ renegotiations: [] });
      return;
    }
    const contractId = req.params.contractId;
    if (!contractId) {
      res.status(400).json({ error: "contractId parameter is required" });
      return;
    }
    const history = contractStore.getRenegotiationHistory(contractId);
    const pending = contractStore.getPendingRenegotiation(contractId);
    res.json({ renegotiations: history, pending: pending ?? null });
  };

  // Checkpoint routes
  const taskCheckpoints: RouteHandler = async (req, res) => {
    if (requireToken(req, res)) return;
    if (!checkpointSerializer) {
      res.json({ checkpoints: [], can_resume: false });
      return;
    }
    const taskId = req.params.taskId;
    if (!taskId) {
      res.status(400).json({ error: "taskId parameter is required" });
      return;
    }
    const checkpoints = checkpointSerializer.getAll(taskId);
    const canResume = checkpointSerializer.canResume(taskId);
    const latest = checkpointSerializer.getLatest(taskId);
    res.json({ checkpoints, can_resume: canResume, latest: latest ?? null });
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
    { method: "GET", path: "/plugins/swarm/reputation", handler: reputationList },
    { method: "GET", path: "/plugins/swarm/reputation/:nodeId", handler: reputationGet },
    { method: "GET", path: "/plugins/swarm/contracts", handler: contractList },
    { method: "GET", path: "/plugins/swarm/contracts/:contractId", handler: contractGet },
    { method: "GET", path: "/plugins/swarm/task/:taskId/status", handler: taskStatus },
    { method: "POST", path: "/plugins/swarm/task/:taskId/cancel", handler: taskCancel },
    { method: "POST", path: "/plugins/swarm/trigger", handler: triggerDispatch },
    { method: "GET", path: "/plugins/swarm/events", handler: eventsSSE },
    { method: "GET", path: "/plugins/swarm/anomalies", handler: anomaliesList },
    { method: "POST", path: "/plugins/swarm/quarantine/:nodeId", handler: quarantineAdd },
    { method: "DELETE", path: "/plugins/swarm/quarantine/:nodeId", handler: quarantineRemove },
    { method: "GET", path: "/plugins/swarm/credentials/:nodeId", handler: credentialsGet },
    { method: "GET", path: "/plugins/swarm/tokens", handler: tokensList },
    { method: "POST", path: "/plugins/swarm/tokens/:dctId/revoke", handler: tokenRevoke },
    { method: "GET", path: "/plugins/swarm/sybil-reports", handler: sybilReports },
    { method: "POST", path: "/plugins/swarm/pow-verify", handler: powVerify },
    { method: "POST", path: "/plugins/swarm/rfq", handler: rfqReceive },
    { method: "POST", path: "/plugins/swarm/bid", handler: bidReceive },
    { method: "GET", path: "/plugins/swarm/auctions", handler: auctionsList },
    // Phase 5 routes
    { method: "GET", path: "/plugins/swarm/escrow/:nodeId", handler: escrowBalance },
    { method: "POST", path: "/plugins/swarm/escrow/deposit", handler: escrowDeposit },
    { method: "POST", path: "/plugins/swarm/verify/:taskId/consensus", handler: consensusCreate },
    { method: "POST", path: "/plugins/swarm/verify/:taskId/vote", handler: consensusVote },
    { method: "GET", path: "/plugins/swarm/verify/:taskId/consensus", handler: consensusStatus },
    { method: "POST", path: "/plugins/swarm/contracts/:contractId/renegotiate", handler: contractRenegotiate },
    { method: "POST", path: "/plugins/swarm/contracts/:contractId/renegotiations/:requestId/accept", handler: contractRenegotiateAccept },
    { method: "POST", path: "/plugins/swarm/contracts/:contractId/renegotiations/:requestId/reject", handler: contractRenegotiateReject },
    { method: "GET", path: "/plugins/swarm/contracts/:contractId/renegotiations", handler: contractRenegotiationList },
    { method: "GET", path: "/plugins/swarm/task/:taskId/checkpoints", handler: taskCheckpoints },
  ];
}
