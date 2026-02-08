import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Application } from "express";
import { RelayServer } from "./server.js";
import type { BrowserDriver, ActionRequest, ActionResult } from "./drivers/types.js";

// ── Mock driver ─────────────────────────────────────────────────────

function createMockDriver(overrides?: Partial<BrowserDriver>): BrowserDriver {
  return {
    execute: vi.fn<(req: ActionRequest) => Promise<ActionResult>>().mockResolvedValue({
      success: true,
      url: "https://example.com",
      title: "Example Domain",
    }),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isActive: vi.fn<() => boolean>().mockReturnValue(false),
    ...overrides,
  };
}

// ── Helper: make request to Express app via supertest-like fetch ─────

async function request(app: Application, method: string, path: string, body?: unknown) {
  // Start a temporary server to test against
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}${path}`;

  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json();
    return { status: response.status, body: json };
  } finally {
    server.close();
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe("RelayServer routes", () => {
  let driver: BrowserDriver;
  let relay: RelayServer;
  let app: Application;

  beforeAll(() => {
    driver = createMockDriver();
    relay = new RelayServer({ port: 0, driver });
    app = relay.getExpressApp();
  });

  afterAll(async () => {
    await relay.shutdown();
  });

  describe("GET /health", () => {
    it("returns status and driver info", async () => {
      const res = await request(app, "GET", "/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.driver).toBe("managed");
      expect(typeof res.body.browser_active).toBe("boolean");
      expect(typeof res.body.uptime_ms).toBe("number");
    });

    it("reflects active browser state", async () => {
      const activeDriver = createMockDriver({ isActive: vi.fn().mockReturnValue(true) });
      const activeRelay = new RelayServer({ port: 0, driver: activeDriver });
      const res = await request(activeRelay.getExpressApp(), "GET", "/health");
      expect(res.body.browser_active).toBe(true);
    });
  });

  describe("POST /actions", () => {
    it("delegates to driver.execute and returns 200 on success", async () => {
      const res = await request(app, "POST", "/actions", { action: "navigate", url: "https://example.com" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toBe("https://example.com");
      expect(driver.execute).toHaveBeenCalledWith({ action: "navigate", url: "https://example.com" });
    });

    it("returns 422 when action fails", async () => {
      const failDriver = createMockDriver({
        execute: vi.fn().mockResolvedValue({ success: false, error: "Element not found" }),
      });
      const failRelay = new RelayServer({ port: 0, driver: failDriver });
      const res = await request(failRelay.getExpressApp(), "POST", "/actions", { action: "click", target: { role: "button" } });
      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Element not found");
    });

    it("returns 500 when driver throws", async () => {
      const throwDriver = createMockDriver({
        execute: vi.fn().mockRejectedValue(new Error("Playwright crashed")),
      });
      const throwRelay = new RelayServer({ port: 0, driver: throwDriver });
      const res = await request(throwRelay.getExpressApp(), "POST", "/actions", { action: "navigate", url: "https://example.com" });
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Playwright crashed");
    });
  });

  describe("POST /close", () => {
    it("calls driver.close and returns closed: true", async () => {
      const res = await request(app, "POST", "/close");
      expect(res.status).toBe(200);
      expect(res.body.closed).toBe(true);
      expect(driver.close).toHaveBeenCalled();
    });

    it("returns 500 when close fails", async () => {
      const failCloseDriver = createMockDriver({
        close: vi.fn().mockRejectedValue(new Error("close failed")),
      });
      const failRelay = new RelayServer({ port: 0, driver: failCloseDriver });
      const res = await request(failRelay.getExpressApp(), "POST", "/close");
      expect(res.status).toBe(500);
      expect(res.body.closed).toBe(false);
      expect(res.body.error).toContain("close failed");
    });
  });
});
