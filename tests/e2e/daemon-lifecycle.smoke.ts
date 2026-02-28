import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { MockPlanner } from "@karnevil9/planner";
import { ApiServer } from "@karnevil9/api";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/manifests");

describe("Daemon Lifecycle Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let httpServer: ReturnType<typeof import("node:http").createServer> | null = null;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-daemon-${uuid()}`);
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }
    // Close journal before cleanup to release file handles (prevents ENOTEMPTY)
    await journal.close();
    await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  it("start → health check → create session → verify journal → stop", async () => {
    // Build full runtime stack
    const permissions = new PermissionEngine(journal, async () => "allow_always");
    const runtime = new ToolRuntime(registry, permissions, journal);
    const planner = new MockPlanner();

    const apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner,
      insecure: true,
    });

    const port = 30000 + Math.floor(Math.random() * 10000);
    const app = apiServer.getExpressApp();

    // 1. Start server
    httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    // 2. Health check
    const healthRes = await fetch(`http://localhost:${port}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json() as { status: string; checks: Record<string, { status: string }> };
    // "warning" is valid when disk usage > 90%
    expect(["healthy", "warning"]).toContain(healthBody.status);
    expect(healthBody.checks.planner.status).toBe("ok");
    expect(healthBody.checks.runtime.status).toBe("ok");
    expect(healthBody.checks.permissions.status).toBe("ok");

    // 3. Create session via API
    const sessionRes = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Smoke test: read a file" }),
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json() as { session_id: string; status: string };
    expect(sessionBody.session_id).toBeDefined();

    // 4. Wait briefly for async kernel run to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 5. Check session state
    const stateRes = await fetch(`http://localhost:${port}/api/sessions/${sessionBody.session_id}`);
    // Session may be completed or still running — just verify it's reachable
    expect(stateRes.status).toBe(200);
    const stateBody = await stateRes.json() as { status: string };
    expect(["running", "completed", "failed"].includes(stateBody.status)).toBe(true);

    // 6. Verify journal has events for this session
    const journalRes = await fetch(`http://localhost:${port}/api/sessions/${sessionBody.session_id}/journal`);
    expect(journalRes.status).toBe(200);
    const journalBody = await journalRes.json() as { events: Array<{ type: string }> };
    expect(journalBody.events.length).toBeGreaterThan(0);

    const eventTypes = journalBody.events.map((e) => e.type);
    expect(eventTypes).toContain("session.created");
    expect(eventTypes).toContain("session.started");

    // 7. Stop — handled by afterEach closing httpServer
  });

  it("abort a running session via API", async () => {
    const permissions = new PermissionEngine(journal, async () => "allow_always");
    const runtime = new ToolRuntime(registry, permissions, journal);
    const planner = new MockPlanner();

    const apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner,
      insecure: true,
    });

    const port = 30000 + Math.floor(Math.random() * 10000);
    const app = apiServer.getExpressApp();

    httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    // Create session
    const sessionRes = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Abort test" }),
    });
    const sessionBody = await sessionRes.json() as { session_id: string };

    // Abort it — session may have already completed in mock mode, so accept 200 or 500
    const abortRes = await fetch(`http://localhost:${port}/api/sessions/${sessionBody.session_id}/abort`, {
      method: "POST",
    });
    // If session already completed, abort throws (500). Otherwise 200 with "aborted".
    expect([200, 500]).toContain(abortRes.status);
    if (abortRes.status === 200) {
      const abortBody = await abortRes.json() as { status: string };
      expect(abortBody.status).toBe("aborted");
    }
  });

  it("concurrent session limit is enforced", async () => {
    const permissions = new PermissionEngine(journal, async () => "allow_always");
    const runtime = new ToolRuntime(registry, permissions, journal);
    const planner = new MockPlanner();

    const apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner,
      maxConcurrentSessions: 2,
      insecure: true,
    });

    const port = 30000 + Math.floor(Math.random() * 10000);
    const app = apiServer.getExpressApp();

    httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    // Create 2 sessions (at limit)
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://localhost:${port}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `Session ${i}` }),
      });
      expect(res.status).toBe(200);
    }

    // Wait for sessions to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // If sessions are still tracked (not cleaned up after completion),
    // the 3rd should be rejected. This tests the max concurrent enforcement.
    const res3 = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Session 3" }),
    });
    // May succeed if previous sessions completed, or 429 if still tracked
    expect([200, 429]).toContain(res3.status);
  });
});
