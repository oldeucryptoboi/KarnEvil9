import type { JournalEventType } from "@karnevil9/schemas";
import type { WorkDistributor } from "./work-distributor.js";
import type { MeshManager } from "./mesh-manager.js";
import type { ContractStore } from "./delegation-contract.js";
import type {
  ExternalTrigger,
  TriggerType,
  TaskCancelTrigger,
  BudgetAlertTrigger,
  PriorityPreemptTrigger,
  SwarmTaskConstraints,
} from "./types.js";

export type TriggerListener = (trigger: ExternalTrigger) => void;

export interface ExternalTriggerHandlerConfig {
  workDistributor: WorkDistributor;
  meshManager: MeshManager;
  contractStore?: ContractStore;
  emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  budgetAlertThreshold?: number;
}

export class ExternalTriggerHandler {
  private workDistributor: WorkDistributor;
  private meshManager: MeshManager;
  private contractStore?: ContractStore;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  private budgetAlertThreshold: number;
  private listeners = new Map<TriggerType, Set<TriggerListener>>();

  constructor(config: ExternalTriggerHandlerConfig) {
    this.workDistributor = config.workDistributor;
    this.meshManager = config.meshManager;
    this.contractStore = config.contractStore;
    this.emitEvent = config.emitEvent;
    this.budgetAlertThreshold = config.budgetAlertThreshold ?? 0.8;
  }

  on(type: TriggerType, listener: TriggerListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => { set!.delete(listener); };
  }

  async dispatch(trigger: ExternalTrigger): Promise<{ handled: boolean; result?: unknown }> {
    // Notify listeners
    const set = this.listeners.get(trigger.type);
    if (set) {
      for (const listener of set) {
        listener(trigger);
      }
    }

    switch (trigger.type) {
      case "task_cancel": {
        const result = await this.cancelTask(trigger.task_id, trigger.reason);
        return { handled: result.cancelled, result };
      }
      case "budget_alert": {
        await this.handleBudgetAlert(trigger);
        return { handled: true };
      }
      case "priority_preempt": {
        const result = await this.preemptForPriority(
          trigger.new_task_text,
          trigger.new_task_priority,
          trigger.min_priority_to_preempt,
          "trigger-dispatch",
          trigger.constraints,
        );
        return { handled: result.preempted, result };
      }
    }
  }

  async cancelTask(
    taskId: string,
    reason?: string,
  ): Promise<{ cancelled: boolean; reason?: string }> {
    const cancelled = this.workDistributor.cancelTask(taskId, reason);
    if (!cancelled) {
      return { cancelled: false, reason: "Task not found in active delegations" };
    }

    // Cancel the contract
    if (this.contractStore) {
      const contract = this.contractStore.getByTaskId(taskId);
      if (contract) {
        this.contractStore.cancel(contract.contract_id);
      }
    }

    this.emitEvent?.("swarm.task_cancelled" as JournalEventType, {
      task_id: taskId,
      reason: reason ?? "external_cancel",
    });

    return { cancelled: true };
  }

  async handleBudgetAlert(alert: BudgetAlertTrigger): Promise<void> {
    this.emitEvent?.("swarm.budget_alert" as JournalEventType, {
      task_id: alert.task_id,
      metric: alert.metric,
      current_value: alert.current_value,
      limit_value: alert.limit_value,
      percentage: alert.percentage,
    });

    // Auto-cancel if at or over 100%
    if (alert.percentage >= 1.0) {
      await this.cancelTask(alert.task_id, `Budget exceeded: ${alert.metric} at ${Math.round(alert.percentage * 100)}%`);
    }
  }

  checkBudget(
    taskId: string,
    currentMetrics: { cost_usd?: number; tokens?: number; duration_ms?: number },
  ): BudgetAlertTrigger[] {
    if (!this.contractStore) return [];

    const contract = this.contractStore.getByTaskId(taskId);
    if (!contract || contract.status !== "active") return [];

    const alerts: BudgetAlertTrigger[] = [];
    const now = new Date().toISOString();

    if (currentMetrics.cost_usd !== undefined && contract.slo.max_cost_usd < Number.MAX_SAFE_INTEGER) {
      const pct = currentMetrics.cost_usd / contract.slo.max_cost_usd;
      if (pct >= this.budgetAlertThreshold) {
        alerts.push({
          type: "budget_alert",
          task_id: taskId,
          metric: "cost_usd",
          current_value: currentMetrics.cost_usd,
          limit_value: contract.slo.max_cost_usd,
          percentage: pct,
          timestamp: now,
        });
      }
    }

    if (currentMetrics.tokens !== undefined && contract.slo.max_tokens < Number.MAX_SAFE_INTEGER) {
      const pct = currentMetrics.tokens / contract.slo.max_tokens;
      if (pct >= this.budgetAlertThreshold) {
        alerts.push({
          type: "budget_alert",
          task_id: taskId,
          metric: "tokens",
          current_value: currentMetrics.tokens,
          limit_value: contract.slo.max_tokens,
          percentage: pct,
          timestamp: now,
        });
      }
    }

    if (currentMetrics.duration_ms !== undefined && contract.slo.max_duration_ms < Number.MAX_SAFE_INTEGER) {
      const pct = currentMetrics.duration_ms / contract.slo.max_duration_ms;
      if (pct >= this.budgetAlertThreshold) {
        alerts.push({
          type: "budget_alert",
          task_id: taskId,
          metric: "duration_ms",
          current_value: currentMetrics.duration_ms,
          limit_value: contract.slo.max_duration_ms,
          percentage: pct,
          timestamp: now,
        });
      }
    }

    return alerts;
  }

  async preemptForPriority(
    newTaskText: string,
    priority: number,
    minPriority: number,
    sessionId: string,
    constraints?: SwarmTaskConstraints,
  ): Promise<{ preempted: boolean; preempted_task_id?: string; new_task_id?: string }> {
    const delegations = this.workDistributor.getActiveDelegations();

    // Find the lowest-priority delegation below the preemption threshold
    let lowestPriority = Infinity;
    let targetTaskId: string | undefined;
    let targetPeerNodeId: string | undefined;

    for (const d of delegations) {
      const p = d.priority ?? 0;
      if (p < minPriority && p < lowestPriority) {
        lowestPriority = p;
        targetTaskId = d.task_id;
        targetPeerNodeId = d.peer_node_id;
      }
    }

    if (!targetTaskId || !targetPeerNodeId) {
      return { preempted: false };
    }

    // Cancel the low-priority task
    this.workDistributor.cancelTask(targetTaskId, `Preempted by higher priority task (priority=${priority})`);

    if (this.contractStore) {
      const contract = this.contractStore.getByTaskId(targetTaskId);
      if (contract) {
        this.contractStore.cancel(contract.contract_id);
      }
    }

    this.emitEvent?.("swarm.task_preempted" as JournalEventType, {
      preempted_task_id: targetTaskId,
      preempted_peer_node_id: targetPeerNodeId,
      new_task_text: newTaskText.slice(0, 200),
      new_task_priority: priority,
    });

    // Delegate the new task
    try {
      const result = await this.workDistributor.distribute(newTaskText, sessionId, constraints);
      return { preempted: true, preempted_task_id: targetTaskId, new_task_id: result.task_id };
    } catch {
      return { preempted: true, preempted_task_id: targetTaskId };
    }
  }
}
