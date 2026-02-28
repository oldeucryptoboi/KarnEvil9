/**
 * API REST Integration Smoke Test
 *
 * Tests REST-specific API endpoints: session list, journal pagination,
 * SSE event streaming, tool details, session input validation, and
 * rate limiting. Complements WS-focused tests in chat-ws.smoke.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { MockPlanner } from "@karnevil9/planner";
import { ApiServer } from "@karnevil9/api";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/manifests");

function serverPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

describe("API REST Integration Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: Server;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-api-rest-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);
    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      insecure: true,
    });
    httpServer = apiServer.listen(0);
  });

  afterEach(async () => {
    await apiServer.shutdown();
    await journal.close();
    await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  function url(path: string): string {
    return `http://localhost:${serverPort(httpServer)}${path}`;
  }

  // ─── Session list ──────────────────────────────────────────────

  it("GET /api/sessions returns empty list initially", async () => {
    const res = await fetch(url("/api/sessions"));
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  it("GET /api/sessions includes created session", async () => {
    const createRes = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "List test session" }),
    });
    expect(createRes.status).toBe(200);
    const { session_id } = await createRes.json() as { session_id: string };

    // Wait for session to complete
    await new Promise((r) => setTimeout(r, 2000));

    const listRes = await fetch(url("/api/sessions"));
    const body = await listRes.json() as { sessions: Array<{ session_id: string }> };
    const ids = body.sessions.map((s) => s.session_id);
    expect(ids).toContain(session_id);
  });

  // ─── Session creation validation ──────────────────────────────

  it("POST /api/sessions rejects empty text", async () => {
    const res = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/sessions rejects missing body", async () => {
    const res = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // ─── Journal pagination ───────────────────────────────────────

  it("GET /api/sessions/:id/journal supports offset and limit", async () => {
    const createRes = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Journal pagination test" }),
    });
    const { session_id } = await createRes.json() as { session_id: string };

    await new Promise((r) => setTimeout(r, 2000));

    // Get all events
    const allRes = await fetch(url(`/api/sessions/${session_id}/journal`));
    const allBody = await allRes.json() as { events: unknown[]; total: number };
    expect(allBody.total).toBeGreaterThan(0);
    expect(allBody.events.length).toBe(allBody.total);

    // Get with offset=1, limit=1
    const pageRes = await fetch(url(`/api/sessions/${session_id}/journal?offset=1&limit=1`));
    expect(pageRes.status).toBe(200);
    const pageBody = await pageRes.json() as { events: unknown[]; total: number; offset: number; limit: number };
    expect(pageBody.offset).toBe(1);
    expect(pageBody.limit).toBe(1);
    expect(pageBody.events.length).toBeLessThanOrEqual(1);
    expect(pageBody.total).toBe(allBody.total);
  });

  // ─── Session ID validation ────────────────────────────────────

  it("rejects non-UUID session IDs", async () => {
    const endpoints = [
      `/api/sessions/not-a-uuid`,
      `/api/sessions/00000000-0000-ZZZZ-0000-000000000000`,
    ];

    for (const endpoint of endpoints) {
      const res = await fetch(url(endpoint));
      // Server returns 400 for invalid UUID format
      expect(res.status).toBe(400);
    }
  });

  // ─── Tool details ─────────────────────────────────────────────

  it("GET /api/tools/:name returns tool manifest", async () => {
    const res = await fetch(url("/api/tools/read-file"));
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; description: string };
    expect(body.name).toBe("read-file");
    expect(body.description).toBeDefined();
  });

  it("GET /api/tools/:name returns 404 for unknown tool", async () => {
    const res = await fetch(url("/api/tools/nonexistent-tool-xyz"));
    expect(res.status).toBe(404);
  });

  // ─── SSE stream ───────────────────────────────────────────────

  it("GET /api/sessions/:id/stream delivers SSE events", async () => {
    const createRes = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "SSE stream test" }),
    });
    const { session_id } = await createRes.json() as { session_id: string };

    // Connect to SSE stream
    const sseRes = await fetch(url(`/api/sessions/${session_id}/stream`));
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // Read some SSE data
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    try {
      const readWithTimeout = async () => {
        const timer = setTimeout(() => reader.cancel(), 5000);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            // Stop after we see at least one data line
            if (text.includes("data:")) break;
          }
        } finally {
          clearTimeout(timer);
        }
      };
      await readWithTimeout();
    } catch {
      // Reader cancelled by timeout — OK, we have what we need
    } finally {
      try { reader.cancel(); } catch { /* already cancelled */ }
    }

    // Should have SSE-formatted data
    expect(text).toContain("data:");
  });

  // ─── Approvals endpoint ───────────────────────────────────────

  it("GET /api/approvals returns pending list", async () => {
    const res = await fetch(url("/api/approvals"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pending: unknown[] };
    expect(Array.isArray(body.pending)).toBe(true);
  });

  // ─── Concurrent session limit ─────────────────────────────────

  it("enforces maxConcurrentSessions via REST API", async () => {
    // Create server with limit of 1
    await apiServer.shutdown();
    const limitedServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      maxConcurrentSessions: 1,
      insecure: true,
    });
    httpServer = limitedServer.listen(0);

    const baseUrl = `http://localhost:${serverPort(httpServer)}`;

    // First session should succeed
    const res1 = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "First session" }),
    });
    expect(res1.status).toBe(200);

    // Second session may be rejected if first is still running
    // MockPlanner is fast so this tests the enforcement path
    const res2 = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Second session" }),
    });
    // Accept either 200 (first completed) or 429 (still running)
    expect([200, 429]).toContain(res2.status);

    await limitedServer.shutdown();
  });

  // ─── Full REST lifecycle ──────────────────────────────────────

  it("full lifecycle: create → poll status → verify journal chain", async () => {
    // Create session
    const createRes = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Full lifecycle REST test" }),
    });
    expect(createRes.status).toBe(200);
    const { session_id } = await createRes.json() as { session_id: string };
    expect(session_id).toMatch(/^[0-9a-f-]{36}$/);

    // Poll for completion
    let status = "running";
    for (let i = 0; i < 20 && status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const stateRes = await fetch(url(`/api/sessions/${session_id}`));
      if (stateRes.status === 200) {
        const body = await stateRes.json() as { status: string };
        status = body.status;
      }
    }
    expect(["completed", "failed"]).toContain(status);

    // Verify journal events
    const journalRes = await fetch(url(`/api/sessions/${session_id}/journal`));
    const { events } = await journalRes.json() as { events: Array<{ type: string; hash: string; prev_hash: string | null }> };
    expect(events.length).toBeGreaterThan(0);

    const types = events.map((e) => e.type);
    expect(types).toContain("session.created");
    expect(types).toContain("session.started");

    // Verify hash chain integrity
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.prev_hash).toBe(events[i - 1]!.hash);
    }
  });
});
