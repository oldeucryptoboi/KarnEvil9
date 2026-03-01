import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExternalTriggerHandler } from "./external-trigger-handler.js";
import type { WorkDistributor } from "./work-distributor.js";
import type { MeshManager } from "./mesh-manager.js";
import type { ContractStore } from "./delegation-contract.js";
import type { JournalEventType } from "@karnevil9/schemas";
import type { BudgetAlertTrigger, ExternalTrigger } from "./types.js";

function makeMockDistributor(overrides: Partial<WorkDistributor> = {}) {
  return {
    cancelTask: vi.fn().mockReturnValue(true),
    getActiveDelegations: vi.fn().mockReturnValue([]),
    distribute: vi.fn().mockResolvedValue({
      task_id: "new-task-1",
      peer_node_id: "peer-1",
      peer_session_id: "session-1",
      status: "completed",
      findings: [],
      tokens_used: 100,
      cost_usd: 0.01,
      duration_ms: 5000,
    }),
    ...overrides,
  } as unknown as WorkDistributor;
}

function makeMockMesh() {
  return {
    getIdentity: vi.fn().mockReturnValue({ node_id: "self" }),
    getActivePeers: vi.fn().mockReturnValue([]),
  } as unknown as MeshManager;
}

function makeMockContractStore() {
  return {
    getByTaskId: vi.fn().mockReturnValue(null),
    cancel: vi.fn(),
    get: vi.fn(),
  } as unknown as ContractStore;
}

describe("ExternalTriggerHandler", () => {
  let distributor: ReturnType<typeof makeMockDistributor>;
  let mesh: ReturnType<typeof makeMockMesh>;
  let contractStore: ReturnType<typeof makeMockContractStore>;
  let emitEvent: ReturnType<typeof vi.fn>;
  let handler: ExternalTriggerHandler;

  beforeEach(() => {
    distributor = makeMockDistributor();
    mesh = makeMockMesh();
    contractStore = makeMockContractStore();
    emitEvent = vi.fn();
    handler = new ExternalTriggerHandler({
      workDistributor: distributor,
      meshManager: mesh,
      contractStore,
      emitEvent: emitEvent as (type: JournalEventType, payload: Record<string, unknown>) => void,
      budgetAlertThreshold: 0.8,
    });
  });

  // ─── cancelTask ─────────────────────────────────────────────────

  describe("cancelTask", () => {
    it("should cancel an active task", async () => {
      const result = await handler.cancelTask("task-1", "testing");
      expect(result.cancelled).toBe(true);
      expect((distributor.cancelTask as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("task-1", "testing");
    });

    it("should return false for unknown task", async () => {
      (distributor.cancelTask as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = await handler.cancelTask("unknown");
      expect(result.cancelled).toBe(false);
    });

    it("should cancel the contract", async () => {
      (contractStore.getByTaskId as ReturnType<typeof vi.fn>).mockReturnValue({ contract_id: "contract-1" });
      await handler.cancelTask("task-1");
      expect((contractStore.cancel as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("contract-1");
    });

    it("should emit task_cancelled event", async () => {
      await handler.cancelTask("task-1", "user-requested");
      expect(emitEvent).toHaveBeenCalledWith("swarm.task_cancelled", expect.objectContaining({
        task_id: "task-1",
        reason: "user-requested",
      }));
    });

    it("should not emit event when task not found", async () => {
      (distributor.cancelTask as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await handler.cancelTask("unknown");
      expect(emitEvent).not.toHaveBeenCalledWith("swarm.task_cancelled", expect.anything());
    });
  });

  // ─── checkBudget ────────────────────────────────────────────────

  describe("checkBudget", () => {
    it("should return empty when no contract", () => {
      const alerts = handler.checkBudget("task-1", { cost_usd: 0.5 });
      expect(alerts).toHaveLength(0);
    });

    it("should return empty when under threshold", () => {
      (contractStore.getByTaskId as ReturnType<typeof vi.fn>).mockReturnValue({
        contract_id: "c-1",
        status: "active",
        slo: { max_cost_usd: 1.0, max_tokens: 10000, max_duration_ms: 300000 },
      });
      const alerts = handler.checkBudget("task-1", { cost_usd: 0.5 });
      expect(alerts).toHaveLength(0);
    });

    it("should alert when over threshold", () => {
      (contractStore.getByTaskId as ReturnType<typeof vi.fn>).mockReturnValue({
        contract_id: "c-1",
        status: "active",
        slo: { max_cost_usd: 1.0, max_tokens: 10000, max_duration_ms: 300000 },
      });
      const alerts = handler.checkBudget("task-1", { cost_usd: 0.9 });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.metric).toBe("cost_usd");
      expect(alerts[0]?.percentage).toBe(0.9);
    });

    it("should alert for multiple metrics", () => {
      (contractStore.getByTaskId as ReturnType<typeof vi.fn>).mockReturnValue({
        contract_id: "c-1",
        status: "active",
        slo: { max_cost_usd: 1.0, max_tokens: 10000, max_duration_ms: 300000 },
      });
      const alerts = handler.checkBudget("task-1", { cost_usd: 0.85, tokens: 9000 });
      expect(alerts).toHaveLength(2);
    });

    it("should skip MAX_SAFE_INTEGER limits", () => {
      (contractStore.getByTaskId as ReturnType<typeof vi.fn>).mockReturnValue({
        contract_id: "c-1",
        status: "active",
        slo: { max_cost_usd: Number.MAX_SAFE_INTEGER, max_tokens: 10000, max_duration_ms: Number.MAX_SAFE_INTEGER },
      });
      const alerts = handler.checkBudget("task-1", { cost_usd: 100, tokens: 9000, duration_ms: 999999 });
      expect(alerts).toHaveLength(1); // only tokens
    });

    it("should not check completed contracts", () => {
      (contractStore.getByTaskId as ReturnType<typeof vi.fn>).mockReturnValue({
        contract_id: "c-1",
        status: "completed",
        slo: { max_cost_usd: 1.0, max_tokens: 10000, max_duration_ms: 300000 },
      });
      const alerts = handler.checkBudget("task-1", { cost_usd: 5.0 });
      expect(alerts).toHaveLength(0);
    });
  });

  // ─── handleBudgetAlert ──────────────────────────────────────────

  describe("handleBudgetAlert", () => {
    it("should emit budget_alert event", async () => {
      const alert: BudgetAlertTrigger = {
        type: "budget_alert",
        task_id: "task-1",
        metric: "cost_usd",
        current_value: 0.9,
        limit_value: 1.0,
        percentage: 0.9,
        timestamp: new Date().toISOString(),
      };
      await handler.handleBudgetAlert(alert);
      expect(emitEvent).toHaveBeenCalledWith("swarm.budget_alert", expect.objectContaining({
        task_id: "task-1",
        metric: "cost_usd",
      }));
    });

    it("should auto-cancel at 100%", async () => {
      const alert: BudgetAlertTrigger = {
        type: "budget_alert",
        task_id: "task-1",
        metric: "cost_usd",
        current_value: 1.5,
        limit_value: 1.0,
        percentage: 1.5,
        timestamp: new Date().toISOString(),
      };
      await handler.handleBudgetAlert(alert);
      expect((distributor.cancelTask as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it("should not cancel below 100%", async () => {
      const alert: BudgetAlertTrigger = {
        type: "budget_alert",
        task_id: "task-1",
        metric: "cost_usd",
        current_value: 0.9,
        limit_value: 1.0,
        percentage: 0.9,
        timestamp: new Date().toISOString(),
      };
      await handler.handleBudgetAlert(alert);
      expect((distributor.cancelTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
  });

  // ─── preemptForPriority ──────────────────────────────────────────

  describe("preemptForPriority", () => {
    it("should preempt lowest-priority delegation", async () => {
      (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([
        { task_id: "low-task", peer_node_id: "peer-1", elapsed_ms: 1000, priority: 1 },
        { task_id: "high-task", peer_node_id: "peer-2", elapsed_ms: 2000, priority: 10 },
      ]);

      const result = await handler.preemptForPriority("urgent task", 15, 5, "session-1");
      expect(result.preempted).toBe(true);
      expect(result.preempted_task_id).toBe("low-task");
    });

    it("should return preempted=false when no low-priority found", async () => {
      (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([
        { task_id: "high-task", peer_node_id: "peer-1", elapsed_ms: 1000, priority: 10 },
      ]);

      const result = await handler.preemptForPriority("new task", 15, 5, "session-1");
      expect(result.preempted).toBe(false);
    });

    it("should emit task_preempted event", async () => {
      (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([
        { task_id: "low-task", peer_node_id: "peer-1", elapsed_ms: 1000, priority: 1 },
      ]);

      await handler.preemptForPriority("urgent task", 15, 5, "session-1");
      expect(emitEvent).toHaveBeenCalledWith("swarm.task_preempted", expect.objectContaining({
        preempted_task_id: "low-task",
        new_task_priority: 15,
      }));
    });

    it("should still return preempted=true even if distribute fails", async () => {
      (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([
        { task_id: "low-task", peer_node_id: "peer-1", elapsed_ms: 1000, priority: 1 },
      ]);
      (distributor.distribute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("No peers"));

      const result = await handler.preemptForPriority("urgent task", 15, 5, "session-1");
      expect(result.preempted).toBe(true);
      expect(result.new_task_id).toBeUndefined();
    });
  });

  // ─── dispatch ───────────────────────────────────────────────────

  describe("dispatch", () => {
    it("should route task_cancel trigger", async () => {
      const trigger: ExternalTrigger = {
        type: "task_cancel",
        task_id: "task-1",
        reason: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await handler.dispatch(trigger);
      expect(result.handled).toBe(true);
    });

    it("should route budget_alert trigger", async () => {
      const trigger: ExternalTrigger = {
        type: "budget_alert",
        task_id: "task-1",
        metric: "cost_usd",
        current_value: 0.9,
        limit_value: 1.0,
        percentage: 0.9,
        timestamp: new Date().toISOString(),
      };
      const result = await handler.dispatch(trigger);
      expect(result.handled).toBe(true);
    });

    it("should route priority_preempt trigger", async () => {
      (distributor.getActiveDelegations as ReturnType<typeof vi.fn>).mockReturnValue([
        { task_id: "low-task", peer_node_id: "peer-1", elapsed_ms: 1000, priority: 1 },
      ]);
      const trigger: ExternalTrigger = {
        type: "priority_preempt",
        new_task_text: "urgent",
        new_task_priority: 10,
        min_priority_to_preempt: 5,
        timestamp: new Date().toISOString(),
      };
      const result = await handler.dispatch(trigger);
      expect(result.handled).toBe(true);
    });
  });

  // ─── on/unsubscribe ─────────────────────────────────────────────

  describe("on/unsubscribe", () => {
    it("should call listener on dispatch", async () => {
      const listener = vi.fn();
      handler.on("task_cancel", listener);
      await handler.dispatch({
        type: "task_cancel",
        task_id: "task-1",
        timestamp: new Date().toISOString(),
      });
      expect(listener).toHaveBeenCalled();
    });

    it("should unsubscribe correctly", async () => {
      const listener = vi.fn();
      const unsub = handler.on("task_cancel", listener);
      unsub();
      await handler.dispatch({
        type: "task_cancel",
        task_id: "task-1",
        timestamp: new Date().toISOString(),
      });
      expect(listener).not.toHaveBeenCalled();
    });

    it("should cap listeners per type at 100 with FIFO eviction", async () => {
      const listeners: Array<ReturnType<typeof vi.fn>> = [];
      for (let i = 0; i < 101; i++) {
        const listener = vi.fn();
        listeners.push(listener);
        handler.on("task_cancel", listener);
      }

      await handler.dispatch({
        type: "task_cancel",
        task_id: "task-1",
        timestamp: new Date().toISOString(),
      });

      // The first listener (index 0) should have been evicted
      expect(listeners[0]!).not.toHaveBeenCalled();
      // The second listener (index 1) should still be registered
      expect(listeners[1]!).toHaveBeenCalled();
      // The last listener (index 100) should be registered
      expect(listeners[100]!).toHaveBeenCalled();
    });

    it("should support multiple listeners", async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      handler.on("budget_alert", listener1);
      handler.on("budget_alert", listener2);
      await handler.dispatch({
        type: "budget_alert",
        task_id: "task-1",
        metric: "cost_usd",
        current_value: 0.9,
        limit_value: 1.0,
        percentage: 0.9,
        timestamp: new Date().toISOString(),
      });
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });
  });
});
