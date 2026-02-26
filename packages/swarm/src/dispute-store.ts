import { readFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { v4 as uuid } from "uuid";
import type { DisputeRecord } from "./types.js";

export class DisputeStore {
  private disputes = new Map<string, DisputeRecord>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter((l) => l.length > 0);
      this.disputes.clear();
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as DisputeRecord;
          this.disputes.set(record.dispute_id, record);
        } catch {
          // Skip corrupted lines rather than losing all disputes
        }
      }
    } catch {
      this.disputes.clear();
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = [...this.disputes.values()];
    const content = entries.map((r) => JSON.stringify(r)).join("\n") + (entries.length > 0 ? "\n" : "");
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

  open(params: {
    task_id: string;
    contract_id: string;
    challenger_node_id: string;
    respondent_node_id: string;
    reason: string;
    evidence?: Record<string, unknown>;
  }): DisputeRecord {
    const record: DisputeRecord = {
      dispute_id: uuid(),
      task_id: params.task_id,
      contract_id: params.contract_id,
      challenger_node_id: params.challenger_node_id,
      respondent_node_id: params.respondent_node_id,
      reason: params.reason,
      status: "open",
      evidence: params.evidence,
      created_at: new Date().toISOString(),
    };
    this.disputes.set(record.dispute_id, record);
    return record;
  }

  resolve(disputeId: string, forChallenger: boolean, reason: string): DisputeRecord | null {
    const record = this.disputes.get(disputeId);
    if (!record || record.status !== "open") return null;

    record.status = forChallenger ? "resolved_for_challenger" : "resolved_for_respondent";
    record.resolved_at = new Date().toISOString();
    record.resolution_reason = reason;
    return record;
  }

  expire(disputeId: string): DisputeRecord | null {
    const record = this.disputes.get(disputeId);
    if (!record || record.status !== "open") return null;

    record.status = "expired";
    record.resolved_at = new Date().toISOString();
    record.resolution_reason = "Dispute window expired";
    return record;
  }

  getByTaskId(taskId: string): DisputeRecord | null {
    for (const record of this.disputes.values()) {
      if (record.task_id === taskId) return record;
    }
    return null;
  }

  get(disputeId: string): DisputeRecord | undefined {
    return this.disputes.get(disputeId);
  }

  getOpen(): DisputeRecord[] {
    return [...this.disputes.values()].filter((r) => r.status === "open");
  }

  getAll(): DisputeRecord[] {
    return [...this.disputes.values()];
  }

  get size(): number {
    return this.disputes.size;
  }
}
