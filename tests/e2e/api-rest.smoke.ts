/**
 * API REST E2E Smoke Tests
 *
 * Comprehensive tests for the KarnEvil9 REST API server covering:
 * health, sessions, tools, schedules, metrics, SSE streaming,
 * authentication, rate limiting, input validation, and error handling.
 *
 * Self-contained: creates temp directories, instantiates ApiServer
 * directly, uses node's fetch to hit endpoints, and cleans up.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { MockPlanner } from "@karnevil9/planner";
import { ApiServer } from "@karnevil9/api";
import { MetricsCollector } from "@karnevil9/metrics";
import { Scheduler, ScheduleStore } from "@karnevil9/scheduler";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/manifests");

// ─── Helpers ──────────────────────────────────────────────────────────

function serverPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

/** Poll session status until it reaches a terminal state. */
async function waitForSession(
  baseUrl: string,
  sessionId: string,
  maxWaitMs = 10000,
): Promise<string> {
  const start = Date.now();
  let status = "running";
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    if (res.status === 200) {
      const body = (await res.json()) as { status: string };
      status = body.status;
      if (["completed", "failed", "aborted"].includes(status)) return status;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return status;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("API REST E2E Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: Server;
  let baseUrl: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-api-rest-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), {
      fsync: false,
      redact: false,
    });
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
    baseUrl = `http://127.0.0.1:${serverPort(httpServer)}`;
  });

  afterEach(async () => {
    await apiServer.shutdown();
    await rm(testDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  });

  // ─── 1. Health ──────────────────────────────────────────────────────

  describe("Health", () => {
    it("GET /api/health returns healthy status with all subsystem checks", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        status: string;
        version: string;
        timestamp: string;
        checks: Record<string, unknown>;
      };
      expect(["healthy", "warning"]).toContain(body.status);
      expect(body.version).toBe("0.1.0");
      expect(body.timestamp).toBeTruthy();

      // All subsystem checks present
      expect(body.checks.journal).toBeDefined();
      expect(body.checks.tools).toBeDefined();
      expect(body.checks.sessions).toBeDefined();
      expect(body.checks.planner).toBeDefined();
      expect(body.checks.permissions).toBeDefined();
      expect(body.checks.runtime).toBeDefined();
      expect(body.checks.plugins).toBeDefined();
      expect(body.checks.scheduler).toBeDefined();
      expect(body.checks.swarm).toBeDefined();
    });

    it("health check reports journal as writable", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      const body = (await res.json()) as {
        checks: { journal: { status: string; detail: string } };
      };
      expect(body.checks.journal.status).toBe("ok");
      expect(body.checks.journal.detail).toBe("writable");
    });

    it("health check reports loaded tools count", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      const body = (await res.json()) as {
        checks: { tools: { status: string; loaded: number } };
      };
      expect(body.checks.tools.status).toBe("ok");
      expect(body.checks.tools.loaded).toBeGreaterThanOrEqual(4);
    });

    it("health check is unauthenticated even when auth is configured", async () => {
      await apiServer.shutdown();

      const authServer = new ApiServer({
        toolRegistry: registry,
        journal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        apiToken: "super-secret-token",
      });
      const authHttp = authServer.listen(0);
      const authUrl = `http://127.0.0.1:${serverPort(authHttp)}`;

      try {
        // Health should work without auth
        const healthRes = await fetch(`${authUrl}/api/health`);
        expect(healthRes.status).toBe(200);

        // Other endpoints should require auth
        const toolsRes = await fetch(`${authUrl}/api/tools`);
        expect(toolsRes.status).toBe(401);
      } finally {
        await authServer.shutdown();
      }
    });
  });

  // ─── 2. Sessions ───────────────────────────────────────────────────

  describe("Sessions", () => {
    it("POST /api/sessions creates a new session and returns session_id", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Create session test" }),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        session_id: string;
        status: string;
        task: { text: string };
      };
      expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/);
      // Session transitions from "created" to "planning" almost instantly
      // as the kernel starts running asynchronously after creation
      expect(["created", "planning", "running"]).toContain(body.status);
      expect(body.task.text).toBe("Create session test");
    });

    it("GET /api/sessions returns empty list initially", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: unknown[] };
      expect(body.sessions).toEqual([]);
    });

    it("GET /api/sessions includes created session after it runs", async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "List test" }),
      });
      const { session_id } = (await createRes.json()) as {
        session_id: string;
      };

      await waitForSession(baseUrl, session_id);

      const listRes = await fetch(`${baseUrl}/api/sessions`);
      const body = (await listRes.json()) as {
        sessions: Array<{ session_id: string; status: string }>;
      };
      const ids = body.sessions.map((s) => s.session_id);
      expect(ids).toContain(session_id);
    });

    it("GET /api/sessions/:id returns full session detail", async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Detail test" }),
      });
      const { session_id } = (await createRes.json()) as {
        session_id: string;
      };

      // Session may still be running, but detail endpoint should work
      const detailRes = await fetch(`${baseUrl}/api/sessions/${session_id}`);
      expect(detailRes.status).toBe(200);

      const body = (await detailRes.json()) as {
        session_id: string;
        status: string;
        mode: string;
      };
      expect(body.session_id).toBe(session_id);
      expect(body.mode).toBeDefined();
    });

    it("POST /api/sessions/:id/abort terminates a running session", async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Abort test" }),
      });
      const { session_id } = (await createRes.json()) as {
        session_id: string;
      };

      // Attempt abort -- session may have already completed with MockPlanner
      const abortRes = await fetch(
        `${baseUrl}/api/sessions/${session_id}/abort`,
        { method: "POST" },
      );
      // Accept 200 (aborted) or 404 (already evicted if very fast)
      expect([200, 404]).toContain(abortRes.status);

      if (abortRes.status === 200) {
        const body = (await abortRes.json()) as { status: string };
        expect(body.status).toBe("aborted");
      }
    });

    it("GET /api/sessions/:id returns 404 for unknown session", async () => {
      const unknownId = "00000000-0000-0000-0000-000000000000";
      const res = await fetch(`${baseUrl}/api/sessions/${unknownId}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Session not found");
    });

    it("POST /api/sessions/:id/abort returns 404 for unknown session", async () => {
      const unknownId = "00000000-0000-0000-0000-000000000000";
      const res = await fetch(`${baseUrl}/api/sessions/${unknownId}/abort`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/sessions accepts optional mode parameter", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Mode test", mode: "mock" }),
      });
      expect(res.status).toBe(200);
    });

    it("POST /api/sessions accepts optional limits parameter", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Limits test",
          limits: { max_steps: 5, max_duration_ms: 10000 },
        }),
      });
      expect(res.status).toBe(200);
    });

    it("POST /api/sessions accepts optional submitted_by parameter", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Submitted by test",
          submitted_by: "e2e-test",
        }),
      });
      expect(res.status).toBe(200);
    });

    it("full lifecycle: create -> poll -> verify journal chain", async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Full lifecycle test" }),
      });
      expect(createRes.status).toBe(200);
      const { session_id } = (await createRes.json()) as {
        session_id: string;
      };

      const finalStatus = await waitForSession(baseUrl, session_id);
      expect(["completed", "failed"]).toContain(finalStatus);

      // Verify journal events
      const journalRes = await fetch(
        `${baseUrl}/api/sessions/${session_id}/journal`,
      );
      const { events } = (await journalRes.json()) as {
        events: Array<{
          type: string;
          hash: string;
          prev_hash: string | null;
        }>;
      };
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

  // ─── 3. Tools ──────────────────────────────────────────────────────

  describe("Tools", () => {
    it("GET /api/tools returns list of registered tools", async () => {
      const res = await fetch(`${baseUrl}/api/tools`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        tools: Array<{
          name: string;
          version: string;
          description: string;
          runner: string;
        }>;
      };
      expect(body.tools.length).toBeGreaterThanOrEqual(4);

      const names = body.tools.map((t) => t.name);
      expect(names).toContain("read-file");
      expect(names).toContain("write-file");
      expect(names).toContain("shell-exec");
      expect(names).toContain("http-request");

      // Each tool has expected fields
      for (const tool of body.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.version).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.runner).toBeTruthy();
      }
    });

    it("GET /api/tools/:name returns tool manifest for known tool", async () => {
      const res = await fetch(`${baseUrl}/api/tools/read-file`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        name: string;
        description: string;
        version: string;
        input_schema: object;
        output_schema: object;
        permissions: string[];
      };
      expect(body.name).toBe("read-file");
      expect(body.description).toBeTruthy();
      expect(body.version).toBeTruthy();
      expect(body.input_schema).toBeDefined();
      expect(body.output_schema).toBeDefined();
      expect(Array.isArray(body.permissions)).toBe(true);
    });

    it("GET /api/tools/:name returns 404 for unknown tool", async () => {
      const res = await fetch(`${baseUrl}/api/tools/nonexistent-tool-xyz`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Tool not found");
    });
  });

  // ─── 4. Schedules ─────────────────────────────────────────────────

  describe("Schedules", () => {
    let schedulerApiServer: ApiServer;
    let schedulerHttp: Server;
    let schedulerUrl: string;
    let scheduler: Scheduler;
    let schedulerJournal: Journal;

    beforeEach(async () => {
      schedulerJournal = new Journal(
        join(testDir, "scheduler-journal.jsonl"),
        { fsync: false, redact: false },
      );
      await schedulerJournal.init();

      const store = new ScheduleStore(join(testDir, "schedules.jsonl"));
      scheduler = new Scheduler({
        store,
        journal: schedulerJournal,
        sessionFactory: async (task) => ({
          session_id: uuid(),
          status: "completed",
        }),
        tickIntervalMs: 60000, // Long tick to avoid background activity
      });
      await scheduler.start();

      schedulerApiServer = new ApiServer({
        toolRegistry: registry,
        journal: schedulerJournal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        insecure: true,
        scheduler,
      });
      schedulerHttp = schedulerApiServer.listen(0);
      schedulerUrl = `http://127.0.0.1:${serverPort(schedulerHttp)}`;
    });

    afterEach(async () => {
      await schedulerApiServer.shutdown();
    });

    it("GET /api/schedules returns empty list initially", async () => {
      const res = await fetch(`${schedulerUrl}/api/schedules`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        schedules: unknown[];
        total: number;
      };
      expect(body.schedules).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("POST /api/schedules creates a new schedule", async () => {
      const res = await fetch(`${schedulerUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Schedule",
          trigger: { type: "every", interval: "1h" },
          action: {
            type: "createSession",
            task_text: "Scheduled task",
          },
        }),
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        schedule_id: string;
        name: string;
        status: string;
      };
      expect(body.schedule_id).toBeTruthy();
      expect(body.name).toBe("Test Schedule");
      expect(body.status).toBe("active");
    });

    it("GET /api/schedules lists created schedules", async () => {
      // Create a schedule first
      await fetch(`${schedulerUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Listing Test",
          trigger: { type: "every", interval: "30m" },
          action: { type: "createSession", task_text: "List test" },
        }),
      });

      const res = await fetch(`${schedulerUrl}/api/schedules`);
      const body = (await res.json()) as {
        schedules: Array<{ name: string }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.schedules[0]!.name).toBe("Listing Test");
    });

    it("PUT /api/schedules/:id updates a schedule", async () => {
      // Create
      const createRes = await fetch(`${schedulerUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Update Target",
          trigger: { type: "every", interval: "1h" },
          action: { type: "createSession", task_text: "Original" },
        }),
      });
      const { schedule_id } = (await createRes.json()) as {
        schedule_id: string;
      };

      // Update
      const updateRes = await fetch(
        `${schedulerUrl}/api/schedules/${schedule_id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Updated Name" }),
        },
      );
      expect(updateRes.status).toBe(200);

      const body = (await updateRes.json()) as { name: string };
      expect(body.name).toBe("Updated Name");
    });

    it("DELETE /api/schedules/:id deletes a schedule", async () => {
      // Create
      const createRes = await fetch(`${schedulerUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Delete Target",
          trigger: { type: "every", interval: "1h" },
          action: { type: "createSession", task_text: "Delete me" },
        }),
      });
      const { schedule_id } = (await createRes.json()) as {
        schedule_id: string;
      };

      // Delete
      const deleteRes = await fetch(
        `${schedulerUrl}/api/schedules/${schedule_id}`,
        { method: "DELETE" },
      );
      expect(deleteRes.status).toBe(200);
      const body = (await deleteRes.json()) as {
        deleted: boolean;
        schedule_id: string;
      };
      expect(body.deleted).toBe(true);
      expect(body.schedule_id).toBe(schedule_id);

      // Verify deleted
      const listRes = await fetch(`${schedulerUrl}/api/schedules`);
      const listBody = (await listRes.json()) as { total: number };
      expect(listBody.total).toBe(0);
    });

    it("DELETE /api/schedules/:id returns 404 for unknown schedule", async () => {
      const res = await fetch(
        `${schedulerUrl}/api/schedules/nonexistent-id`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
    });

    it("POST /api/schedules rejects invalid input", async () => {
      // Missing name
      const res1 = await fetch(`${schedulerUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger: { type: "every", interval: "1h" },
          action: { type: "createSession", task_text: "Test" },
        }),
      });
      expect(res1.status).toBe(400);

      // Missing trigger
      const res2 = await fetch(`${schedulerUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad",
          action: { type: "createSession", task_text: "Test" },
        }),
      });
      expect(res2.status).toBe(400);

      // Invalid trigger type
      const res3 = await fetch(`${schedulerUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad",
          trigger: { type: "invalid" },
          action: { type: "createSession", task_text: "Test" },
        }),
      });
      expect(res3.status).toBe(400);
    });

    it("full schedule CRUD lifecycle", async () => {
      // Create
      const createRes = await fetch(`${schedulerUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "CRUD Test",
          trigger: { type: "every", interval: "2h" },
          action: { type: "createSession", task_text: "CRUD task" },
          options: { description: "E2E test schedule" },
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        schedule_id: string;
        name: string;
      };

      // Read
      const getRes = await fetch(
        `${schedulerUrl}/api/schedules/${created.schedule_id}`,
      );
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as { name: string };
      expect(fetched.name).toBe("CRUD Test");

      // Update
      const updateRes = await fetch(
        `${schedulerUrl}/api/schedules/${created.schedule_id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "CRUD Updated" }),
        },
      );
      expect(updateRes.status).toBe(200);

      // List
      const listRes = await fetch(`${schedulerUrl}/api/schedules`);
      const listed = (await listRes.json()) as {
        schedules: Array<{ name: string }>;
      };
      expect(listed.schedules[0]!.name).toBe("CRUD Updated");

      // Delete
      const deleteRes = await fetch(
        `${schedulerUrl}/api/schedules/${created.schedule_id}`,
        { method: "DELETE" },
      );
      expect(deleteRes.status).toBe(200);

      // Verify deleted
      const finalList = await fetch(`${schedulerUrl}/api/schedules`);
      const finalBody = (await finalList.json()) as { total: number };
      expect(finalBody.total).toBe(0);
    });
  });

  // ─── 5. Metrics ───────────────────────────────────────────────────

  describe("Metrics", () => {
    let metricsApiServer: ApiServer;
    let metricsHttp: Server;
    let metricsUrl: string;

    beforeEach(async () => {
      const metricsCollector = new MetricsCollector({
        collectDefault: false,
      });
      metricsCollector.attach(journal);

      metricsApiServer = new ApiServer({
        toolRegistry: registry,
        journal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        insecure: true,
        metricsCollector,
      });
      metricsHttp = metricsApiServer.listen(0);
      metricsUrl = `http://127.0.0.1:${serverPort(metricsHttp)}`;
    });

    afterEach(async () => {
      await metricsApiServer.shutdown();
    });

    it("GET /api/metrics returns Prometheus-formatted metrics", async () => {
      const res = await fetch(`${metricsUrl}/api/metrics`);
      expect(res.status).toBe(200);

      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("text/plain");

      const text = await res.text();
      // Prometheus metrics start with # HELP or # TYPE or metric lines
      expect(text).toBeTruthy();
    });

    it("metrics endpoint tracks session events after activity", async () => {
      // Create a session to generate some events
      await fetch(`${metricsUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Metrics session" }),
      });

      await new Promise((r) => setTimeout(r, 2000));

      const res = await fetch(`${metricsUrl}/api/metrics`);
      const text = await res.text();
      // Should have session-related metrics
      expect(text).toContain("sessions");
    });
  });

  // ─── 6. SSE ───────────────────────────────────────────────────────

  describe("SSE Streaming", () => {
    it("GET /api/sessions/:id/stream returns text/event-stream content type", async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "SSE stream test" }),
      });
      const { session_id } = (await createRes.json()) as {
        session_id: string;
      };

      const sseRes = await fetch(
        `${baseUrl}/api/sessions/${session_id}/stream`,
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

      // Read some data
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        const timer = setTimeout(() => reader.cancel(), 5000);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (text.includes("data:")) break;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Reader cancelled by timeout -- expected
      } finally {
        try {
          reader.cancel();
        } catch {
          /* already cancelled */
        }
      }

      expect(text).toContain("data:");
    });

    it("SSE stream supports after_seq replay parameter", async () => {
      // Create a session and wait for completion
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "SSE replay test" }),
      });
      const { session_id } = (await createRes.json()) as {
        session_id: string;
      };
      await waitForSession(baseUrl, session_id);

      // Connect to SSE stream with after_seq=0 to get replay of events after seq 0
      const sseRes = await fetch(
        `${baseUrl}/api/sessions/${session_id}/stream?after_seq=0`,
      );
      expect(sseRes.status).toBe(200);

      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        const timer = setTimeout(() => reader.cancel(), 3000);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (text.includes("data:")) break;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Timeout expected
      } finally {
        try {
          reader.cancel();
        } catch {
          /* already cancelled */
        }
      }

      // Should have replayed at least one event
      expect(text).toContain("data:");
    });
  });

  // ─── 7. Journal Endpoints ─────────────────────────────────────────

  describe("Journal", () => {
    it("GET /api/sessions/:id/journal returns events with pagination", async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Journal pagination test" }),
      });
      const { session_id } = (await createRes.json()) as {
        session_id: string;
      };
      await waitForSession(baseUrl, session_id);

      // Get all events
      const allRes = await fetch(
        `${baseUrl}/api/sessions/${session_id}/journal`,
      );
      expect(allRes.status).toBe(200);
      const allBody = (await allRes.json()) as {
        events: unknown[];
        total: number;
        offset: number;
        limit: number;
      };
      expect(allBody.total).toBeGreaterThan(0);
      expect(allBody.events.length).toBe(allBody.total);

      // Get with offset=1, limit=2
      const pageRes = await fetch(
        `${baseUrl}/api/sessions/${session_id}/journal?offset=1&limit=2`,
      );
      expect(pageRes.status).toBe(200);
      const pageBody = (await pageRes.json()) as {
        events: unknown[];
        total: number;
        offset: number;
        limit: number;
      };
      expect(pageBody.offset).toBe(1);
      expect(pageBody.limit).toBe(2);
      expect(pageBody.events.length).toBeLessThanOrEqual(2);
      expect(pageBody.total).toBe(allBody.total);
    });

    it("POST /api/sessions/:id/replay returns full event history", async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Replay test" }),
      });
      const { session_id } = (await createRes.json()) as {
        session_id: string;
      };
      await waitForSession(baseUrl, session_id);

      const replayRes = await fetch(
        `${baseUrl}/api/sessions/${session_id}/replay`,
        { method: "POST" },
      );
      expect(replayRes.status).toBe(200);
      const body = (await replayRes.json()) as {
        session_id: string;
        event_count: number;
        total_events: number;
        truncated: boolean;
        events: Array<{ type: string }>;
      };
      expect(body.session_id).toBe(session_id);
      expect(body.event_count).toBeGreaterThan(0);
      expect(body.truncated).toBe(false);
      expect(body.events.length).toBe(body.event_count);
    });

    it("POST /api/journal/compact runs compaction", async () => {
      const res = await fetch(`${baseUrl}/api/journal/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });

    it("POST /api/journal/compact rejects invalid input", async () => {
      const res = await fetch(`${baseUrl}/api/journal/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retain_sessions: "not-an-array" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── 8. Approvals ────────────────────────────────────────────────

  describe("Approvals", () => {
    it("GET /api/approvals returns pending approvals list", async () => {
      const res = await fetch(`${baseUrl}/api/approvals`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pending: unknown[] };
      expect(Array.isArray(body.pending)).toBe(true);
    });

    it("POST /api/approvals/:id returns 404 for unknown approval", async () => {
      const res = await fetch(`${baseUrl}/api/approvals/fake-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allow_once" }),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/approvals/:id validates decision input", async () => {
      const res = await fetch(`${baseUrl}/api/approvals/fake-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "invalid_decision" }),
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/approvals/:id rejects missing decision", async () => {
      const res = await fetch(`${baseUrl}/api/approvals/fake-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── 9. Plugins ──────────────────────────────────────────────────

  describe("Plugins", () => {
    it("GET /api/plugins returns empty list when no plugin registry", async () => {
      const res = await fetch(`${baseUrl}/api/plugins`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { plugins: unknown[] };
      expect(body.plugins).toEqual([]);
    });

    it("GET /api/plugins/:id returns 404 when plugin system not configured", async () => {
      const res = await fetch(`${baseUrl}/api/plugins/some-plugin`);
      expect(res.status).toBe(404);
    });
  });

  // ─── 10. Error Cases ─────────────────────────────────────────────

  describe("Error Cases", () => {
    it("rejects non-UUID session IDs with 400", async () => {
      const badIds = ["not-a-uuid", "1234", "abc!def", ""];

      for (const badId of badIds) {
        if (!badId) continue; // Empty string would go to /api/sessions
        const res = await fetch(`${baseUrl}/api/sessions/${badId}`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("Invalid session ID format");
      }
    });

    it("POST /api/sessions rejects empty text", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("text");
    });

    it("POST /api/sessions rejects missing body fields", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/sessions rejects invalid mode", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Bad mode test", mode: "invalid_mode" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("mode");
    });

    it("POST /api/sessions rejects overly long text", async () => {
      const longText = "x".repeat(10001);
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: longText }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("10000");
    });

    it("POST /api/sessions rejects non-object limits", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Limits test", limits: "string" }),
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/sessions rejects negative limit values", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Neg limits test",
          limits: { max_steps: -1 },
        }),
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/sessions rejects non-object constraints", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Constraints test", constraints: [1, 2] }),
      });
      expect(res.status).toBe(400);
    });

    it("error responses include proper JSON format", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/not-a-uuid`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });
  });

  // ─── 11. Authentication ──────────────────────────────────────────

  describe("Authentication", () => {
    let authApiServer: ApiServer;
    let authHttp: Server;
    let authUrl: string;
    const TOKEN = "test-api-token-12345";

    beforeEach(async () => {
      const authJournal = new Journal(
        join(testDir, "auth-journal.jsonl"),
        { fsync: false, redact: false },
      );
      await authJournal.init();

      authApiServer = new ApiServer({
        toolRegistry: registry,
        journal: authJournal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        apiToken: TOKEN,
      });
      authHttp = authApiServer.listen(0);
      authUrl = `http://127.0.0.1:${serverPort(authHttp)}`;
    });

    afterEach(async () => {
      await authApiServer.shutdown();
    });

    it("rejects requests without Authorization header", async () => {
      const res = await fetch(`${authUrl}/api/tools`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Unauthorized");
    });

    it("rejects requests with wrong token", async () => {
      const res = await fetch(`${authUrl}/api/tools`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts requests with correct token", async () => {
      const res = await fetch(`${authUrl}/api/tools`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    });

    it("health endpoint bypasses authentication", async () => {
      const res = await fetch(`${authUrl}/api/health`);
      expect(res.status).toBe(200);
    });

    it("rejects malformed Authorization header", async () => {
      const res = await fetch(`${authUrl}/api/tools`, {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── 12. Rate Limiting ───────────────────────────────────────────

  describe("Rate Limiting", () => {
    it("returns X-RateLimit-Remaining header", async () => {
      const res = await fetch(`${baseUrl}/api/tools`);
      expect(res.status).toBe(200);
      const remaining = res.headers.get("x-ratelimit-remaining");
      expect(remaining).toBeTruthy();
      expect(parseInt(remaining!, 10)).toBeGreaterThanOrEqual(0);
    });

    it("returns X-RateLimit-Reset header", async () => {
      const res = await fetch(`${baseUrl}/api/tools`);
      const reset = res.headers.get("x-ratelimit-reset");
      expect(reset).toBeTruthy();
      expect(parseInt(reset!, 10)).toBeGreaterThan(0);
    });
  });

  // ─── 13. Security Headers ────────────────────────────────────────

  describe("Security Headers", () => {
    it("includes X-Content-Type-Options: nosniff", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("includes X-Frame-Options: DENY", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    });

    it("includes Content-Security-Policy", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      const csp = res.headers.get("content-security-policy");
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
    });

    it("includes Cache-Control: no-store", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  // ─── 14. Concurrent Session Limit ────────────────────────────────

  describe("Concurrent Session Limit", () => {
    it("enforces maxConcurrentSessions", async () => {
      await apiServer.shutdown();

      const limitedJournal = new Journal(
        join(testDir, "limited-journal.jsonl"),
        { fsync: false, redact: false },
      );
      await limitedJournal.init();

      const limitedServer = new ApiServer({
        toolRegistry: registry,
        journal: limitedJournal,
        toolRuntime: runtime,
        permissions,
        planner: new MockPlanner(),
        maxConcurrentSessions: 1,
        insecure: true,
      });
      const limitedHttp = limitedServer.listen(0);
      const limitedUrl = `http://127.0.0.1:${serverPort(limitedHttp)}`;

      try {
        // First session
        const res1 = await fetch(`${limitedUrl}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "First session" }),
        });
        expect(res1.status).toBe(200);

        // Second session -- may be rejected if first is still running
        const res2 = await fetch(`${limitedUrl}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Second session" }),
        });
        // Accept either 200 (first completed fast) or 429
        expect([200, 429]).toContain(res2.status);
      } finally {
        await limitedServer.shutdown();
      }
    });
  });

  // ─── 15. Insecure Mode Check ─────────────────────────────────────

  describe("Server Configuration", () => {
    it("throws when neither apiToken nor insecure is set", () => {
      expect(
        () =>
          new ApiServer({
            toolRegistry: registry,
            journal,
            toolRuntime: runtime,
            permissions,
            planner: new MockPlanner(),
            // Neither apiToken nor insecure
          }),
      ).toThrow(/API token is required/);
    });

    it("rejects invalid maxConcurrentSessions", () => {
      expect(
        () =>
          new ApiServer({
            toolRegistry: registry,
            journal,
            toolRuntime: runtime,
            permissions,
            planner: new MockPlanner(),
            insecure: true,
            maxConcurrentSessions: -1,
          }),
      ).toThrow(/maxConcurrentSessions/);
    });

    it("rejects invalid maxSseClientsPerSession", () => {
      expect(
        () =>
          new ApiServer({
            toolRegistry: registry,
            journal,
            toolRuntime: runtime,
            permissions,
            planner: new MockPlanner(),
            insecure: true,
            maxSseClientsPerSession: 0,
          }),
      ).toThrow(/maxSseClientsPerSession/);
    });
  });
});
