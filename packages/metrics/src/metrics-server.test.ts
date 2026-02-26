import { describe, it, expect, beforeEach, vi } from "vitest";
import { Registry } from "prom-client";
import { MetricsCollector } from "./metrics-collector.js";
import { createMetricsRouter } from "./metrics-server.js";
import type { MetricsRouter } from "./metrics-server.js";

describe("createMetricsRouter", () => {
  let collector: MetricsCollector;
  let route: MetricsRouter;

  beforeEach(() => {
    const registry = new Registry();
    collector = new MetricsCollector({ registry, collectDefault: false });
    route = createMetricsRouter(collector);
  });

  it("returns a GET /metrics route", () => {
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/metrics");
  });

  it("handler returns Prometheus metrics text", async () => {
    let responseText = "";
    let responseContentType = "";

    const req = {
      method: "GET",
      path: "/metrics",
      params: {},
      query: {},
      body: undefined,
    };

    const res = {
      json: () => {},
      text: (data: string, contentType?: string) => {
        responseText = data;
        responseContentType = contentType ?? "";
      },
      status: (_code: number) => ({
        json: () => {},
        text: (data: string, contentType?: string) => {
          responseText = data;
          responseContentType = contentType ?? "";
        },
      }),
    };

    await route.handler(req, res);

    expect(responseText).toContain("# HELP");
    expect(responseContentType).toContain("text/plain");
  });

  it("handler includes collector metrics", async () => {
    // Add some data
    collector.handleEvent({
      event_id: "evt-1",
      timestamp: new Date().toISOString(),
      session_id: "sess-1",
      type: "session.created",
      payload: {},
    });

    let responseText = "";

    const req = { method: "GET", path: "/metrics", params: {}, query: {}, body: undefined };
    const res = {
      json: () => {},
      text: (data: string) => { responseText = data; },
      status: () => ({ json: () => {}, text: () => {} }),
    };

    await route.handler(req, res);

    expect(responseText).toContain("karnevil9_sessions_total");
    expect(responseText).toContain('status="created"');
  });

  it("handler returns 500 when collector.getMetrics() throws", async () => {
    vi.spyOn(collector, "getMetrics").mockRejectedValueOnce(new Error("Registry failure"));

    let statusCode = 0;
    let responseText = "";
    let responseContentType = "";

    const req = { method: "GET", path: "/metrics", params: {}, query: {}, body: undefined };
    const res = {
      json: () => {},
      text: () => {},
      status: (code: number) => {
        statusCode = code;
        return {
          json: () => {},
          text: (data: string, contentType?: string) => {
            responseText = data;
            responseContentType = contentType ?? "";
          },
        };
      },
    };

    await route.handler(req, res);

    expect(statusCode).toBe(500);
    expect(responseText).toContain("Error collecting metrics");
    expect(responseContentType).toContain("text/plain");
  });

  it("handler returns 500 with plain text content type on error", async () => {
    vi.spyOn(collector, "getMetrics").mockRejectedValueOnce(new TypeError("Unexpected"));

    let statusCode = 0;
    let responseContentType = "";

    const req = { method: "GET", path: "/metrics", params: {}, query: {}, body: undefined };
    const res = {
      json: () => {},
      text: () => {},
      status: (code: number) => {
        statusCode = code;
        return {
          json: () => {},
          text: (_data: string, contentType?: string) => {
            responseContentType = contentType ?? "";
          },
        };
      },
    };

    await route.handler(req, res);

    expect(statusCode).toBe(500);
    expect(responseContentType).toBe("text/plain; charset=utf-8");
  });
});
