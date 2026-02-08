import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@openvger/journal";
import { ToolRegistry } from "@openvger/tools";
import { PluginRegistry } from "@openvger/plugins";
import { ApiServer } from "@openvger/api";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const REAL_PLUGINS_DIR = join(ROOT, "plugins");

describe("Plugin System Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let toolRegistry: ToolRegistry;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openvger-e2e-plugin-${uuid()}`);
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    toolRegistry = new ToolRegistry();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("loads the real example-logger plugin from plugins/ directory", async () => {
    const registry = new PluginRegistry({
      journal,
      toolRegistry,
      pluginsDir: REAL_PLUGINS_DIR,
    });

    const states = await registry.discoverAndLoadAll();
    expect(states.length).toBeGreaterThanOrEqual(1);

    const logger = states.find((s) => s.id === "example-logger");
    expect(logger).toBeDefined();
    expect(logger!.status).toBe("active");
    expect(logger!.manifest.provides.hooks).toContain("before_step");
    expect(logger!.manifest.provides.hooks).toContain("after_step");
  });

  it("fires hooks from the real example-logger plugin", async () => {
    const registry = new PluginRegistry({
      journal,
      toolRegistry,
      pluginsDir: REAL_PLUGINS_DIR,
    });

    await registry.discoverAndLoadAll();
    const hookRunner = registry.getHookRunner();

    const result = await hookRunner.run("before_step", {
      session_id: "smoke-test-session",
      plugin_id: "kernel",
      step_id: "step-1",
      tool: "read-file",
    });

    // example-logger returns { action: "observe" }, hookRunner treats as "continue"
    expect(result.action).toBe("continue");

    // Verify journal recorded the hook firing
    const events = await journal.readAll();
    const hookEvents = events.filter((e) => e.type === "plugin.hook_fired");
    expect(hookEvents.length).toBeGreaterThan(0);
  });

  it("unloads plugin and hooks stop firing journal events for it", async () => {
    const registry = new PluginRegistry({
      journal,
      toolRegistry,
      pluginsDir: REAL_PLUGINS_DIR,
    });

    await registry.discoverAndLoadAll();
    const hookRunner = registry.getHookRunner();

    // Fire once to confirm it works
    await hookRunner.run("before_step", {
      session_id: "test",
      plugin_id: "kernel",
      step_id: "s1",
      tool: "t",
    });

    const eventsBeforeUnload = await journal.readAll();
    const hookFiredCountBefore = eventsBeforeUnload.filter((e) => e.type === "plugin.hook_fired").length;

    // Unload
    await registry.unloadPlugin("example-logger");
    expect(registry.getPlugin("example-logger")!.status).toBe("unloaded");

    // Fire again — should produce no hook_fired event for this plugin
    await hookRunner.run("before_step", {
      session_id: "test",
      plugin_id: "kernel",
      step_id: "s2",
      tool: "t",
    });

    const eventsAfterUnload = await journal.readAll();
    const hookFiredCountAfter = eventsAfterUnload.filter((e) => e.type === "plugin.hook_fired").length;

    // No new hook_fired events should have been added
    expect(hookFiredCountAfter).toBe(hookFiredCountBefore);
  });

  it("loads a custom plugin with route and serves it through API server", async () => {
    // Create a temporary plugin with a route
    const pluginsDir = join(testDir, "plugins");
    const pluginDir = join(pluginsDir, "status-plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(join(pluginDir, "plugin.yaml"), `id: status-plugin
name: Status Plugin
version: "1.0.0"
description: E2E smoke test plugin with route
entry: index.js
permissions: []
provides:
  routes:
    - status
  hooks:
    - before_step
`);

    await writeFile(join(pluginDir, "index.js"), `
export async function register(api) {
  api.registerRoute("GET", "status", async (req, res) => {
    res.json({ smoke: true, timestamp: Date.now() });
  });
  api.registerHook("before_step", async (ctx) => {
    return { action: "observe" };
  });
}
`);

    const pluginRegistry = new PluginRegistry({
      journal,
      toolRegistry,
      pluginsDir,
    });
    const states = await pluginRegistry.discoverAndLoadAll();
    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe("active");

    // Create API server with the plugin registry
    const apiServer = new ApiServer({
      toolRegistry,
      journal,
      pluginRegistry,
    });

    const port = 30000 + Math.floor(Math.random() * 10000);
    const app = apiServer.getExpressApp();
    const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    try {
      // Plugin route should be served
      const routeRes = await fetch(`http://localhost:${port}/api/plugins/status-plugin/status`);
      expect(routeRes.status).toBe(200);
      const routeBody = await routeRes.json() as { smoke: boolean };
      expect(routeBody.smoke).toBe(true);

      // Plugin should appear in plugins list
      const listRes = await fetch(`http://localhost:${port}/api/plugins`);
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json() as { plugins: Array<{ id: string; status: string }> };
      expect(listBody.plugins).toHaveLength(1);
      expect(listBody.plugins[0]!.id).toBe("status-plugin");

      // Health check should show plugin
      const healthRes = await fetch(`http://localhost:${port}/api/health`);
      const healthBody = await healthRes.json() as { checks: { plugins: { status: string; loaded: number } } };
      expect(healthBody.checks.plugins.status).toBe("ok");
      expect(healthBody.checks.plugins.loaded).toBe(1);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("discovers journal events from full plugin lifecycle", async () => {
    const registry = new PluginRegistry({
      journal,
      toolRegistry,
      pluginsDir: REAL_PLUGINS_DIR,
    });

    await registry.discoverAndLoadAll();
    await registry.unloadPlugin("example-logger");

    const events = await journal.readAll();
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("plugin.discovered");
    expect(eventTypes).toContain("plugin.loading");
    expect(eventTypes).toContain("plugin.loaded");
    expect(eventTypes).toContain("plugin.unloaded");
  });
});
