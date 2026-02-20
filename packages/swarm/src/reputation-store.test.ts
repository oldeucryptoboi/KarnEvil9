import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ReputationStore } from "./reputation-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SwarmTaskResult } from "./types.js";

function makeResult(overrides: Partial<SwarmTaskResult> = {}): SwarmTaskResult {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    peer_session_id: "session-1",
    status: "completed",
    findings: [],
    tokens_used: 100,
    cost_usd: 0.01,
    duration_ms: 5000,
    ...overrides,
  };
}

describe("ReputationStore", () => {
  let tmpDir: string;
  let store: ReputationStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "rep-test-"));
    store = new ReputationStore(join(tmpDir, "reputations.jsonl"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Basic Operations ──────────────────────────────────────────────

  it("should return 0.5 for unknown peer", () => {
    expect(store.getTrustScore("unknown")).toBe(0.5);
  });

  it("should return undefined for unknown peer reputation", () => {
    expect(store.getReputation("unknown")).toBeUndefined();
  });

  it("should record a completed outcome", () => {
    store.recordOutcome("peer-1", makeResult());
    const rep = store.getReputation("peer-1");
    expect(rep).toBeDefined();
    expect(rep!.tasks_completed).toBe(1);
    expect(rep!.tasks_failed).toBe(0);
    expect(rep!.tasks_aborted).toBe(0);
    expect(rep!.consecutive_successes).toBe(1);
    expect(rep!.consecutive_failures).toBe(0);
  });

  it("should record a failed outcome", () => {
    store.recordOutcome("peer-1", makeResult({ status: "failed" }));
    const rep = store.getReputation("peer-1");
    expect(rep!.tasks_failed).toBe(1);
    expect(rep!.consecutive_failures).toBe(1);
    expect(rep!.consecutive_successes).toBe(0);
  });

  it("should record an aborted outcome", () => {
    store.recordOutcome("peer-1", makeResult({ status: "aborted" }));
    const rep = store.getReputation("peer-1");
    expect(rep!.tasks_aborted).toBe(1);
    expect(rep!.consecutive_failures).toBe(1);
  });

  it("should reset consecutive counters on status change", () => {
    store.recordOutcome("peer-1", makeResult());
    store.recordOutcome("peer-1", makeResult());
    expect(store.getReputation("peer-1")!.consecutive_successes).toBe(2);

    store.recordOutcome("peer-1", makeResult({ status: "failed" }));
    expect(store.getReputation("peer-1")!.consecutive_successes).toBe(0);
    expect(store.getReputation("peer-1")!.consecutive_failures).toBe(1);
  });

  it("should accumulate totals across outcomes", () => {
    store.recordOutcome("peer-1", makeResult({ tokens_used: 100, cost_usd: 0.01, duration_ms: 5000 }));
    store.recordOutcome("peer-1", makeResult({ tokens_used: 200, cost_usd: 0.02, duration_ms: 3000 }));
    const rep = store.getReputation("peer-1")!;
    expect(rep.total_tokens_used).toBe(300);
    expect(rep.total_cost_usd).toBeCloseTo(0.03);
    expect(rep.total_duration_ms).toBe(8000);
    expect(rep.avg_latency_ms).toBe(4000);
  });

  // ─── Trust Score Computation ───────────────────────────────────────

  it("should compute trust score above 0.5 for successful peer", () => {
    for (let i = 0; i < 5; i++) {
      store.recordOutcome("peer-1", makeResult());
    }
    expect(store.getTrustScore("peer-1")).toBeGreaterThan(0.5);
  });

  it("should compute trust score below 0.5 for failing peer", () => {
    for (let i = 0; i < 5; i++) {
      store.recordOutcome("peer-1", makeResult({ status: "failed" }));
    }
    expect(store.getTrustScore("peer-1")).toBeLessThan(0.5);
  });

  it("should clamp trust score between 0 and 1", () => {
    // Many successes
    for (let i = 0; i < 100; i++) {
      store.recordOutcome("good", makeResult({ peer_node_id: "good" }));
    }
    expect(store.getTrustScore("good")).toBeLessThanOrEqual(1);
    expect(store.getTrustScore("good")).toBeGreaterThanOrEqual(0);

    // Many failures
    for (let i = 0; i < 100; i++) {
      store.recordOutcome("bad", makeResult({ peer_node_id: "bad", status: "failed" }));
    }
    expect(store.getTrustScore("bad")).toBeLessThanOrEqual(1);
    expect(store.getTrustScore("bad")).toBeGreaterThanOrEqual(0);
  });

  it("should apply streak bonus for consecutive successes", () => {
    store.recordOutcome("peer-1", makeResult());
    const score1 = store.getTrustScore("peer-1");

    for (let i = 0; i < 5; i++) {
      store.recordOutcome("peer-1", makeResult());
    }
    const score2 = store.getTrustScore("peer-1");
    // Streak bonus should increase the score
    expect(score2).toBeGreaterThanOrEqual(score1);
  });

  it("should apply streak penalty for consecutive failures", () => {
    store.recordOutcome("peer-1", makeResult());
    const scoreAfterSuccess = store.getTrustScore("peer-1");

    store.recordOutcome("peer-1", makeResult({ status: "failed" }));
    store.recordOutcome("peer-1", makeResult({ status: "failed" }));
    store.recordOutcome("peer-1", makeResult({ status: "failed" }));
    const scoreAfterFails = store.getTrustScore("peer-1");

    expect(scoreAfterFails).toBeLessThan(scoreAfterSuccess);
  });

  it("should penalize high latency", () => {
    store.recordOutcome("fast", makeResult({ peer_node_id: "fast", duration_ms: 1000 }));
    store.recordOutcome("slow", makeResult({ peer_node_id: "slow", duration_ms: 250000 }));
    expect(store.getTrustScore("fast")).toBeGreaterThan(store.getTrustScore("slow"));
  });

  // ─── Decay ─────────────────────────────────────────────────────────

  it("should decay scores toward 0.5", () => {
    for (let i = 0; i < 10; i++) {
      store.recordOutcome("peer-1", makeResult());
    }
    const before = store.getTrustScore("peer-1");
    expect(before).toBeGreaterThan(0.5);

    store.decay(0.5);
    const after = store.getTrustScore("peer-1");
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0.5);
  });

  it("should decay low scores upward toward 0.5", () => {
    for (let i = 0; i < 10; i++) {
      store.recordOutcome("peer-1", makeResult({ status: "failed" }));
    }
    const before = store.getTrustScore("peer-1");
    expect(before).toBeLessThan(0.5);

    store.decay(0.5);
    const after = store.getTrustScore("peer-1");
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(0.5);
  });

  it("should use default decay factor", () => {
    for (let i = 0; i < 10; i++) {
      store.recordOutcome("peer-1", makeResult());
    }
    const before = store.getTrustScore("peer-1");
    store.decay();
    const after = store.getTrustScore("peer-1");
    expect(after).toBeLessThan(before);
  });

  // ─── Reset ─────────────────────────────────────────────────────────

  it("should reset a peer's reputation", () => {
    store.recordOutcome("peer-1", makeResult());
    expect(store.getReputation("peer-1")).toBeDefined();

    store.reset("peer-1");
    expect(store.getReputation("peer-1")).toBeUndefined();
    expect(store.getTrustScore("peer-1")).toBe(0.5);
  });

  // ─── getAllReputations ─────────────────────────────────────────────

  it("should return all reputations", () => {
    store.recordOutcome("peer-1", makeResult({ peer_node_id: "peer-1" }));
    store.recordOutcome("peer-2", makeResult({ peer_node_id: "peer-2" }));
    const all = store.getAllReputations();
    expect(all).toHaveLength(2);
  });

  // ─── JSONL Persistence ─────────────────────────────────────────────

  it("should save and load reputations", async () => {
    store.recordOutcome("peer-1", makeResult());
    store.recordOutcome("peer-2", makeResult({ peer_node_id: "peer-2", status: "failed" }));
    await store.save();

    const store2 = new ReputationStore(join(tmpDir, "reputations.jsonl"));
    await store2.load();

    expect(store2.getReputation("peer-1")!.tasks_completed).toBe(1);
    expect(store2.getReputation("peer-2")!.tasks_failed).toBe(1);
    expect(store2.getTrustScore("peer-1")).toBeGreaterThan(store2.getTrustScore("peer-2"));
  });

  it("should handle loading non-existent file", async () => {
    const store2 = new ReputationStore(join(tmpDir, "nonexistent.jsonl"));
    await store2.load();
    expect(store2.getAllReputations()).toHaveLength(0);
  });

  it("should handle loading empty file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tmpDir, "empty.jsonl"), "");
    const store2 = new ReputationStore(join(tmpDir, "empty.jsonl"));
    await store2.load();
    expect(store2.getAllReputations()).toHaveLength(0);
  });

  it("should report correct size", () => {
    expect(store.size).toBe(0);
    store.recordOutcome("peer-1", makeResult());
    expect(store.size).toBe(1);
    store.recordOutcome("peer-2", makeResult({ peer_node_id: "peer-2" }));
    expect(store.size).toBe(2);
  });

  it("should overwrite existing file on save", async () => {
    store.recordOutcome("peer-1", makeResult());
    await store.save();

    store.recordOutcome("peer-2", makeResult({ peer_node_id: "peer-2" }));
    await store.save();

    const store2 = new ReputationStore(join(tmpDir, "reputations.jsonl"));
    await store2.load();
    expect(store2.size).toBe(2);
  });
});
