import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContractStore } from "./delegation-contract.js";
import type { CreateContractParams } from "./delegation-contract.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SwarmTaskResult } from "./types.js";

function makeParams(overrides: Partial<CreateContractParams> = {}): CreateContractParams {
  return {
    delegator_node_id: "node-A",
    delegatee_node_id: "node-B",
    task_id: "task-1",
    task_text: "Analyze data",
    slo: {
      max_duration_ms: 60000,
      max_tokens: 10000,
      max_cost_usd: 1.0,
    },
    ...overrides,
  };
}

function makeResult(overrides: Partial<SwarmTaskResult> = {}): SwarmTaskResult {
  return {
    task_id: "task-1",
    peer_node_id: "node-B",
    peer_session_id: "session-1",
    status: "completed",
    findings: [],
    tokens_used: 500,
    cost_usd: 0.05,
    duration_ms: 10000,
    ...overrides,
  };
}

describe("ContractStore", () => {
  let tmpDir: string;
  let store: ContractStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "contract-test-"));
    store = new ContractStore(join(tmpDir, "contracts.jsonl"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Create ────────────────────────────────────────────────────────

  it("should create a contract with active status", () => {
    const contract = store.create(makeParams());
    expect(contract.status).toBe("active");
    expect(contract.contract_id).toBeTruthy();
    expect(contract.delegator_node_id).toBe("node-A");
    expect(contract.delegatee_node_id).toBe("node-B");
    expect(contract.task_id).toBe("task-1");
    expect(contract.task_text).toBe("Analyze data");
    expect(contract.slo.max_duration_ms).toBe(60000);
    expect(contract.created_at).toBeTruthy();
  });

  it("should use default permission_boundary and monitoring", () => {
    const contract = store.create(makeParams());
    expect(contract.permission_boundary).toEqual({});
    expect(contract.monitoring).toEqual({ require_checkpoints: false });
  });

  it("should accept custom permission_boundary and monitoring", () => {
    const contract = store.create(makeParams({
      permission_boundary: { tool_allowlist: ["read-file"], max_permissions: 5 },
      monitoring: { require_checkpoints: true, report_interval_ms: 30000 },
    }));
    expect(contract.permission_boundary.tool_allowlist).toEqual(["read-file"]);
    expect(contract.monitoring.require_checkpoints).toBe(true);
  });

  it("should generate unique contract IDs", () => {
    const c1 = store.create(makeParams());
    const c2 = store.create(makeParams({ task_id: "task-2" }));
    expect(c1.contract_id).not.toBe(c2.contract_id);
  });

  // ─── Complete ──────────────────────────────────────────────────────

  it("should complete a contract successfully within SLO", () => {
    const contract = store.create(makeParams());
    const { violated } = store.complete(contract.contract_id, makeResult());
    expect(violated).toBe(false);
    expect(store.get(contract.contract_id)!.status).toBe("completed");
    expect(store.get(contract.contract_id)!.completed_at).toBeTruthy();
  });

  it("should mark violated when task failed", () => {
    const contract = store.create(makeParams());
    const { violated, reason } = store.complete(contract.contract_id, makeResult({ status: "failed" }));
    expect(violated).toBe(true);
    expect(reason).toContain("failed");
    expect(store.get(contract.contract_id)!.status).toBe("violated");
  });

  it("should mark violated when task aborted", () => {
    const contract = store.create(makeParams());
    const { violated, reason } = store.complete(contract.contract_id, makeResult({ status: "aborted" }));
    expect(violated).toBe(true);
    expect(reason).toContain("aborted");
  });

  it("should mark violated when duration exceeds SLO", () => {
    const contract = store.create(makeParams());
    const { violated, reason } = store.complete(contract.contract_id, makeResult({ duration_ms: 100000 }));
    expect(violated).toBe(true);
    expect(reason).toContain("Duration");
    expect(store.get(contract.contract_id)!.status).toBe("violated");
  });

  it("should mark violated when tokens exceed SLO", () => {
    const contract = store.create(makeParams());
    const { violated, reason } = store.complete(contract.contract_id, makeResult({ tokens_used: 50000 }));
    expect(violated).toBe(true);
    expect(reason).toContain("Tokens");
  });

  it("should mark violated when cost exceeds SLO", () => {
    const contract = store.create(makeParams());
    const { violated, reason } = store.complete(contract.contract_id, makeResult({ cost_usd: 5.0 }));
    expect(violated).toBe(true);
    expect(reason).toContain("Cost");
  });

  it("should return not violated for unknown contract", () => {
    const { violated } = store.complete("nonexistent", makeResult());
    expect(violated).toBe(false);
  });

  it("should check SLO violations in priority order (status first)", () => {
    const contract = store.create(makeParams());
    // Failed status + all SLO violations
    const { violated, reason } = store.complete(contract.contract_id, makeResult({
      status: "failed",
      duration_ms: 999999,
      tokens_used: 999999,
      cost_usd: 999,
    }));
    expect(violated).toBe(true);
    // Should report status violation first
    expect(reason).toContain("failed");
  });

  // ─── Cancel ────────────────────────────────────────────────────────

  it("should cancel a contract", () => {
    const contract = store.create(makeParams());
    store.cancel(contract.contract_id);
    expect(store.get(contract.contract_id)!.status).toBe("cancelled");
    expect(store.get(contract.contract_id)!.completed_at).toBeTruthy();
  });

  it("should handle cancelling non-existent contract gracefully", () => {
    expect(() => store.cancel("nonexistent")).not.toThrow();
  });

  // ─── Query ─────────────────────────────────────────────────────────

  it("should get contract by ID", () => {
    const contract = store.create(makeParams());
    expect(store.get(contract.contract_id)).toBeDefined();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("should get contract by task ID", () => {
    store.create(makeParams({ task_id: "task-99" }));
    expect(store.getByTaskId("task-99")).toBeDefined();
    expect(store.getByTaskId("nonexistent")).toBeUndefined();
  });

  it("should get active contracts", () => {
    store.create(makeParams({ task_id: "t1" }));
    const c2 = store.create(makeParams({ task_id: "t2" }));
    store.cancel(c2.contract_id);
    const active = store.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.task_id).toBe("t1");
  });

  it("should get all contracts", () => {
    store.create(makeParams({ task_id: "t1" }));
    store.create(makeParams({ task_id: "t2" }));
    expect(store.getAll()).toHaveLength(2);
  });

  it("should get contracts by status", () => {
    store.create(makeParams({ task_id: "t1" }));
    const c2 = store.create(makeParams({ task_id: "t2" }));
    store.cancel(c2.contract_id);
    expect(store.getByStatus("active")).toHaveLength(1);
    expect(store.getByStatus("cancelled")).toHaveLength(1);
    expect(store.getByStatus("completed")).toHaveLength(0);
  });

  // ─── Persistence ──────────────────────────────────────────────────

  it("should save and load contracts", async () => {
    store.create(makeParams({ task_id: "t1" }));
    const c2 = store.create(makeParams({ task_id: "t2" }));
    store.complete(c2.contract_id, makeResult({ task_id: "t2" }));
    await store.save();

    const store2 = new ContractStore(join(tmpDir, "contracts.jsonl"));
    await store2.load();
    expect(store2.size).toBe(2);
    expect(store2.getByTaskId("t1")!.status).toBe("active");
    expect(store2.getByTaskId("t2")!.status).toBe("completed");
  });

  it("should handle loading non-existent file", async () => {
    const store2 = new ContractStore(join(tmpDir, "nonexistent.jsonl"));
    await store2.load();
    expect(store2.getAll()).toHaveLength(0);
  });

  it("should report correct size", () => {
    expect(store.size).toBe(0);
    store.create(makeParams());
    expect(store.size).toBe(1);
  });
});
