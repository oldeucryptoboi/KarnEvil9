import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Journal } from "@openflaw/journal";
import { ToolRegistry } from "@openflaw/tools";
import type { ToolManifest } from "@openflaw/schemas";
import { ApiServer } from "./server.js";

const TEST_DIR = resolve(import.meta.dirname ?? ".", "../../.test-data");
const TEST_FILE = resolve(TEST_DIR, "api-journal.jsonl");

const testTool: ToolManifest = {
  name: "test-tool",
  version: "1.0.0",
  description: "A test tool",
  runner: "internal",
  input_schema: { type: "object", additionalProperties: false },
  output_schema: { type: "object", additionalProperties: false },
  permissions: [],
  timeout_ms: 5000,
  supports: { mock: true, dry_run: false },
};

async function fetch(url: string, opts?: { method?: string; body?: unknown }) {
  const { method = "GET", body } = opts ?? {};
  const parsed = new URL(url);
  return new Promise<{ status: number; json: () => Promise<any> }>((resolve, reject) => {
    const req = (parsed.protocol === "https:" ? require("node:https") : require("node:http")).request(
      url,
      { method, headers: body ? { "Content-Type": "application/json" } : {} },
      (res: any) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            json: async () => JSON.parse(data),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("ApiServer", () => {
  let journal: Journal;
  let registry: ToolRegistry;
  let apiServer: ApiServer;
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
    journal = new Journal(TEST_FILE);
    await journal.init();
    registry = new ToolRegistry();
    registry.register(testTool);
    apiServer = new ApiServer(registry, journal);

    await new Promise<void>((resolve) => {
      httpServer = createServer(apiServer.getExpressApp());
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  });

  it("GET /api/health returns ok", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.tools_loaded).toBe(1);
  });

  it("GET /api/tools lists registered tools", async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("test-tool");
  });

  it("GET /api/tools/:name returns tool details", async () => {
    const res = await fetch(`${baseUrl}/api/tools/test-tool`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("test-tool");
  });

  it("GET /api/tools/:name returns 404 for unknown tool", async () => {
    const res = await fetch(`${baseUrl}/api/tools/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("POST /api/sessions creates a task", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: { text: "Do something" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.text).toBe("Do something");
    expect(body.task.task_id).toBeTruthy();
  });

  it("POST /api/sessions returns 400 without text", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/sessions/:id returns 404 for unknown session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("GET /api/approvals returns empty list initially", async () => {
    const res = await fetch(`${baseUrl}/api/approvals`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toEqual([]);
  });

  it("POST /api/approvals/:id returns 404 for unknown approval", async () => {
    const res = await fetch(`${baseUrl}/api/approvals/nonexistent`, {
      method: "POST",
      body: { decision: "allow_once" },
    });
    expect(res.status).toBe(404);
  });

  it("resolves pending approvals", async () => {
    let resolvedDecision: string | null = null;
    apiServer.registerApproval("req-1", { tool: "test" }, (decision) => {
      resolvedDecision = decision;
    });

    const listRes = await fetch(`${baseUrl}/api/approvals`);
    const listBody = await listRes.json();
    expect(listBody.pending).toHaveLength(1);

    const res = await fetch(`${baseUrl}/api/approvals/req-1`, {
      method: "POST",
      body: { decision: "allow_session" },
    });
    expect(res.status).toBe(200);
    expect(resolvedDecision).toBe("allow_session");
  });

  it("POST /api/approvals/:id rejects invalid decision", async () => {
    apiServer.registerApproval("req-2", {}, () => {});
    const res = await fetch(`${baseUrl}/api/approvals/req-2`, {
      method: "POST",
      body: { decision: "invalid_decision" },
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/sessions/:id/journal returns events", async () => {
    await journal.emit("sess-1", "session.created", { task: "test" });
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/journal`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });

  it("POST /api/sessions/:id/replay returns events", async () => {
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/replay`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_count).toBe(2);
  });

  it("POST /api/sessions/:id/replay returns 404 for empty session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/replay`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
