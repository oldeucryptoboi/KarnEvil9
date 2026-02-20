import { v4 as uuid } from "uuid";
import type {
  SwarmTaskResult,
  ActiveDelegation,
  DistributionStrategy,
  PeerEntry,
  SwarmTaskConstraints,
  ContractSLO,
  ContractMonitoring,
  ContractPermissionBoundary,
  SelectionWeights,
  AttestationChain,
} from "./types.js";
import { DEFAULT_SELECTION_WEIGHTS } from "./types.js";
import type { MeshManager } from "./mesh-manager.js";
import type { ReputationStore } from "./reputation-store.js";
import type { ContractStore } from "./delegation-contract.js";
import type { RedelegationMonitor } from "./redelegation-monitor.js";
import type { TaskMonitor } from "./task-monitor.js";
import type { GraduatedAuthorityConfig } from "./graduated-authority.js";
import { authorityFromTrust } from "./graduated-authority.js";
import { verifyChain } from "./attestation.js";
import { scorePeersForPareto, paretoSelect } from "./pareto-selector.js";
import type { TaskAuction } from "./task-auction.js";
import type { JournalEventType } from "@karnevil9/schemas";

export interface WorkDistributorConfig {
  meshManager: MeshManager;
  strategy: DistributionStrategy;
  delegation_timeout_ms: number;
  max_retries: number;
  reputationStore?: ReputationStore;
  contractStore?: ContractStore;
  redelegationMonitor?: RedelegationMonitor;
  taskMonitor?: TaskMonitor;
  emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  selectionWeights?: SelectionWeights;
  graduatedAuthorityConfig?: Partial<GraduatedAuthorityConfig>;
  taskAuction?: TaskAuction;
}

export class WorkDistributor {
  private meshManager: MeshManager;
  private strategy: DistributionStrategy;
  private delegationTimeoutMs: number;
  private maxRetries: number;
  private activeDelegations = new Map<string, ActiveDelegation>();
  private roundRobinIndex = 0;
  private reputationStore?: ReputationStore;
  private contractStore?: ContractStore;
  private redelegationMonitor?: RedelegationMonitor;
  private taskMonitor?: TaskMonitor;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  private selectionWeights: SelectionWeights;
  private graduatedAuthorityConfig?: Partial<GraduatedAuthorityConfig>;
  private taskAuction?: TaskAuction;

  constructor(config: WorkDistributorConfig) {
    this.meshManager = config.meshManager;
    this.strategy = config.strategy;
    this.delegationTimeoutMs = config.delegation_timeout_ms;
    this.maxRetries = config.max_retries;
    this.reputationStore = config.reputationStore;
    this.contractStore = config.contractStore;
    this.redelegationMonitor = config.redelegationMonitor;
    this.taskMonitor = config.taskMonitor;
    this.emitEvent = config.emitEvent;
    this.selectionWeights = config.selectionWeights ?? DEFAULT_SELECTION_WEIGHTS;
    this.graduatedAuthorityConfig = config.graduatedAuthorityConfig;
    this.taskAuction = config.taskAuction;
  }

  /**
   * Distribute a task to a suitable peer. Returns the result when the peer completes it.
   * Rejects if no peer accepts or if delegation times out.
   */
  async distribute(
    taskText: string,
    sessionId: string,
    constraints?: SwarmTaskConstraints,
    parentChain?: AttestationChain,
    priority?: number,
  ): Promise<SwarmTaskResult> {
    // Auction strategy: use TaskAuction for bid collection
    if (this.strategy === "auction" && this.taskAuction) {
      const auction = await this.taskAuction.createAuction(taskText, sessionId, constraints);
      // Wait for bid deadline
      await new Promise(resolve => setTimeout(resolve, Math.min(auction.rfq.bid_deadline_ms, 5000)));
      const { awarded, winning_bid } = await this.taskAuction.awardAuction(auction.rfq_id);
      if (!awarded || !winning_bid) {
        throw new Error("Auction failed: no bids received or no suitable bids");
      }
      // Delegate to the winning bidder
      return this.delegateToPeer(
        this.meshManager.getPeer(winning_bid.bidder_node_id) ?? this.meshManager.getActivePeers()[0]!,
        taskText, sessionId, constraints, parentChain, priority,
      );
    }

    const peers = this.selectPeers(constraints);
    if (peers.length === 0) {
      throw new Error("No suitable peers available for task distribution");
    }

    let lastError: Error | undefined;
    let attempts = 0;

    for (const peer of peers) {
      if (attempts >= this.maxRetries + 1) break;
      attempts++;

      try {
        const result = await this.delegateToPeer(peer, taskText, sessionId, constraints, parentChain, priority);

        // Track in redelegation monitor
        if (this.redelegationMonitor) {
          this.redelegationMonitor.trackDelegation(result.task_id, peer.identity.node_id, taskText, sessionId, constraints);
        }

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error("Failed to distribute task to any peer");
  }

  /** Resolve a delegation when a result arrives from a peer. */
  resolveTask(result: SwarmTaskResult): boolean {
    const delegation = this.findDelegationByTaskId(result.task_id);
    if (!delegation) return false;

    clearTimeout(delegation.timer);
    this.activeDelegations.delete(delegation.task_id);

    // Stop monitoring
    if (this.taskMonitor) {
      this.taskMonitor.stopMonitoring(result.task_id);
    }

    // Verify attestation chain if present
    if (result.attestation_chain && this.meshManager.getSwarmToken()) {
      const chainResult = verifyChain(result.attestation_chain, this.meshManager.getSwarmToken()!);
      if (!chainResult.valid) {
        this.emitEvent?.("swarm.attestation_chain_invalid" as JournalEventType, {
          task_id: result.task_id,
          peer_node_id: result.peer_node_id,
          invalid_at_depth: chainResult.invalid_at_depth,
        });
      }
    }

    // Record outcome in reputation store
    if (this.reputationStore) {
      this.reputationStore.recordOutcome(result.peer_node_id, result);
      this.emitEvent?.("swarm.reputation_updated" as JournalEventType, {
        peer_node_id: result.peer_node_id,
        trust_score: this.reputationStore.getTrustScore(result.peer_node_id),
        task_id: result.task_id,
      });
    }

    // Complete contract
    if (this.contractStore && delegation.contract_id) {
      const { violated, reason } = this.contractStore.complete(delegation.contract_id, result);
      if (violated) {
        this.emitEvent?.("swarm.contract_violated" as JournalEventType, {
          contract_id: delegation.contract_id,
          task_id: result.task_id,
          reason,
        });
      } else {
        this.emitEvent?.("swarm.contract_completed" as JournalEventType, {
          contract_id: delegation.contract_id,
          task_id: result.task_id,
        });
      }
    }

    // Clean up redelegation tracking
    if (this.redelegationMonitor) {
      this.redelegationMonitor.removeDelegation(result.task_id);
    }

    delegation.resolve(result);
    return true;
  }

  /** Get the number of active delegations. */
  get activeCount(): number {
    return this.activeDelegations.size;
  }

  /** Get active delegation info (for diagnostics). */
  getActiveDelegations(): Array<{ task_id: string; peer_node_id: string; elapsed_ms: number; priority?: number }> {
    return [...this.activeDelegations.values()].map((d) => ({
      task_id: d.task_id,
      peer_node_id: d.peer_node_id,
      elapsed_ms: Date.now() - d.sent_at,
      priority: d.priority,
    }));
  }

  /** Get a single active delegation by task ID. */
  getActiveDelegation(taskId: string): ActiveDelegation | undefined {
    return this.activeDelegations.get(taskId);
  }

  /** Cancel a single active delegation. Returns true if found and cancelled. */
  cancelTask(taskId: string, reason?: string): boolean {
    const delegation = this.activeDelegations.get(taskId);
    if (!delegation) return false;

    clearTimeout(delegation.timer);
    this.activeDelegations.delete(taskId);

    // Stop monitoring
    if (this.taskMonitor) {
      this.taskMonitor.stopMonitoring(taskId);
    }

    // Clean up redelegation tracking
    if (this.redelegationMonitor) {
      this.redelegationMonitor.removeDelegation(taskId);
    }

    delegation.reject(new Error(reason ?? "Delegation cancelled"));
    return true;
  }

  /** Cancel all active delegations. */
  cancelAll(): void {
    if (this.taskMonitor) {
      this.taskMonitor.stopAll();
    }
    for (const [, delegation] of this.activeDelegations) {
      clearTimeout(delegation.timer);
      delegation.reject(new Error("Delegation cancelled"));
    }
    this.activeDelegations.clear();
  }

  /** Handle degraded peers: cancel affected delegations and re-delegate tasks. */
  async handlePeerDegradation(degradedPeerIds: string[]): Promise<void> {
    if (!this.redelegationMonitor) return;

    const tasks = this.redelegationMonitor.checkPeerHealth(degradedPeerIds);
    for (const task of tasks) {
      // Cancel the existing delegation
      const delegation = this.findDelegationByTaskId(task.task_id);
      if (delegation) {
        clearTimeout(delegation.timer);
        this.activeDelegations.delete(task.task_id);
        if (this.contractStore && delegation.contract_id) {
          this.contractStore.cancel(delegation.contract_id);
        }
      }

      // Attempt re-delegation
      const ok = this.redelegationMonitor.recordRedelegation(task.task_id, "pending");
      if (!ok) {
        this.emitEvent?.("swarm.task_redelegated" as JournalEventType, {
          task_id: task.task_id,
          old_peer: task.old_peer,
          status: "exhausted",
        });
        // Reject the delegation promise if still tracked
        delegation?.reject(new Error("Redelegation limit exhausted"));
        continue;
      }

      this.emitEvent?.("swarm.task_redelegated" as JournalEventType, {
        task_id: task.task_id,
        old_peer: task.old_peer,
        session_id: task.session_id,
      });

      // Re-distribute to a new peer (excluding degraded and previously failed peers)
      try {
        const peers = this.selectPeers(task.constraints).filter(
          (p) => !task.excluded_peers.has(p.identity.node_id) && !degradedPeerIds.includes(p.identity.node_id),
        );
        if (peers.length === 0) {
          delegation?.reject(new Error("No suitable peers for redelegation"));
          continue;
        }

        const newPeer = peers[0]!;
        this.redelegationMonitor.recordRedelegation(task.task_id, newPeer.identity.node_id);

        // Create a new delegation to the new peer
        const delegateResult = await this.meshManager.delegateTask(
          newPeer.identity.node_id,
          task.task_text,
          task.session_id,
          task.constraints,
        );

        if (!delegateResult.accepted) {
          delegation?.reject(new Error(`Redelegation to ${newPeer.identity.node_id} rejected`));
          continue;
        }

        // If we still have the original resolve/reject, re-register with new task ID
        if (delegation) {
          const timer = setTimeout(() => {
            this.activeDelegations.delete(delegateResult.taskId);
            delegation.reject(new Error(`Redelegation timed out`));
          }, this.delegationTimeoutMs);
          timer.unref();

          const newDelegation: ActiveDelegation = {
            task_id: delegateResult.taskId,
            peer_node_id: newPeer.identity.node_id,
            correlation_id: uuid(),
            sent_at: Date.now(),
            timeout_ms: this.delegationTimeoutMs,
            resolve: delegation.resolve,
            reject: delegation.reject,
            timer,
          };
          this.activeDelegations.set(delegateResult.taskId, newDelegation);
        }
      } catch {
        delegation?.reject(new Error("Redelegation failed"));
      }
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private selectPeers(constraints?: SwarmTaskConstraints): PeerEntry[] {
    let candidates: PeerEntry[];

    if ((this.strategy === "capability_match" || this.strategy === "reputation" || this.strategy === "multi_objective" || this.strategy === "pareto") && constraints?.tool_allowlist?.length) {
      // Find peers that have at least one required capability
      const required = constraints.tool_allowlist;
      candidates = this.meshManager.getActivePeers().filter((peer) =>
        required.some((tool) => peer.identity.capabilities.includes(tool)),
      );
    } else {
      candidates = this.meshManager.getActivePeers();
    }

    if (this.strategy === "pareto" && candidates.length > 0) {
      const scores = scorePeersForPareto({
        peers: candidates,
        reputationStore: this.reputationStore,
        constraints,
      });
      if (scores.length === 0) return candidates;
      const result = paretoSelect(scores, this.selectionWeights);
      this.emitEvent?.("swarm.pareto_selection_completed" as JournalEventType, {
        front_size: result.pareto_front.length,
        dominated_count: result.dominated.length,
        selected_node_id: result.selected.node_id,
        selection_method: result.selection_method,
      });
      // Return candidates ordered by Pareto selection: selected first, then front, then dominated
      const selectedId = result.selected.node_id;
      const frontIds = new Set(result.pareto_front.map(p => p.node_id));
      const sorted = [...candidates].sort((a, b) => {
        if (a.identity.node_id === selectedId) return -1;
        if (b.identity.node_id === selectedId) return 1;
        const aInFront = frontIds.has(a.identity.node_id);
        const bInFront = frontIds.has(b.identity.node_id);
        if (aInFront && !bInFront) return -1;
        if (!aInFront && bInFront) return 1;
        return 0;
      });
      return sorted;
    }

    if (this.strategy === "multi_objective" && candidates.length > 0) {
      return this.scoreMultiObjective(candidates, constraints);
    }

    if (this.strategy === "reputation" && this.reputationStore && candidates.length > 0) {
      // Sort by trust score descending, break ties by latency ascending
      candidates.sort((a, b) => {
        const scoreA = this.reputationStore!.getTrustScore(a.identity.node_id);
        const scoreB = this.reputationStore!.getTrustScore(b.identity.node_id);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.last_latency_ms - b.last_latency_ms;
      });
      return candidates;
    }

    if (this.strategy === "round_robin" && candidates.length > 0) {
      // Rotate through peers starting at current index
      const rotated: PeerEntry[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const idx = (this.roundRobinIndex + i) % candidates.length;
        rotated.push(candidates[idx]!);
      }
      this.roundRobinIndex = (this.roundRobinIndex + 1) % candidates.length;
      return rotated;
    }

    return candidates;
  }

  private scoreMultiObjective(candidates: PeerEntry[], constraints?: SwarmTaskConstraints): PeerEntry[] {
    const w = this.selectionWeights;
    const maxCost = constraints?.max_cost_usd ?? 1.0;
    const required = constraints?.tool_allowlist ?? [];

    const scored = candidates.map((peer) => {
      // Trust score from reputation store (0-1)
      const trustScore = this.reputationStore
        ? this.reputationStore.getTrustScore(peer.identity.node_id)
        : 0.5;

      // Latency score: 1 - clamp(latency / 10000, 0, 1)
      const latencyScore = 1 - Math.min(Math.max(peer.last_latency_ms / 10000, 0), 1);

      // Cost score: 1 - clamp(avg_cost / max_cost, 0, 1)
      const rep = this.reputationStore?.getReputation(peer.identity.node_id);
      const totalTasks = rep ? rep.tasks_completed + rep.tasks_failed + rep.tasks_aborted : 0;
      const avgCost = totalTasks > 0 ? (rep!.total_cost_usd / totalTasks) : 0;
      const costScore = 1 - Math.min(Math.max(avgCost / maxCost, 0), 1);

      // Capability score: intersection / required.length
      let capabilityScore = 1.0;
      if (required.length > 0) {
        const intersection = required.filter((r) => peer.identity.capabilities.includes(r)).length;
        capabilityScore = intersection / required.length;
      }

      const composite =
        w.trust * trustScore +
        w.latency * latencyScore +
        w.cost * costScore +
        w.capability * capabilityScore;

      return { peer, composite };
    });

    scored.sort((a, b) => b.composite - a.composite);
    return scored.map((s) => s.peer);
  }

  private async delegateToPeer(
    peer: PeerEntry,
    taskText: string,
    sessionId: string,
    constraints?: SwarmTaskConstraints,
    parentChain?: AttestationChain,
    priority?: number,
  ): Promise<SwarmTaskResult> {
    const delegateResult = await this.meshManager.delegateTask(
      peer.identity.node_id,
      taskText,
      sessionId,
      constraints,
      parentChain,
      priority,
    );

    if (!delegateResult.accepted) {
      throw new Error(`Peer ${peer.identity.node_id} rejected: ${delegateResult.reason}`);
    }

    const taskId = delegateResult.taskId;

    // Build base SLO
    const baseSlo: ContractSLO = {
      max_duration_ms: constraints?.max_duration_ms ?? this.delegationTimeoutMs,
      max_tokens: constraints?.max_tokens ?? Number.MAX_SAFE_INTEGER,
      max_cost_usd: constraints?.max_cost_usd ?? Number.MAX_SAFE_INTEGER,
    };

    // Apply graduated authority if reputation is available
    let finalSlo = baseSlo;
    let finalMonitoring: ContractMonitoring = { require_checkpoints: false };
    let finalPermBoundary: ContractPermissionBoundary = constraints?.tool_allowlist ? { tool_allowlist: constraints.tool_allowlist } : {};

    if (this.reputationStore) {
      const trustScore = this.reputationStore.getTrustScore(peer.identity.node_id);
      const graduated = authorityFromTrust(
        trustScore,
        baseSlo,
        { require_checkpoints: false },
        constraints?.tool_allowlist ? { tool_allowlist: constraints.tool_allowlist } : undefined,
        this.graduatedAuthorityConfig as GraduatedAuthorityConfig | undefined,
      );
      finalSlo = graduated.slo;
      finalMonitoring = graduated.monitoring;
      finalPermBoundary = graduated.permission_boundary;
    }

    // Create delegation contract if contractStore is available
    let contractId: string | undefined;
    if (this.contractStore) {
      const contract = this.contractStore.create({
        delegator_node_id: this.meshManager.getIdentity().node_id,
        delegatee_node_id: peer.identity.node_id,
        task_id: taskId,
        task_text: taskText,
        slo: finalSlo,
        monitoring: finalMonitoring,
        permission_boundary: finalPermBoundary,
      });
      contractId = contract.contract_id;
      this.emitEvent?.("swarm.contract_created" as JournalEventType, {
        contract_id: contract.contract_id,
        task_id: taskId,
        delegatee_node_id: peer.identity.node_id,
      });
    }

    // Start monitoring if required
    if (finalMonitoring.require_checkpoints && this.taskMonitor) {
      this.taskMonitor.startMonitoring({
        task_id: taskId,
        peer_node_id: peer.identity.node_id,
        contract_id: contractId,
        report_interval_ms: finalMonitoring.report_interval_ms,
        monitoring_level: finalMonitoring.monitoring_level,
      });
    }

    return new Promise<SwarmTaskResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeDelegations.delete(taskId);
        if (this.taskMonitor) {
          this.taskMonitor.stopMonitoring(taskId);
        }
        reject(new Error(`Delegation to ${peer.identity.node_id} timed out after ${this.delegationTimeoutMs}ms`));
      }, this.delegationTimeoutMs);
      timer.unref();

      const delegation: ActiveDelegation = {
        task_id: taskId,
        peer_node_id: peer.identity.node_id,
        correlation_id: uuid(),
        sent_at: Date.now(),
        timeout_ms: this.delegationTimeoutMs,
        resolve,
        reject,
        timer,
        contract_id: contractId,
        priority,
      };

      this.activeDelegations.set(taskId, delegation);
    });
  }

  private findDelegationByTaskId(taskId: string): ActiveDelegation | undefined {
    return this.activeDelegations.get(taskId);
  }
}
