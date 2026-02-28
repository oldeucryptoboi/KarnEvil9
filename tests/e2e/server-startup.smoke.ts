import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry } from "@karnevil9/tools";
import { ApiServer } from "@karnevil9/api";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/manifests");

describe("Server Startup Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let server: ReturnType<typeof ApiServer.prototype.getExpressApp> extends infer T ? T : never;
  let httpServer: ReturnType<typeof server.listen> | null = null;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-server-${uuid()}`);
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
    await rm(testDir, { recursive: true, force: true });
  });

  it("boots and responds to health check", async () => {
    const apiServer = new ApiServer(registry, journal);
    const app = apiServer.getExpressApp();
    const port = 30000 + Math.floor(Math.random() * 10000);

    httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    // "warning" is valid when disk usage > 90%
    expect(["healthy", "warning"]).toContain(body.status);
    expect(body.version).toBe("0.1.0");
    expect(body.timestamp).toBeDefined();
    expect(body.checks).toBeDefined();
  });

  it("health check includes all subsystem checks", async () => {
    const apiServer = new ApiServer(registry, journal);
    const app = apiServer.getExpressApp();
    const port = 30000 + Math.floor(Math.random() * 10000);

    httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    const res = await fetch(`http://localhost:${port}/api/health`);
    const body = await res.json() as { checks: Record<string, unknown> };

    const checks = body.checks;
    expect(checks.journal).toBeDefined();
    expect(checks.tools).toBeDefined();
    expect(checks.sessions).toBeDefined();
    expect(checks.planner).toBeDefined();
    expect(checks.permissions).toBeDefined();
    expect(checks.runtime).toBeDefined();
    expect(checks.plugins).toBeDefined();

    // Journal should be writable
    expect((checks.journal as Record<string, unknown>).status).toBe("ok");

    // Tools should be loaded from examples
    const toolsCheck = checks.tools as { status: string; loaded: number };
    expect(toolsCheck.status).toBe("ok");
    expect(toolsCheck.loaded).toBeGreaterThanOrEqual(4);
  });

  it("lists registered tools via GET /api/tools", async () => {
    const apiServer = new ApiServer(registry, journal);
    const app = apiServer.getExpressApp();
    const port = 30000 + Math.floor(Math.random() * 10000);

    httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    const res = await fetch(`http://localhost:${port}/api/tools`);
    expect(res.status).toBe(200);

    const body = await res.json() as { tools: Array<{ name: string }> };
    expect(body.tools.length).toBeGreaterThanOrEqual(4);

    const toolNames = body.tools.map((t) => t.name);
    expect(toolNames).toContain("read-file");
    expect(toolNames).toContain("write-file");
    expect(toolNames).toContain("shell-exec");
    expect(toolNames).toContain("http-request");
  });

  it("returns 404 for unknown session", async () => {
    const apiServer = new ApiServer(registry, journal);
    const app = apiServer.getExpressApp();
    const port = 30000 + Math.floor(Math.random() * 10000);

    httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    const res = await fetch(`http://localhost:${port}/api/sessions/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it("returns empty plugins list when no plugin registry configured", async () => {
    const apiServer = new ApiServer(registry, journal);
    const app = apiServer.getExpressApp();
    const port = 30000 + Math.floor(Math.random() * 10000);

    httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    const res = await fetch(`http://localhost:${port}/api/plugins`);
    expect(res.status).toBe(200);

    const body = await res.json() as { plugins: unknown[] };
    expect(body.plugins).toEqual([]);
  });
});
