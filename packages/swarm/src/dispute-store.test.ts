import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DisputeStore } from "./dispute-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("DisputeStore", () => {
  let tmpDir: string;
  let store: DisputeStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispute-store-"));
    store = new DisputeStore(join(tmpDir, "disputes.jsonl"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("opens a dispute and assigns an ID", () => {
    const record = store.open({
      task_id: "task-1",
      contract_id: "contract-1",
      challenger_node_id: "node-a",
      respondent_node_id: "node-b",
      reason: "SLO violated",
    });
    expect(record.dispute_id).toBeTruthy();
    expect(record.status).toBe("open");
    expect(record.task_id).toBe("task-1");
    expect(record.created_at).toBeTruthy();
    expect(store.size).toBe(1);
  });

  it("resolves dispute for challenger", () => {
    const record = store.open({
      task_id: "task-1",
      contract_id: "contract-1",
      challenger_node_id: "node-a",
      respondent_node_id: "node-b",
      reason: "Bad result",
    });
    const resolved = store.resolve(record.dispute_id, true, "Peer confirmed SLO breach");
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved_for_challenger");
    expect(resolved!.resolved_at).toBeTruthy();
    expect(resolved!.resolution_reason).toBe("Peer confirmed SLO breach");
  });

  it("resolves dispute for respondent", () => {
    const record = store.open({
      task_id: "task-1",
      contract_id: "contract-1",
      challenger_node_id: "node-a",
      respondent_node_id: "node-b",
      reason: "Claim disputed",
    });
    const resolved = store.resolve(record.dispute_id, false, "SLO was within bounds");
    expect(resolved!.status).toBe("resolved_for_respondent");
  });

  it("cannot resolve already resolved dispute", () => {
    const record = store.open({
      task_id: "task-1",
      contract_id: "contract-1",
      challenger_node_id: "node-a",
      respondent_node_id: "node-b",
      reason: "Test",
    });
    store.resolve(record.dispute_id, true, "Done");
    const result = store.resolve(record.dispute_id, false, "Try again");
    expect(result).toBeNull();
  });

  it("expires a dispute", () => {
    const record = store.open({
      task_id: "task-1",
      contract_id: "contract-1",
      challenger_node_id: "node-a",
      respondent_node_id: "node-b",
      reason: "Test",
    });
    const expired = store.expire(record.dispute_id);
    expect(expired!.status).toBe("expired");
  });

  it("getByTaskId returns the dispute for a task", () => {
    store.open({
      task_id: "task-x",
      contract_id: "contract-1",
      challenger_node_id: "node-a",
      respondent_node_id: "node-b",
      reason: "Test",
    });
    expect(store.getByTaskId("task-x")).not.toBeNull();
    expect(store.getByTaskId("nonexistent")).toBeNull();
  });

  it("getOpen returns only open disputes", () => {
    const r1 = store.open({
      task_id: "task-1",
      contract_id: "c1",
      challenger_node_id: "a",
      respondent_node_id: "b",
      reason: "r1",
    });
    store.open({
      task_id: "task-2",
      contract_id: "c2",
      challenger_node_id: "a",
      respondent_node_id: "c",
      reason: "r2",
    });
    store.resolve(r1.dispute_id, true, "done");
    const open = store.getOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.task_id).toBe("task-2");
  });

  it("persists and loads disputes across instances", async () => {
    store.open({
      task_id: "task-1",
      contract_id: "c1",
      challenger_node_id: "a",
      respondent_node_id: "b",
      reason: "persist test",
      evidence: { key: "value" },
    });
    await store.save();

    const store2 = new DisputeStore(join(tmpDir, "disputes.jsonl"));
    await store2.load();
    expect(store2.size).toBe(1);
    const loaded = store2.getByTaskId("task-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.reason).toBe("persist test");
    expect(loaded!.evidence).toEqual({ key: "value" });
  });

  it("handles load of nonexistent file gracefully", async () => {
    const store2 = new DisputeStore(join(tmpDir, "nonexistent.jsonl"));
    await store2.load();
    expect(store2.size).toBe(0);
  });

  it("returns null for resolve of nonexistent dispute", () => {
    expect(store.resolve("nonexistent", true, "x")).toBeNull();
  });
});
