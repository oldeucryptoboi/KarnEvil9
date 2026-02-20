import type { JournalEventType } from "@karnevil9/schemas";
import type { WorkDistributor } from "./work-distributor.js";
import type { ReputationStore } from "./reputation-store.js";
import type { MeshManager } from "./mesh-manager.js";
import type {
  SelectionWeights,
  PeerPerformanceSnapshot,
  ReoptimizationDecision,
  TaskCheckpointStatus,
  PeerEntry,
} from "./types.js";
import { DEFAULT_SELECTION_WEIGHTS } from "./types.js";

export interface OptimizationLoopConfig {
  evaluation_interval_ms?: number;    // how often to re-evaluate (default 30000)
  drift_threshold?: number;           // score drop fraction to trigger redelegate (default 0.3)
  min_time_before_redelegate_ms?: number; // avoid thrashing (default 60000)
  overhead_factor?: number;           // estimated redelegation cost factor (default 0.1)
}

interface TaskState {
  task_id: string;
  peer_node_id: string;
  delegated_at: number;
  last_evaluated_at: number;
  last_redelegated_at?: number;
  checkpoint_hits: number;
  checkpoint_misses: number;
  latest_progress_pct?: number;
}

export class OptimizationLoop {
  private workDistributor: WorkDistributor;
  private reputationStore?: ReputationStore;
  private meshManager: MeshManager;
  private selectionWeights: SelectionWeights;
  private config: Required<OptimizationLoopConfig>;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private taskStates = new Map<string, TaskState>();

  constructor(params: {
    workDistributor: WorkDistributor;
    reputationStore?: ReputationStore;
    meshManager: MeshManager;
    selectionWeights?: SelectionWeights;
    loopConfig?: OptimizationLoopConfig;
    emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  }) {
    this.workDistributor = params.workDistributor;
    this.reputationStore = params.reputationStore;
    this.meshManager = params.meshManager;
    this.selectionWeights = params.selectionWeights ?? DEFAULT_SELECTION_WEIGHTS;
    this.emitEvent = params.emitEvent;
    this.config = {
      evaluation_interval_ms: params.loopConfig?.evaluation_interval_ms ?? 30000,
      drift_threshold: params.loopConfig?.drift_threshold ?? 0.3,
      min_time_before_redelegate_ms: params.loopConfig?.min_time_before_redelegate_ms ?? 60000,
      overhead_factor: params.loopConfig?.overhead_factor ?? 0.1,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.evaluateAll();
    }, this.config.evaluation_interval_ms);
    this.timer.unref();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.taskStates.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  onCheckpointData(taskId: string, checkpoint: TaskCheckpointStatus): void {
    const state = this.taskStates.get(taskId);
    if (!state) {
      // We may not be tracking this task — register it from active delegations
      const delegation = this.workDistributor.getActiveDelegation(taskId);
      if (!delegation) return;
      const isHit = checkpoint.status === "running";
      this.taskStates.set(taskId, {
        task_id: taskId,
        peer_node_id: delegation.peer_node_id,
        delegated_at: delegation.sent_at,
        last_evaluated_at: Date.now(),
        checkpoint_hits: isHit ? 1 : 0,
        checkpoint_misses: isHit ? 0 : 1,
        latest_progress_pct: checkpoint.progress_pct,
      });
      return;
    }

    if (checkpoint.status === "running") {
      state.checkpoint_hits++;
      state.latest_progress_pct = checkpoint.progress_pct;
    } else {
      state.checkpoint_misses++;
    }

    // Trigger immediate evaluation if alarming
    if (state.checkpoint_misses > 2) {
      this.evaluateTask(taskId);
    }
  }

  evaluateTask(taskId: string): ReoptimizationDecision {
    const delegation = this.workDistributor.getActiveDelegation(taskId);
    if (!delegation) {
      return { action: "keep", reason: "No active delegation found", current_peer_score: 0 };
    }

    let state = this.taskStates.get(taskId);
    if (!state) {
      state = {
        task_id: taskId,
        peer_node_id: delegation.peer_node_id,
        delegated_at: delegation.sent_at,
        last_evaluated_at: Date.now(),
        checkpoint_hits: 0,
        checkpoint_misses: 0,
      };
      this.taskStates.set(taskId, state);
    }

    const currentScore = this.scorePeer(delegation.peer_node_id);
    const now = Date.now();

    // Check for escalation conditions
    if (state.checkpoint_misses >= 3) {
      state.last_evaluated_at = now;
      return {
        action: "escalate",
        reason: `Peer missed ${state.checkpoint_misses} checkpoints`,
        current_peer_score: currentScore,
      };
    }

    // Find best alternative
    const activePeers = this.meshManager.getActivePeers()
      .filter((p) => p.identity.node_id !== delegation.peer_node_id);

    if (activePeers.length === 0) {
      state.last_evaluated_at = now;
      return { action: "keep", reason: "No alternative peers available", current_peer_score: currentScore };
    }

    let bestAlternative: PeerEntry | undefined;
    let bestAlternativeScore = 0;
    for (const peer of activePeers) {
      const score = this.scorePeer(peer.identity.node_id);
      if (score > bestAlternativeScore) {
        bestAlternativeScore = score;
        bestAlternative = peer;
      }
    }

    // Check drift threshold (accounting for redelegation overhead)
    const driftRatio = currentScore > 0 ? (bestAlternativeScore - currentScore) / Math.max(currentScore, 0.01) : 0;
    const adjustedDrift = driftRatio - this.config.overhead_factor;

    // Anti-thrashing check
    const timeSinceLastRedelegate = state.last_redelegated_at
      ? now - state.last_redelegated_at
      : now - state.delegated_at;

    if (adjustedDrift > this.config.drift_threshold && timeSinceLastRedelegate >= this.config.min_time_before_redelegate_ms) {
      state.last_evaluated_at = now;
      return {
        action: "redelegate",
        reason: `Score drift ${(driftRatio * 100).toFixed(1)}% exceeds threshold (${(this.config.drift_threshold * 100).toFixed(1)}%)`,
        current_peer_score: currentScore,
        best_alternative_score: bestAlternativeScore,
        best_alternative_node_id: bestAlternative?.identity.node_id,
      };
    }

    // Anti-thrashing: want to redelegate but too soon
    if (adjustedDrift > this.config.drift_threshold) {
      state.last_evaluated_at = now;
      return {
        action: "keep",
        reason: `Drift detected but within anti-thrashing window (${timeSinceLastRedelegate}ms < ${this.config.min_time_before_redelegate_ms}ms)`,
        current_peer_score: currentScore,
        best_alternative_score: bestAlternativeScore,
        best_alternative_node_id: bestAlternative?.identity.node_id,
      };
    }

    state.last_evaluated_at = now;
    return { action: "keep", reason: "Current peer performing adequately", current_peer_score: currentScore };
  }

  evaluateAll(): Map<string, ReoptimizationDecision> {
    const results = new Map<string, ReoptimizationDecision>();

    // Sync from active delegations
    for (const del of this.workDistributor.getActiveDelegations()) {
      if (!this.taskStates.has(del.task_id)) {
        this.taskStates.set(del.task_id, {
          task_id: del.task_id,
          peer_node_id: del.peer_node_id,
          delegated_at: Date.now() - del.elapsed_ms,
          last_evaluated_at: 0,
          checkpoint_hits: 0,
          checkpoint_misses: 0,
        });
      }
    }

    // Clean up stale entries
    for (const taskId of this.taskStates.keys()) {
      if (!this.workDistributor.getActiveDelegation(taskId)) {
        this.taskStates.delete(taskId);
      }
    }

    for (const taskId of this.taskStates.keys()) {
      const decision = this.evaluateTask(taskId);
      results.set(taskId, decision);

      if (decision.action === "redelegate") {
        const state = this.taskStates.get(taskId);
        if (state) state.last_redelegated_at = Date.now();

        this.emitEvent?.("swarm.peer_redelegate_on_drift" as JournalEventType, {
          task_id: taskId,
          current_peer: state?.peer_node_id,
          best_alternative: decision.best_alternative_node_id,
          reason: decision.reason,
        });
      }
    }

    this.emitEvent?.("swarm.reoptimization_triggered" as JournalEventType, {
      tasks_evaluated: results.size,
      actions: Object.fromEntries(
        ["keep", "redelegate", "escalate"].map((a) => [
          a,
          [...results.values()].filter((d) => d.action === a).length,
        ]),
      ),
    });

    return results;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private scorePeer(nodeId: string): number {
    const w = this.selectionWeights;

    // Trust from reputation store
    const trustScore = this.reputationStore?.getTrustScore(nodeId) ?? 0.5;

    // Latency from peer table
    const peer = this.meshManager.getPeer(nodeId);
    const latencyMs = peer?.last_latency_ms ?? 5000;
    const latencyScore = 1 - Math.min(Math.max(latencyMs / 10000, 0), 1);

    // Cost from reputation store
    const rep = this.reputationStore?.getReputation(nodeId);
    const totalTasks = rep ? rep.tasks_completed + rep.tasks_failed + rep.tasks_aborted : 0;
    const avgCost = totalTasks > 0 ? rep!.total_cost_usd / totalTasks : 0;
    const costScore = 1 - Math.min(Math.max(avgCost / 1.0, 0), 1);

    // Capability score: use 1.0 as default (we don't have constraint context here)
    const capabilityScore = 1.0;

    return w.trust * trustScore +
      w.latency * latencyScore +
      w.cost * costScore +
      w.capability * capabilityScore;
  }
}
