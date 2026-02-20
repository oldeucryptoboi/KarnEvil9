import type { RedelegationConfig, SwarmTaskConstraints } from "./types.js";

interface TrackedDelegation {
  task_id: string;
  peer_node_id: string;
  task_text: string;
  session_id: string;
  constraints?: SwarmTaskConstraints;
  redelegation_count: number;
  last_redelegated_at?: number;
  excluded_peers: Set<string>;
}

export class RedelegationMonitor {
  private config: RedelegationConfig;
  private delegations = new Map<string, TrackedDelegation>();

  constructor(config?: Partial<RedelegationConfig>) {
    this.config = {
      max_redelegations: config?.max_redelegations ?? 2,
      redelegation_cooldown_ms: config?.redelegation_cooldown_ms ?? 5000,
    };
  }

  trackDelegation(
    taskId: string,
    peerNodeId: string,
    taskText: string,
    sessionId: string,
    constraints?: SwarmTaskConstraints,
  ): void {
    this.delegations.set(taskId, {
      task_id: taskId,
      peer_node_id: peerNodeId,
      task_text: taskText,
      session_id: sessionId,
      constraints,
      redelegation_count: 0,
      excluded_peers: new Set(),
    });
  }

  checkPeerHealth(
    degradedPeerIds: string[],
  ): Array<{ task_id: string; old_peer: string; task_text: string; session_id: string; constraints?: SwarmTaskConstraints; excluded_peers: Set<string> }> {
    const degradedSet = new Set(degradedPeerIds);
    const needsRedelegation: Array<{ task_id: string; old_peer: string; task_text: string; session_id: string; constraints?: SwarmTaskConstraints; excluded_peers: Set<string> }> = [];

    for (const delegation of this.delegations.values()) {
      if (!degradedSet.has(delegation.peer_node_id)) continue;
      if (delegation.redelegation_count >= this.config.max_redelegations) continue;

      // Cooldown check
      if (delegation.last_redelegated_at) {
        const elapsed = Date.now() - delegation.last_redelegated_at;
        if (elapsed < this.config.redelegation_cooldown_ms) continue;
      }

      needsRedelegation.push({
        task_id: delegation.task_id,
        old_peer: delegation.peer_node_id,
        task_text: delegation.task_text,
        session_id: delegation.session_id,
        constraints: delegation.constraints,
        excluded_peers: new Set(delegation.excluded_peers),
      });
    }

    return needsRedelegation;
  }

  recordRedelegation(taskId: string, newPeerNodeId: string): boolean {
    const delegation = this.delegations.get(taskId);
    if (!delegation) return false;

    if (delegation.redelegation_count >= this.config.max_redelegations) {
      return false;
    }

    delegation.excluded_peers.add(delegation.peer_node_id);
    delegation.peer_node_id = newPeerNodeId;
    delegation.redelegation_count++;
    delegation.last_redelegated_at = Date.now();
    return true;
  }

  removeDelegation(taskId: string): void {
    this.delegations.delete(taskId);
  }

  getRedelegationCount(taskId: string): number {
    return this.delegations.get(taskId)?.redelegation_count ?? 0;
  }

  getTrackedDelegations(): Array<{ task_id: string; peer_node_id: string; redelegation_count: number }> {
    return [...this.delegations.values()].map(d => ({
      task_id: d.task_id,
      peer_node_id: d.peer_node_id,
      redelegation_count: d.redelegation_count,
    }));
  }

  get size(): number {
    return this.delegations.size;
  }
}
