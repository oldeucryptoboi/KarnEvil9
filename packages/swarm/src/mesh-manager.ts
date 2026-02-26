import { v4 as uuid } from "uuid";
import type { Journal } from "@karnevil9/journal";
import type {
  SwarmConfig,
  SwarmNodeIdentity,
  SwarmTaskRequest,
  SwarmTaskResult,
  HeartbeatMessage,
  GossipMessage,
  PeerEntry,
  AttestationChain,
} from "./types.js";
import { PeerTable } from "./peer-table.js";
import { PeerTransport } from "./transport.js";
import { PeerDiscovery } from "./discovery.js";
import { verifyAttestation, verifyChain } from "./attestation.js";
import type { WorkDistributor } from "./work-distributor.js";
import type { LiabilityFirebreak } from "./liability-firebreak.js";
import type { CognitiveFrictionEngine } from "./cognitive-friction.js";

export interface MeshManagerConfig {
  config: SwarmConfig;
  journal?: Journal;
  onTaskRequest?: (request: SwarmTaskRequest) => Promise<{ accepted: boolean; reason?: string }>;
  onTaskResult?: (result: SwarmTaskResult) => void;
  onTaskCancel?: (taskId: string) => Promise<{ cancelled: boolean }>;
}

export class MeshManager {
  private config: SwarmConfig;
  private journal?: Journal;
  private identity: SwarmNodeIdentity;
  private peerTable: PeerTable;
  private transport: PeerTransport;
  private discovery: PeerDiscovery;
  private onTaskRequest?: (request: SwarmTaskRequest) => Promise<{ accepted: boolean; reason?: string }>;
  private onTaskResult?: (result: SwarmTaskResult) => void;
  private onTaskCancel?: (taskId: string) => Promise<{ cancelled: boolean }>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private seenNonces = new Map<string, number>();
  private nonceCleanupTimer?: ReturnType<typeof setInterval>;
  private activeSessions = 0;
  private workDistributor?: WorkDistributor;
  private liabilityFirebreak?: LiabilityFirebreak;
  private cognitiveFriction?: CognitiveFrictionEngine;

  constructor(managerConfig: MeshManagerConfig) {
    this.config = managerConfig.config;
    this.journal = managerConfig.journal;
    this.onTaskRequest = managerConfig.onTaskRequest;
    this.onTaskResult = managerConfig.onTaskResult;
    this.onTaskCancel = managerConfig.onTaskCancel;

    this.identity = {
      node_id: uuid(),
      display_name: this.config.node_name,
      api_url: this.config.api_url,
      capabilities: this.config.capabilities,
      version: this.config.version,
    };

    this.peerTable = new PeerTable(this.config.max_peers);
    this.transport = new PeerTransport({
      token: this.config.token,
      timeout_ms: 10000,
    });
    this.discovery = new PeerDiscovery({
      mdns: this.config.mdns,
      seeds: this.config.seeds,
      gossip: this.config.gossip,
      localIdentity: this.identity,
      transport: this.transport,
      onPeerDiscovered: (peerIdentity) => this.handlePeerDiscovered(peerIdentity),
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.discovery.start();

    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      void this.sendHeartbeats().catch(() => {});
    }, this.config.heartbeat_interval_ms);
    this.heartbeatTimer.unref();

    this.sweepTimer = setInterval(() => {
      if (!this.running) return;
      this.runSweep();
    }, this.config.sweep_interval_ms);
    this.sweepTimer.unref();

    this.nonceCleanupTimer = setInterval(() => {
      if (!this.running) return;
      this.cleanupNonces();
    }, 60000);
    this.nonceCleanupTimer.unref();

    await this.emitEvent("swarm.started", {
      node_id: this.identity.node_id,
      display_name: this.identity.display_name,
      api_url: this.identity.api_url,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (this.nonceCleanupTimer) {
      clearInterval(this.nonceCleanupTimer);
      this.nonceCleanupTimer = undefined;
    }

    // Notify peers we're leaving
    const activePeers = this.peerTable.getActive();
    await Promise.allSettled(
      activePeers.map((peer) =>
        this.transport.sendLeave(peer.identity.api_url, {
          node_id: this.identity.node_id,
          reason: "shutdown",
        }),
      ),
    );

    await this.discovery.stop();
    this.peerTable.clear();
    this.seenNonces.clear();

    await this.emitEvent("swarm.stopped", { node_id: this.identity.node_id });
  }

  // ─── Message Handlers ─────────────────────────────────────────────

  handleJoin(identity: SwarmNodeIdentity): PeerEntry {
    const entry = this.peerTable.add(identity);
    this.discovery.markKnown(identity.node_id);
    void this.emitEvent("swarm.peer_joined", {
      peer_node_id: identity.node_id,
      peer_name: identity.display_name,
      peer_url: identity.api_url,
    }).catch(() => {});
    return entry;
  }

  handleLeave(nodeId: string): void {
    this.peerTable.markLeft(nodeId);
    void this.emitEvent("swarm.peer_left", { peer_node_id: nodeId }).catch(() => {});
  }

  handleHeartbeat(heartbeat: HeartbeatMessage, latencyMs: number): boolean {
    return this.peerTable.recordHeartbeat(heartbeat.node_id, latencyMs);
  }

  handleGossip(gossip: GossipMessage): GossipMessage {
    // Process incoming peers
    void this.discovery.processGossip(gossip.peers).catch(() => {});

    // Return our peer list
    const ourPeers = this.peerTable.getAll().map((p) => ({
      node_id: p.identity.node_id,
      api_url: p.identity.api_url,
      status: p.status,
    }));

    void this.emitEvent("swarm.gossip_round", {
      from: gossip.sender_node_id,
      peers_received: gossip.peers.length,
      peers_sent: ourPeers.length,
    }).catch(() => {});

    return {
      sender_node_id: this.identity.node_id,
      peers: ourPeers,
    };
  }

  async handleTaskRequest(request: SwarmTaskRequest): Promise<{ accepted: boolean; reason?: string }> {
    // Replay protection
    if (this.isNonceReplayed(request.nonce)) {
      return { accepted: false, reason: "Replayed nonce" };
    }
    this.recordNonce(request.nonce);

    // Depth check for transitive delegation
    const maxDepth = this.config.max_delegation_depth ?? 3;
    if (request.delegation_depth !== undefined && request.delegation_depth >= maxDepth) {
      return { accepted: false, reason: `Delegation depth ${request.delegation_depth} exceeds max ${maxDepth}` };
    }

    // Liability firebreak check (Gap 3)
    if (this.liabilityFirebreak && request.delegation_depth !== undefined) {
      const fbDecision = this.liabilityFirebreak.evaluate(
        request.delegation_depth,
        request.task_attributes,
      );
      if (fbDecision.action === "halt") {
        return { accepted: false, reason: `Firebreak halt: ${fbDecision.reason}` };
      }
    }

    if (!this.onTaskRequest) {
      return { accepted: false, reason: "Node does not accept tasks" };
    }

    const result = await this.onTaskRequest(request);
    if (result.accepted) {
      void this.emitEvent("swarm.task_accepted", {
        task_id: request.task_id,
        originator_node_id: request.originator_node_id,
        correlation_id: request.correlation_id,
        delegation_depth: request.delegation_depth,
      }).catch(() => {});
    }
    return result;
  }

  handleTaskResult(result: SwarmTaskResult): void {
    // Verify attestation if token is configured and attestation is present
    if (this.config.token && result.attestation) {
      const valid = verifyAttestation(result.attestation, this.config.token);
      if (!valid) {
        void this.emitEvent("swarm.task_result_received", {
          task_id: result.task_id,
          peer_node_id: result.peer_node_id,
          status: result.status,
          attestation_valid: false,
          warning: "Attestation verification failed",
        }).catch(() => {});
      }
    }

    // Verify attestation chain if present
    if (this.config.token && result.attestation_chain) {
      const chainResult = verifyChain(result.attestation_chain, this.config.token);
      if (!chainResult.valid) {
        void this.emitEvent("swarm.attestation_chain_invalid", {
          task_id: result.task_id,
          peer_node_id: result.peer_node_id,
          invalid_at_depth: chainResult.invalid_at_depth,
        }).catch(() => {});
      }
    }

    void this.emitEvent("swarm.task_result_received", {
      task_id: result.task_id,
      peer_node_id: result.peer_node_id,
      status: result.status,
      findings_count: result.findings.length,
      tokens_used: result.tokens_used,
      cost_usd: result.cost_usd,
      duration_ms: result.duration_ms,
    }).catch(() => {});

    if (this.onTaskResult) {
      this.onTaskResult(result);
    }
  }

  handleCancelTask(taskId: string): { cancelled: boolean } {
    if (!this.onTaskCancel) {
      return { cancelled: false };
    }
    // Fire and forget — the cancel is async but the route handler needs a sync response
    void this.onTaskCancel(taskId).catch(() => {});
    return { cancelled: true };
  }

  // ─── Task Delegation ──────────────────────────────────────────────

  async delegateTask(
    peerNodeId: string,
    taskText: string,
    sessionId: string,
    constraints?: SwarmTaskRequest["constraints"],
    parentChain?: AttestationChain,
    priority?: number,
    taskAttributes?: import("./types.js").TaskAttribute,
    peerTrustScore?: number,
  ): Promise<{ accepted: boolean; taskId: string; reason?: string }> {
    const peer = this.peerTable.get(peerNodeId);
    if (!peer || peer.status !== "active") {
      return { accepted: false, taskId: "", reason: "Peer not active" };
    }

    // Cognitive friction check (Gap 7)
    if (this.cognitiveFriction && taskAttributes) {
      const currentDepth = parentChain ? parentChain.depth : 0;
      const maxDepth = this.config.max_delegation_depth ?? 3;
      const trust = peerTrustScore ?? 0.5;
      const assessment = this.cognitiveFriction.assess(taskAttributes, currentDepth, trust, maxDepth);
      if (assessment.level === "mandatory_human") {
        return { accepted: false, taskId: "", reason: `Cognitive friction: mandatory human review required — ${assessment.reason}` };
      }
    }

    const taskId = uuid();
    const currentDepth = parentChain ? parentChain.depth : 0;
    const request: SwarmTaskRequest = {
      task_id: taskId,
      originator_node_id: this.identity.node_id,
      originator_session_id: sessionId,
      task_text: taskText,
      constraints,
      correlation_id: uuid(),
      nonce: uuid(),
      parent_attestation_chain: parentChain,
      delegation_depth: currentDepth,
      priority,
    };

    void this.emitEvent("swarm.task_delegated", {
      task_id: taskId,
      peer_node_id: peerNodeId,
      correlation_id: request.correlation_id,
      task_text: taskText.slice(0, 200),
    }).catch(() => {});

    const response = await this.transport.sendTaskRequest(peer.identity.api_url, request);
    if (!response.ok || !response.data?.accepted) {
      const reason = response.data?.reason ?? response.error ?? "Unknown error";
      void this.emitEvent("swarm.task_delegation_failed", {
        task_id: taskId,
        peer_node_id: peerNodeId,
        reason,
      }).catch(() => {});
      return { accepted: false, taskId, reason };
    }

    return { accepted: true, taskId };
  }

  // ─── Accessors ────────────────────────────────────────────────────

  getIdentity(): SwarmNodeIdentity {
    return { ...this.identity };
  }

  getPeers(): PeerEntry[] {
    return this.peerTable.getAll();
  }

  getActivePeers(): PeerEntry[] {
    return this.peerTable.getActive();
  }

  getPeersByCapability(capability: string): PeerEntry[] {
    return this.peerTable.getByCapability(capability);
  }

  getPeer(nodeId: string): PeerEntry | undefined {
    return this.peerTable.get(nodeId);
  }

  get peerCount(): number {
    return this.peerTable.size;
  }

  getSwarmToken(): string | undefined {
    return this.config.token;
  }

  get isRunning(): boolean {
    return this.running;
  }

  setActiveSessions(count: number): void {
    this.activeSessions = count;
  }

  setWorkDistributor(wd: WorkDistributor): void {
    this.workDistributor = wd;
  }

  setLiabilityFirebreak(fb: LiabilityFirebreak): void {
    this.liabilityFirebreak = fb;
  }

  setCognitiveFriction(cf: CognitiveFrictionEngine): void {
    this.cognitiveFriction = cf;
  }

  getTransport(): PeerTransport {
    return this.transport;
  }

  getDiscovery(): PeerDiscovery {
    return this.discovery;
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private handlePeerDiscovered(peerIdentity: SwarmNodeIdentity): void {
    this.peerTable.add(peerIdentity);
    // Announce ourselves to newly discovered peer
    void this.transport.sendJoin(peerIdentity.api_url, { identity: this.identity }).catch(() => {});
    void this.emitEvent("swarm.peer_joined", {
      peer_node_id: peerIdentity.node_id,
      peer_name: peerIdentity.display_name,
      peer_url: peerIdentity.api_url,
      via: "discovery",
    }).catch(() => {});
  }

  private async sendHeartbeats(): Promise<void> {
    const activePeers = this.peerTable.getActive();
    const heartbeat: HeartbeatMessage = {
      node_id: this.identity.node_id,
      timestamp: new Date().toISOString(),
      active_sessions: this.activeSessions,
      load: 0,
    };

    await Promise.allSettled(
      activePeers.map(async (peer) => {
        const response = await this.transport.sendHeartbeat(peer.identity.api_url, heartbeat);
        if (response.ok) {
          this.peerTable.recordHeartbeat(peer.identity.node_id, response.latency_ms);
        } else {
          this.peerTable.recordFailure(peer.identity.node_id);
        }
      }),
    );
  }

  private runSweep(): void {
    const result = this.peerTable.sweep({
      suspected_after_ms: this.config.suspected_after_ms,
      unreachable_after_ms: this.config.unreachable_after_ms,
      evict_after_ms: this.config.evict_after_ms,
    });

    for (const nodeId of result.suspected) {
      void this.emitEvent("swarm.peer_suspected", { peer_node_id: nodeId }).catch(() => {});
    }
    for (const nodeId of result.unreachable) {
      void this.emitEvent("swarm.peer_unreachable", { peer_node_id: nodeId }).catch(() => {});
      this.discovery.forget(nodeId);
    }

    // Trigger redelegation for suspected + unreachable peers
    const degradedPeerIds = [...result.suspected, ...result.unreachable];
    if (degradedPeerIds.length > 0 && this.workDistributor) {
      void this.workDistributor.handlePeerDegradation(degradedPeerIds).catch(() => {});
    }
  }

  private isNonceReplayed(nonce: string): boolean {
    return this.seenNonces.has(nonce);
  }

  private recordNonce(nonce: string): void {
    this.seenNonces.set(nonce, Date.now());
  }

  private cleanupNonces(): void {
    const cutoff = Date.now() - this.config.nonce_window_ms;
    for (const [nonce, timestamp] of this.seenNonces) {
      if (timestamp < cutoff) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  private async emitEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.journal) return;
    try {
      await this.journal.emit(
        `swarm:${this.identity.node_id}`,
        type as import("@karnevil9/schemas").JournalEventType,
        payload,
      );
    } catch {
      // Journal write failure should not crash swarm operations
    }
  }
}
