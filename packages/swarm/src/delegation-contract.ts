import { readFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { v4 as uuid } from "uuid";
import type { JournalEventType } from "@karnevil9/schemas";
import type {
  DelegationContract,
  ContractSLO,
  ContractPermissionBoundary,
  ContractMonitoring,
  ContractStatus,
  SwarmTaskResult,
  DataAccessScope,
  TaskAttribute,
  RenegotiationRequest,
  RenegotiationOutcome,
} from "./types.js";

export interface CreateContractParams {
  delegator_node_id: string;
  delegatee_node_id: string;
  task_id: string;
  task_text: string;
  slo: ContractSLO;
  permission_boundary?: ContractPermissionBoundary;
  monitoring?: ContractMonitoring;
  data_access_scope?: DataAccessScope;
  dispute_window_ms?: number;
  task_attributes?: TaskAttribute;
}

export class ContractStore {
  private contracts = new Map<string, DelegationContract>();
  private filePath: string;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  constructor(filePath: string, emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.filePath = filePath;
    this.emitEvent = emitEvent;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      this.contracts.clear();
      for (const line of lines) {
        try {
          const contract = JSON.parse(line) as DelegationContract;
          this.contracts.set(contract.contract_id, contract);
        } catch {
          // Skip corrupted lines rather than losing all contracts
        }
      }
    } catch {
      this.contracts.clear();
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = [...this.contracts.values()];
    const content = entries.map(c => JSON.stringify(c)).join("\n") + (entries.length > 0 ? "\n" : "");
    const tmpPath = this.filePath + ".tmp";
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(content, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }

  create(params: CreateContractParams): DelegationContract {
    const contract: DelegationContract = {
      contract_id: uuid(),
      delegator_node_id: params.delegator_node_id,
      delegatee_node_id: params.delegatee_node_id,
      task_id: params.task_id,
      task_text: params.task_text,
      slo: params.slo,
      permission_boundary: params.permission_boundary ?? {},
      monitoring: params.monitoring ?? { require_checkpoints: false },
      status: "active",
      created_at: new Date().toISOString(),
      data_access_scope: params.data_access_scope,
      dispute_window_ms: params.dispute_window_ms,
      task_attributes: params.task_attributes,
    };
    this.contracts.set(contract.contract_id, contract);
    return contract;
  }

  complete(contractId: string, result: SwarmTaskResult): { violated: boolean; reason?: string } {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      return { violated: false };
    }

    contract.completed_at = new Date().toISOString();

    if (result.status !== "completed") {
      contract.status = "violated";
      contract.violation_reason = `Task ${result.status}`;
      return { violated: true, reason: contract.violation_reason };
    }

    if (result.duration_ms > contract.slo.max_duration_ms) {
      contract.status = "violated";
      contract.violation_reason = `Duration ${result.duration_ms}ms exceeded SLO ${contract.slo.max_duration_ms}ms`;
      return { violated: true, reason: contract.violation_reason };
    }

    if (result.tokens_used > contract.slo.max_tokens) {
      contract.status = "violated";
      contract.violation_reason = `Tokens ${result.tokens_used} exceeded SLO ${contract.slo.max_tokens}`;
      return { violated: true, reason: contract.violation_reason };
    }

    if (result.cost_usd > contract.slo.max_cost_usd) {
      contract.status = "violated";
      contract.violation_reason = `Cost $${result.cost_usd} exceeded SLO $${contract.slo.max_cost_usd}`;
      return { violated: true, reason: contract.violation_reason };
    }

    contract.status = "completed";
    return { violated: false };
  }

  cancel(contractId: string): void {
    const contract = this.contracts.get(contractId);
    if (contract) {
      contract.status = "cancelled";
      contract.completed_at = new Date().toISOString();
    }
  }

  get(contractId: string): DelegationContract | undefined {
    return this.contracts.get(contractId);
  }

  getByTaskId(taskId: string): DelegationContract | undefined {
    for (const contract of this.contracts.values()) {
      if (contract.task_id === taskId) return contract;
    }
    return undefined;
  }

  getActive(): DelegationContract[] {
    return [...this.contracts.values()].filter(c => c.status === "active");
  }

  getAll(): DelegationContract[] {
    return [...this.contracts.values()];
  }

  getByStatus(status: ContractStatus): DelegationContract[] {
    return [...this.contracts.values()].filter(c => c.status === status);
  }

  // ─── Renegotiation (Gap 6) ──────────────────────────────────────

  requestRenegotiation(contractId: string, requesterNodeId: string, proposedSlo: Partial<ContractSLO>, reason: string): RenegotiationRequest | undefined {
    const contract = this.contracts.get(contractId);
    if (!contract || contract.status !== "active") return undefined;
    if (contract.pending_renegotiation) return undefined; // one at a time

    const request: RenegotiationRequest = {
      request_id: uuid(),
      contract_id: contractId,
      requester_node_id: requesterNodeId,
      proposed_slo: proposedSlo,
      reason,
      status: "pending",
      created_at: new Date().toISOString(),
    };

    contract.pending_renegotiation = request;

    this.emitEvent?.("swarm.contract_renegotiation_requested" as JournalEventType, {
      contract_id: contractId,
      request_id: request.request_id,
      requester_node_id: requesterNodeId,
      reason,
    });

    return request;
  }

  acceptRenegotiation(contractId: string, requestId: string): RenegotiationOutcome | undefined {
    const contract = this.contracts.get(contractId);
    if (!contract || !contract.pending_renegotiation) return undefined;
    if (contract.pending_renegotiation.request_id !== requestId) return undefined;

    const request = contract.pending_renegotiation;

    // Preserve original SLO if not already saved
    if (!contract.original_slo) {
      contract.original_slo = { ...contract.slo };
    }

    // Apply proposed SLO changes
    const newSlo: ContractSLO = {
      ...contract.slo,
      ...request.proposed_slo,
    };
    contract.slo = newSlo;

    // Record in history
    request.status = "accepted";
    request.resolved_at = new Date().toISOString();
    if (!contract.renegotiation_history) {
      contract.renegotiation_history = [];
    }
    contract.renegotiation_history.push(request);
    contract.pending_renegotiation = undefined;

    this.emitEvent?.("swarm.contract_renegotiation_accepted" as JournalEventType, {
      contract_id: contractId,
      request_id: requestId,
      new_slo: newSlo,
    });

    return { request_id: requestId, accepted: true, new_slo: newSlo };
  }

  rejectRenegotiation(contractId: string, requestId: string, reason?: string): RenegotiationOutcome | undefined {
    const contract = this.contracts.get(contractId);
    if (!contract || !contract.pending_renegotiation) return undefined;
    if (contract.pending_renegotiation.request_id !== requestId) return undefined;

    const request = contract.pending_renegotiation;
    request.status = "rejected";
    request.resolved_at = new Date().toISOString();

    if (!contract.renegotiation_history) {
      contract.renegotiation_history = [];
    }
    contract.renegotiation_history.push(request);
    contract.pending_renegotiation = undefined;

    this.emitEvent?.("swarm.contract_renegotiation_rejected" as JournalEventType, {
      contract_id: contractId,
      request_id: requestId,
      reason,
    });

    return { request_id: requestId, accepted: false, reason };
  }

  getRenegotiationHistory(contractId: string): RenegotiationRequest[] {
    const contract = this.contracts.get(contractId);
    return contract?.renegotiation_history ?? [];
  }

  getPendingRenegotiation(contractId: string): RenegotiationRequest | undefined {
    return this.contracts.get(contractId)?.pending_renegotiation;
  }

  get size(): number {
    return this.contracts.size;
  }
}
