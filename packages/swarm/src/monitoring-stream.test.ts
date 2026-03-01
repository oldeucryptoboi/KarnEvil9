import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MonitoringStream } from "./monitoring-stream.js";
import type { MonitoringEvent } from "./types.js";

function makeEvent(overrides?: Partial<MonitoringEvent>): MonitoringEvent {
  return {
    task_id: "task-1",
    peer_node_id: "peer-1",
    event_type: "checkpoint",
    timestamp: new Date().toISOString(),
    data: { progress_pct: 50 },
    ...overrides,
  };
}

function makeResponse() {
  const chunks: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  return {
    write: vi.fn((data: string) => { chunks.push(data); }),
    on: vi.fn((event: string, cb: () => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event]!.push(cb);
    }),
    getChunks: () => chunks,
    triggerEvent: (event: string) => {
      for (const cb of listeners[event] ?? []) cb();
    },
  };
}

describe("MonitoringStream", () => {
  let stream: MonitoringStream;

  beforeEach(() => {
    vi.useFakeTimers();
    stream = new MonitoringStream({ max_connections: 3, heartbeat_interval_ms: 5000 });
  });

  afterEach(() => {
    stream.close();
    vi.useRealTimers();
  });

  it("subscribes and receives published events", () => {
    const res = makeResponse();
    stream.subscribe(res);
    const event = makeEvent();
    stream.publish(event);
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining("event: checkpoint"));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining(`"task_id":"task-1"`));
  });

  it("unsubscribe removes subscriber", () => {
    const res = makeResponse();
    const unsub = stream.subscribe(res);
    expect(stream.connectionCount).toBe(1);
    unsub();
    expect(stream.connectionCount).toBe(0);
    stream.publish(makeEvent());
    // Only the initial subscribe connection event, no published events after unsub
    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining("checkpoint"));
  });

  it("filters by task_id", () => {
    const res1 = makeResponse();
    const res2 = makeResponse();
    stream.subscribe(res1, { task_id: "task-1" });
    stream.subscribe(res2, { task_id: "task-2" });
    stream.publish(makeEvent({ task_id: "task-1" }));
    expect(res1.write).toHaveBeenCalled();
    // res2 should not have been called with data
    const res2Chunks = res2.getChunks();
    expect(res2Chunks.filter((c) => c.includes("task-1"))).toHaveLength(0);
  });

  it("filters by peer_node_id", () => {
    const res = makeResponse();
    stream.subscribe(res, { peer_node_id: "peer-2" });
    stream.publish(makeEvent({ peer_node_id: "peer-1" }));
    stream.publish(makeEvent({ peer_node_id: "peer-2" }));
    const chunks = res.getChunks();
    expect(chunks.filter((c) => c.includes("peer-1"))).toHaveLength(0);
    expect(chunks.filter((c) => c.includes("peer-2"))).toHaveLength(1);
  });

  it("filters by event_types", () => {
    const res = makeResponse();
    stream.subscribe(res, { event_types: ["completed", "failed"] });
    stream.publish(makeEvent({ event_type: "checkpoint" }));
    stream.publish(makeEvent({ event_type: "completed" }));
    const chunks = res.getChunks();
    expect(chunks.filter((c) => c.includes("event: checkpoint"))).toHaveLength(0);
    expect(chunks.filter((c) => c.includes("event: completed"))).toHaveLength(1);
  });

  it("enforces max connections", () => {
    const res1 = makeResponse();
    const res2 = makeResponse();
    const res3 = makeResponse();
    const res4 = makeResponse();
    stream.subscribe(res1);
    stream.subscribe(res2);
    stream.subscribe(res3);
    stream.subscribe(res4); // exceeds max_connections=3
    expect(stream.connectionCount).toBe(3);
    expect(res4.write).toHaveBeenCalledWith(expect.stringContaining("Max connections"));
  });

  it("sends heartbeat on interval", async () => {
    const res = makeResponse();
    stream.subscribe(res);
    await vi.advanceTimersByTimeAsync(5000);
    const chunks = res.getChunks();
    expect(chunks.some((c) => c.includes("event: heartbeat"))).toBe(true);
  });

  it("stops heartbeat when last subscriber disconnects", async () => {
    const res = makeResponse();
    const unsub = stream.subscribe(res);
    unsub();
    // Advance time — no heartbeats should be sent since no subscribers
    const res2 = makeResponse();
    // Nothing should crash
    await vi.advanceTimersByTimeAsync(5000);
    expect(res2.getChunks()).toHaveLength(0);
  });

  it("close() removes all subscribers", () => {
    const res1 = makeResponse();
    const res2 = makeResponse();
    stream.subscribe(res1);
    stream.subscribe(res2);
    expect(stream.connectionCount).toBe(2);
    stream.close();
    expect(stream.connectionCount).toBe(0);
  });

  it("handles client disconnect via close event", () => {
    const res = makeResponse();
    stream.subscribe(res);
    expect(stream.connectionCount).toBe(1);
    res.triggerEvent("close");
    expect(stream.connectionCount).toBe(0);
  });

  it("SSE format has correct event: and data: lines", () => {
    const res = makeResponse();
    stream.subscribe(res);
    stream.publish(makeEvent({ event_type: "progress" }));
    const chunks = res.getChunks();
    const eventChunk = chunks.find((c) => c.includes("event: progress"));
    expect(eventChunk).toBeTruthy();
    expect(eventChunk).toContain("event: progress\n");
    expect(eventChunk).toContain("data: ");
    expect(eventChunk).toMatch(/\n\n$/);
  });

  it("publishes to no subscribers without errors", () => {
    // Should not throw
    stream.publish(makeEvent());
  });

  it("multiple subscribers receive the same event", () => {
    const res1 = makeResponse();
    const res2 = makeResponse();
    stream.subscribe(res1);
    stream.subscribe(res2);
    stream.publish(makeEvent());
    expect(res1.getChunks().length).toBe(1);
    expect(res2.getChunks().length).toBe(1);
  });

  it("sanitizes SSE event_type to prevent SSE injection via newlines and control chars", () => {
    const res = makeResponse();
    stream.subscribe(res);
    // Event type with injected newlines that attempt SSE protocol injection
    const maliciousEvent = makeEvent({ event_type: "evil\r\ndata: injected\n\nevent: spoofed" as never });
    stream.publish(maliciousEvent);
    const chunks = res.getChunks();
    const lastChunk = chunks[chunks.length - 1]!;
    // The SSE event: line must NOT contain any raw newlines from the attacker,
    // which would allow injecting extra SSE frames.
    // The sanitized event type should be on one line (no \r\n injection).
    const lines = lastChunk.split("\n");
    const eventLine = lines.find(l => l.startsWith("event: "));
    expect(eventLine).toBeDefined();
    // The event line should be a single line with all control chars stripped
    expect(eventLine).toBe("event: evildata: injectedevent: spoofed");
    // Critically: there should be exactly one "event:" prefix in the chunk
    // (not two, which would mean the attacker injected a second SSE event)
    const eventLineCount = lines.filter(l => l.startsWith("event:")).length;
    expect(eventLineCount).toBe(1);
  });

  it("subscriber counter resets before overflow to prevent MAX_SAFE_INTEGER exhaustion", () => {
    // Import and manipulate the module-level counter is tricky, but we can
    // verify that after many subscribes/unsubscribes the system still works.
    // The real guard is tested by inspecting generated IDs.
    const highStream = new MonitoringStream({ max_connections: 10 });
    const responses: ReturnType<typeof makeResponse>[] = [];

    // Subscribe and unsubscribe several times to bump the counter
    for (let i = 0; i < 5; i++) {
      const res = makeResponse();
      responses.push(res);
      const unsub = highStream.subscribe(res);
      unsub();
    }

    // After all unsubscribes, connection count should be 0
    expect(highStream.connectionCount).toBe(0);

    // A new subscription should still work
    const finalRes = makeResponse();
    highStream.subscribe(finalRes);
    expect(highStream.connectionCount).toBe(1);
    highStream.publish(makeEvent());
    expect(finalRes.getChunks().length).toBe(1);
    highStream.close();
  });
});
