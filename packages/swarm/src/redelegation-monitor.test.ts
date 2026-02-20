import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedelegationMonitor } from "./redelegation-monitor.js";

describe("RedelegationMonitor", () => {
  let monitor: RedelegationMonitor;

  beforeEach(() => {
    monitor = new RedelegationMonitor({ max_redelegations: 2, redelegation_cooldown_ms: 100 });
  });

  // ─── Track ─────────────────────────────────────────────────────────

  it("should track a delegation", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    expect(monitor.size).toBe(1);
    const tracked = monitor.getTrackedDelegations();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.task_id).toBe("task-1");
    expect(tracked[0]!.peer_node_id).toBe("peer-A");
    expect(tracked[0]!.redelegation_count).toBe(0);
  });

  it("should track delegation with constraints", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1", { max_tokens: 1000 });
    expect(monitor.size).toBe(1);
  });

  // ─── Check Peer Health ─────────────────────────────────────────────

  it("should identify tasks needing redelegation when peer degrades", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    monitor.trackDelegation("task-2", "peer-B", "Do other", "session-2");

    const tasks = monitor.checkPeerHealth(["peer-A"]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task_id).toBe("task-1");
    expect(tasks[0]!.old_peer).toBe("peer-A");
    expect(tasks[0]!.task_text).toBe("Do something");
    expect(tasks[0]!.session_id).toBe("session-1");
  });

  it("should return empty when no peers are degraded", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    const tasks = monitor.checkPeerHealth(["peer-C"]);
    expect(tasks).toHaveLength(0);
  });

  it("should not return tasks that exceeded max redelegations", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    monitor.recordRedelegation("task-1", "peer-B");
    monitor.recordRedelegation("task-1", "peer-C");
    // Max is 2, so no more redelegations allowed
    const tasks = monitor.checkPeerHealth(["peer-C"]);
    expect(tasks).toHaveLength(0);
  });

  it("should respect cooldown period", async () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    monitor.recordRedelegation("task-1", "peer-B");

    // Immediately after redelegation, cooldown should block
    const tasks1 = monitor.checkPeerHealth(["peer-B"]);
    expect(tasks1).toHaveLength(0);

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));
    const tasks2 = monitor.checkPeerHealth(["peer-B"]);
    expect(tasks2).toHaveLength(1);
  });

  it("should return constraints and excluded peers in check result", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1", { max_tokens: 500 });
    const tasks = monitor.checkPeerHealth(["peer-A"]);
    expect(tasks[0]!.constraints).toEqual({ max_tokens: 500 });
    expect(tasks[0]!.excluded_peers).toBeInstanceOf(Set);
  });

  // ─── Record Redelegation ───────────────────────────────────────────

  it("should record a redelegation", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    const ok = monitor.recordRedelegation("task-1", "peer-B");
    expect(ok).toBe(true);
    expect(monitor.getRedelegationCount("task-1")).toBe(1);

    const tracked = monitor.getTrackedDelegations();
    expect(tracked[0]!.peer_node_id).toBe("peer-B");
  });

  it("should return false when max redelegations exceeded", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    expect(monitor.recordRedelegation("task-1", "peer-B")).toBe(true);
    expect(monitor.recordRedelegation("task-1", "peer-C")).toBe(true);
    expect(monitor.recordRedelegation("task-1", "peer-D")).toBe(false);
    expect(monitor.getRedelegationCount("task-1")).toBe(2);
  });

  it("should return false for unknown task", () => {
    expect(monitor.recordRedelegation("unknown", "peer-B")).toBe(false);
  });

  it("should track excluded peers across redelegations", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    monitor.recordRedelegation("task-1", "peer-B");

    // peer-A should be in excluded peers after redelegation
    const tasks = monitor.checkPeerHealth(["peer-B"]);
    // Need to wait for cooldown first, so let's use a fresh monitor
    const monitor2 = new RedelegationMonitor({ max_redelegations: 3, redelegation_cooldown_ms: 0 });
    monitor2.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    monitor2.recordRedelegation("task-1", "peer-B");
    const tasks2 = monitor2.checkPeerHealth(["peer-B"]);
    expect(tasks2).toHaveLength(1);
    expect(tasks2[0]!.excluded_peers.has("peer-A")).toBe(true);
  });

  // ─── Remove ────────────────────────────────────────────────────────

  it("should remove a delegation", () => {
    monitor.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    expect(monitor.size).toBe(1);
    monitor.removeDelegation("task-1");
    expect(monitor.size).toBe(0);
  });

  it("should handle removing non-existent delegation", () => {
    expect(() => monitor.removeDelegation("nonexistent")).not.toThrow();
  });

  // ─── getRedelegationCount ──────────────────────────────────────────

  it("should return 0 for unknown task", () => {
    expect(monitor.getRedelegationCount("unknown")).toBe(0);
  });

  // ─── Default config ───────────────────────────────────────────────

  it("should use default config values", () => {
    const m = new RedelegationMonitor();
    m.trackDelegation("task-1", "peer-A", "Do something", "session-1");
    expect(m.size).toBe(1);
  });
});
