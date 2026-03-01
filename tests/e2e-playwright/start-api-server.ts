/**
 * Standalone script to start the API server with MockPlanner for Playwright tests.
 * Run with: npx tsx tests/e2e-playwright/start-api-server.ts
 */
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { MockPlanner } from "@karnevil9/planner";
import { ApiServer } from "@karnevil9/api";
import { Scheduler, ScheduleStore } from "@karnevil9/scheduler";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/manifests");
const PORT = 3199;

async function main() {
  const testDir = join(tmpdir(), `karnevil9-pw-${uuid()}`);
  await mkdir(testDir, { recursive: true });

  const journal = new Journal(join(testDir, "journal.jsonl"), {
    fsync: false,
    redact: false,
  });
  await journal.init();

  const registry = new ToolRegistry();
  await registry.loadFromDirectory(TOOLS_DIR);

  const permissions = new PermissionEngine(journal, async () => "allow_always");
  const runtime = new ToolRuntime(registry, permissions, journal);

  // Set up scheduler for schedule CRUD tests
  const store = new ScheduleStore(join(testDir, "schedules.jsonl"));
  const scheduler = new Scheduler({
    store,
    journal,
    sessionFactory: async () => ({ session_id: uuid(), status: "created" }),
    tickIntervalMs: 60_000,
  });
  await scheduler.start();

  const apiServer = new ApiServer({
    toolRegistry: registry,
    journal,
    toolRuntime: runtime,
    permissions,
    planner: new MockPlanner(),
    insecure: true,
    rateLimit: { maxRequests: 2000, windowMs: 60_000 },
    scheduler,
    corsOrigins: "*",
  });

  apiServer.listen(PORT);
  console.log(`API server listening on port ${PORT}`);

  // Graceful shutdown
  const shutdown = async () => {
    await scheduler.stop().catch(() => {});
    await apiServer.shutdown().catch(() => {});
    await journal.close().catch(() => {});
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
