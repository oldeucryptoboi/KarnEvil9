import { describe, it, expect, vi } from "vitest";
import { HeartbeatService } from "./heartbeat-service.js";

function makeClient(overrides = {}) {
  return {
    getHome: vi.fn().mockResolvedValue({
      your_account: { karma: 42, unread_notification_count: 3 },
    }),
    getDmRequests: vi.fn().mockResolvedValue({ requests: [{ id: "r1" }, { id: "r2" }] }),
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("HeartbeatService", () => {
  // ── Lifecycle ──

  it("starts and stops without errors", () => {
    const svc = new HeartbeatService({ client: makeClient(), logger: makeLogger() });
    svc.start();
    expect(svc._running).toBe(true);
    svc.stop();
    expect(svc._running).toBe(false);
  });

  it("start() is idempotent — second call is a no-op", () => {
    const logger = makeLogger();
    const svc = new HeartbeatService({ client: makeClient(), logger });
    svc.start();
    svc.start();
    expect(logger.info.mock.calls.filter((c) => c[0].includes("started"))).toHaveLength(1);
    svc.stop();
  });

  it("stop() clears the interval timer", () => {
    const svc = new HeartbeatService({ client: makeClient(), logger: makeLogger() });
    svc.start();
    expect(svc._timer).not.toBeNull();
    svc.stop();
    expect(svc._timer).toBeNull();
  });

  it("stop() logs a message", () => {
    const logger = makeLogger();
    const svc = new HeartbeatService({ client: makeClient(), logger });
    svc.start();
    svc.stop();
    expect(logger.info).toHaveBeenCalledWith("Moltbook heartbeat stopped");
  });

  // ── _tick() behavior (called directly to avoid setInterval) ──

  it("_tick() records last response and resets error count", async () => {
    const client = makeClient();
    const svc = new HeartbeatService({ client, logger: makeLogger() });
    svc._errorCount = 3;
    await svc._tick();
    expect(svc._lastResponse).toBeDefined();
    expect(svc._lastResponse.your_account.karma).toBe(42);
    expect(svc._lastCheckedAt).not.toBeNull();
    expect(svc._errorCount).toBe(0);
  });

  it("_tick() fetches pending DM count", async () => {
    const client = makeClient();
    const svc = new HeartbeatService({ client, logger: makeLogger() });
    await svc._tick();
    expect(client.getDmRequests).toHaveBeenCalled();
    expect(svc._pendingDmCount).toBe(2);
  });

  it("_tick() logs karma and unread count on success", async () => {
    const logger = makeLogger();
    const svc = new HeartbeatService({ client: makeClient(), logger });
    await svc._tick();
    expect(logger.info).toHaveBeenCalledWith("Moltbook heartbeat OK", { karma: 42, unread: 3, pendingDms: 2 });
  });

  it("_tick() handles DM fetch failure gracefully", async () => {
    const client = makeClient({
      getDmRequests: vi.fn().mockRejectedValue(new Error("DM API down")),
    });
    const svc = new HeartbeatService({ client, logger: makeLogger() });
    svc._pendingDmCount = 5;
    await svc._tick();
    expect(svc._errorCount).toBe(0);
    expect(svc._pendingDmCount).toBe(5); // preserved from before
  });

  it("_tick() increments error count on getHome failure", async () => {
    const client = makeClient({
      getHome: vi.fn().mockRejectedValue(new Error("Network error")),
    });
    const logger = makeLogger();
    const svc = new HeartbeatService({ client, logger });
    await svc._tick();
    expect(svc._errorCount).toBe(1);
    expect(logger.error).toHaveBeenCalledWith("Moltbook heartbeat failed", {
      error: "Network error",
      errorCount: 1,
    });
  });

  it("_tick() accumulates error count across failures", async () => {
    const client = makeClient({
      getHome: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const svc = new HeartbeatService({ client, logger: makeLogger() });
    await svc._tick();
    await svc._tick();
    await svc._tick();
    expect(svc._errorCount).toBe(3);
  });

  // ── health() ──

  it("health() returns ok:true when running with low error count", async () => {
    const svc = new HeartbeatService({ client: makeClient(), logger: makeLogger() });
    svc._running = true;
    await svc._tick();
    const h = svc.health();
    expect(h.ok).toBe(true);
    expect(h.lastCheckedAt).not.toBeNull();
    expect(h.errorCount).toBe(0);
    expect(h.pendingDmCount).toBe(2);
    expect(h.lastResponse).toBeDefined();
  });

  it("health() returns ok:false when error count >= 5", () => {
    const svc = new HeartbeatService({ client: makeClient(), logger: makeLogger() });
    svc._running = true;
    svc._errorCount = 5;
    expect(svc.health().ok).toBe(false);
  });

  it("health() returns ok:false when not running", () => {
    const svc = new HeartbeatService({ client: makeClient(), logger: makeLogger() });
    expect(svc.health().ok).toBe(false);
  });

  // ── DM response shape variants ──

  it("handles getDmRequests returning array directly", async () => {
    const client = makeClient({
      getDmRequests: vi.fn().mockResolvedValue([{ id: "r1" }]),
    });
    const svc = new HeartbeatService({ client, logger: makeLogger() });
    await svc._tick();
    expect(svc._pendingDmCount).toBe(1);
  });

  it("handles getDmRequests returning data array", async () => {
    const client = makeClient({
      getDmRequests: vi.fn().mockResolvedValue({ data: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] }),
    });
    const svc = new HeartbeatService({ client, logger: makeLogger() });
    await svc._tick();
    expect(svc._pendingDmCount).toBe(3);
  });

  // ── Edge cases ──

  it("works without a logger", async () => {
    const svc = new HeartbeatService({ client: makeClient() });
    await svc._tick();
    expect(svc._errorCount).toBe(0);
    expect(svc._lastResponse).toBeDefined();
  });

  it("handles missing your_account in response", async () => {
    const client = makeClient({ getHome: vi.fn().mockResolvedValue({}) });
    const logger = makeLogger();
    const svc = new HeartbeatService({ client, logger });
    await svc._tick();
    expect(svc._errorCount).toBe(0);
    expect(logger.info).toHaveBeenCalledWith("Moltbook heartbeat OK", {
      karma: undefined,
      unread: 0,
      pendingDms: 2,
    });
  });
});
