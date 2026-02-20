import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskMonitor } from "./task-monitor.js";
import type { PeerTransport } from "./transport.js";
import type { JournalEventType } from "@karnevil9/schemas";

function makeMockTransport() {
  return {
    sendCheckpointRequest: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { task_id: "task-1", status: "running", progress_pct: 50, last_activity_at: new Date().toISOString() },
      latency_ms: 10,
    }),
    sendCancelTask: vi.fn().mockResolvedValue({ ok: true, status: 200, latency_ms: 5 }),
  } as unknown as PeerTransport;
}

describe("TaskMonitor", () => {
  let transport: ReturnType<typeof makeMockTransport>;
  let emitEvent: ReturnType<typeof vi.fn>;
  let onCheckpointsMissed: ReturnType<typeof vi.fn>;
  let monitor: TaskMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = makeMockTransport();
    emitEvent = vi.fn();
    onCheckpointsMissed = vi.fn();
    monitor = new TaskMonitor({
      transport,
      monitorConfig: { poll_interval_ms: 1000, max_missed_checkpoints: 3, checkpoint_timeout_ms: 5000 },
      emitEvent: emitEvent as (type: JournalEventType, payload: Record<string, unknown>) => void,
      onCheckpointsMissed,
      getPeerApiUrl: (nodeId: string) => nodeId === "peer-1" ? "http://peer-1:3100" : undefined,
    });
  });

  afterEach(() => {
    monitor.stopAll();
    vi.useRealTimers();
  });

  it("should start monitoring a task", () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    expect(monitor.size).toBe(1);
    expect(emitEvent).toHaveBeenCalledWith("swarm.task_monitoring_started", expect.objectContaining({ task_id: "task-1" }));
  });

  it("should not double-start monitoring", () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    expect(monitor.size).toBe(1);
  });

  it("should skip if peer API URL not found", () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "unknown-peer" });
    expect(monitor.size).toBe(0);
  });

  it("should stop monitoring a task", () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    monitor.stopMonitoring("task-1");
    expect(monitor.size).toBe(0);
    expect(emitEvent).toHaveBeenCalledWith("swarm.task_monitoring_stopped", expect.objectContaining({ task_id: "task-1" }));
  });

  it("should stop all monitored tasks", () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    monitor.startMonitoring({ task_id: "task-2", peer_node_id: "peer-1" });
    monitor.stopAll();
    expect(monitor.size).toBe(0);
  });

  it("should poll checkpoint on interval", async () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect((transport.sendCheckpointRequest as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("http://peer-1:3100", "task-1");
  });

  it("should emit checkpoint_received on success", async () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitEvent).toHaveBeenCalledWith("swarm.task_checkpoint_received", expect.objectContaining({
      task_id: "task-1",
      status: "running",
    }));
  });

  it("should reset missed count on successful checkpoint", async () => {
    // First make it fail once
    (transport.sendCheckpointRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500, latency_ms: 10 });
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    await vi.advanceTimersByTimeAsync(1000);

    const tasks = monitor.getMonitoredTasks();
    expect(tasks[0]?.missed_checkpoints).toBe(1);

    // Now succeed
    await vi.advanceTimersByTimeAsync(1000);
    const tasks2 = monitor.getMonitoredTasks();
    expect(tasks2[0]?.missed_checkpoints).toBe(0);
  });

  it("should increment missed count on failure", async () => {
    (transport.sendCheckpointRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, latency_ms: 10 });
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitEvent).toHaveBeenCalledWith("swarm.task_checkpoint_missed", expect.objectContaining({
      task_id: "task-1",
      missed_count: 1,
    }));
  });

  it("should escalate after max missed checkpoints", async () => {
    (transport.sendCheckpointRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, latency_ms: 10 });
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onCheckpointsMissed).toHaveBeenCalledWith("task-1", "peer-1");
    expect(monitor.size).toBe(0); // stopped after escalation
  });

  it("should auto-stop monitoring when task completes", async () => {
    (transport.sendCheckpointRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: { task_id: "task-1", status: "completed", last_activity_at: new Date().toISOString() },
      latency_ms: 5,
    });
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(monitor.size).toBe(0);
  });

  it("should auto-stop monitoring when task fails", async () => {
    (transport.sendCheckpointRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: { task_id: "task-1", status: "failed", last_activity_at: new Date().toISOString() },
      latency_ms: 5,
    });
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(monitor.size).toBe(0);
  });

  it("should use custom report_interval_ms", async () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1", report_interval_ms: 5000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((transport.sendCheckpointRequest as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect((transport.sendCheckpointRequest as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("should return monitored tasks info", () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    monitor.startMonitoring({ task_id: "task-2", peer_node_id: "peer-1" });
    const tasks = monitor.getMonitoredTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.task_id).toBe("task-1");
    expect(tasks[0]?.peer_node_id).toBe("peer-1");
    expect(tasks[0]?.missed_checkpoints).toBe(0);
  });

  it("should handle transport exception gracefully", async () => {
    (transport.sendCheckpointRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1" });
    await vi.advanceTimersByTimeAsync(1000);
    const tasks = monitor.getMonitoredTasks();
    expect(tasks[0]?.missed_checkpoints).toBe(1);
  });

  it("should emit monitoring_started with poll_interval_ms", () => {
    monitor.startMonitoring({ task_id: "task-1", peer_node_id: "peer-1", report_interval_ms: 2000 });
    expect(emitEvent).toHaveBeenCalledWith("swarm.task_monitoring_started", expect.objectContaining({
      poll_interval_ms: 2000,
    }));
  });
});
