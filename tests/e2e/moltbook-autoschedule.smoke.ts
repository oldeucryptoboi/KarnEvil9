import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { PluginRegistry } from "@karnevil9/plugins";
import { ScheduleStore, Scheduler } from "@karnevil9/scheduler";
import type { SessionFactory } from "@karnevil9/scheduler";
import { createServer } from "node:http";
import type { Server } from "node:http";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/examples");
const PLUGINS_DIR = join(ROOT, "plugins");

/**
 * Spin up a tiny HTTP server that stubs Moltbook API endpoints
 * so the plugin's MoltbookClient.init() succeeds without hitting the real API.
 */
function createMockMoltbookServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/api/v1/agents/me")) {
        res.end(JSON.stringify({ name: "test-agent", agent_id: "test-id" }));
      } else if (req.url?.startsWith("/api/v1/agents/dm/requests")) {
        res.end(JSON.stringify({ requests: [] }));
      } else if (req.url?.startsWith("/api/v1/home")) {
        res.end(JSON.stringify({ your_account: { unread_notification_count: 0 } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

describe("Moltbook autoSchedule Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let mockServer: Server;
  let mockUrl: string;
  let scheduler: Scheduler | null = null;
  let origApiKey: string | undefined;
  let origBaseUrl: string | undefined;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-moltbook-sched-${uuid()}`);
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);
    const mock = await createMockMoltbookServer();
    mockServer = mock.server;
    mockUrl = mock.url;

    // Override env so MoltbookClient talks to our mock server
    origApiKey = process.env.MOLTBOOK_API_KEY;
    origBaseUrl = process.env.MOLTBOOK_API_BASE_URL;
    process.env.MOLTBOOK_API_KEY = "test-key-for-smoke";
    process.env.MOLTBOOK_API_BASE_URL = `${mockUrl}/api/v1`;
  });

  afterEach(async () => {
    // Restore env
    if (origApiKey === undefined) delete process.env.MOLTBOOK_API_KEY;
    else process.env.MOLTBOOK_API_KEY = origApiKey;
    if (origBaseUrl === undefined) delete process.env.MOLTBOOK_API_BASE_URL;
    else process.env.MOLTBOOK_API_BASE_URL = origBaseUrl;

    // Stop scheduler and let fire-and-forget store.save() calls from
    // plugin createSchedule settle before removing the temp directory
    if (scheduler) await scheduler.stop();
    await new Promise((r) => setTimeout(r, 200));
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
    scheduler = null;
  });

  it("autoSchedule creates the 3 default Moltbook schedules", async () => {
    const store = new ScheduleStore(join(testDir, "schedules.jsonl"));
    const sessionFactory: SessionFactory = async () => ({
      session_id: `mock-${uuid()}`,
      status: "created",
    });

    scheduler = new Scheduler({
      store,
      journal,
      sessionFactory,
      tickIntervalMs: 60000,
    });
    await scheduler.start();

    const pluginRegistry = new PluginRegistry({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      pluginsDir: PLUGINS_DIR,
      pluginConfigs: {
        moltbook: { scheduler, autoSchedule: true },
      },
    });
    await pluginRegistry.discoverAndLoadAll();

    const schedules = scheduler.listSchedules();
    const names = schedules.map((s) => s.name);

    expect(names).toContain("moltbook-check-notifications");
    expect(names).toContain("moltbook-check-dms");
    expect(names).toContain("moltbook-post-social");
    expect(names).toContain("moltbook-post-rfc");
    expect(names).toContain("moltbook-karma-engage");
    expect(names).toContain("moltbook-close-loop");
    expect(names).not.toContain("moltbook-check-feed");
    expect(names).not.toContain("moltbook-promote-repo");

    // Verify each schedule is active and has the right trigger
    const notifs = schedules.find((s) => s.name === "moltbook-check-notifications")!;
    expect(notifs.status).toBe("active");
    expect(notifs.trigger).toEqual({ type: "every", interval: "1h" });

    const dms = schedules.find((s) => s.name === "moltbook-check-dms")!;
    expect(dms.status).toBe("active");
    expect(dms.trigger).toEqual({ type: "every", interval: "1h" });

    const social = schedules.find((s) => s.name === "moltbook-post-social")!;
    expect(social.status).toBe("active");
    expect(social.trigger).toEqual({ type: "every", interval: "3h" });

    const rfc = schedules.find((s) => s.name === "moltbook-post-rfc")!;
    expect(rfc.status).toBe("active");
    expect(rfc.trigger).toEqual({ type: "every", interval: "8h" });

    const karma = schedules.find((s) => s.name === "moltbook-karma-engage")!;
    expect(karma.status).toBe("active");
    expect(karma.trigger).toEqual({ type: "every", interval: "2h" });
  });
});
