import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry } from "@karnevil9/tools";
import { PluginDiscovery, PluginRegistry } from "@karnevil9/plugins";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const REAL_PLUGINS_DIR = join(ROOT, "plugins");

describe("Plugin Lifecycle Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let toolRegistry: ToolRegistry;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-pluglife-${uuid()}`);
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    toolRegistry = new ToolRegistry();
  });

  afterEach(async () => {
    await journal.close();
    await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  // ─── 1. Plugin Discovery ───────────────────────────────────────────

  describe("Plugin Discovery", () => {
    it("discovers plugins with valid manifests from the real plugins/ directory", async () => {
      const discovery = new PluginDiscovery();
      const plugins = await discovery.scanDirectory(REAL_PLUGINS_DIR);

      expect(plugins.length).toBeGreaterThanOrEqual(1);

      // Every discovered plugin must have required manifest fields
      for (const plugin of plugins) {
        expect(plugin.manifest.id).toBeTruthy();
        expect(typeof plugin.manifest.id).toBe("string");
        expect(plugin.manifest.name).toBeTruthy();
        expect(typeof plugin.manifest.name).toBe("string");
        expect(plugin.manifest.version).toBeTruthy();
        expect(typeof plugin.manifest.version).toBe("string");
        expect(plugin.manifest.entry).toBeTruthy();
        expect(typeof plugin.manifest.entry).toBe("string");
        expect(plugin.directory).toBeTruthy();
        expect(plugin.contentHash).toBeTruthy();
        expect(plugin.contentHash).toHaveLength(64); // SHA-256 hex
      }

      // The example-logger must always be present
      const logger = plugins.find((p) => p.manifest.id === "example-logger");
      expect(logger).toBeDefined();
      expect(logger!.manifest.entry).toBe("index.js");
      expect(logger!.manifest.provides.hooks).toContain("before_step");
      expect(logger!.manifest.provides.hooks).toContain("after_step");
    });

    it("discovers plugins from a custom temp directory with multiple plugins", async () => {
      const pluginsDir = join(testDir, "plugins");
      await mkdir(pluginsDir, { recursive: true });

      // Create two valid plugins
      for (const name of ["alpha", "beta"]) {
        const dir = join(pluginsDir, name);
        await mkdir(dir);
        await writeFile(
          join(dir, "plugin.yaml"),
          `id: ${name}\nname: ${name} Plugin\nversion: "1.0.0"\ndescription: Test\nentry: index.js\npermissions: []\nprovides:\n  hooks:\n    - before_step\n`,
        );
        await writeFile(
          join(dir, "index.js"),
          `export async function register(api) {\n  api.registerHook("before_step", async () => ({ action: "observe" }));\n}\n`,
        );
      }

      const discovery = new PluginDiscovery();
      const plugins = await discovery.scanDirectory(pluginsDir);

      expect(plugins).toHaveLength(2);
      const ids = plugins.map((p) => p.manifest.id).sort();
      expect(ids).toEqual(["alpha", "beta"]);
    });

    it("returns empty array for a non-existent directory", async () => {
      const discovery = new PluginDiscovery();
      const plugins = await discovery.scanDirectory(join(testDir, "does-not-exist"));
      expect(plugins).toEqual([]);
    });

    it("skips directories without plugin.yaml", async () => {
      const pluginsDir = join(testDir, "plugins");
      const emptyDir = join(pluginsDir, "no-manifest");
      await mkdir(emptyDir, { recursive: true });
      await writeFile(join(emptyDir, "index.js"), `export function register() {}`);

      const discovery = new PluginDiscovery();
      const plugins = await discovery.scanDirectory(pluginsDir);
      expect(plugins).toEqual([]);
    });
  });

  // ─── 2. Plugin Loading and Registration ─────────────────────────────

  describe("Plugin Loading and Registration", () => {
    it("loads a plugin and calls its register() function", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "reg-test");
      await mkdir(pluginDir, { recursive: true });

      // The plugin writes a marker to prove register() was called
      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: reg-test\nname: Register Test\nversion: "1.0.0"\ndescription: Tests registration\nentry: index.js\npermissions: []\nprovides:\n  hooks:\n    - before_step\n    - after_step\n  commands:\n    - greet\n`,
      );
      await writeFile(
        join(pluginDir, "index.js"),
        `export async function register(api) {
  api.registerHook("before_step", async (ctx) => ({ action: "continue", data: { registered: true } }));
  api.registerHook("after_step", async (ctx) => ({ action: "observe" }));
  api.registerCommand("greet", {
    description: "Say hello",
    action: async () => { /* no-op */ },
  });
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      const states = await registry.discoverAndLoadAll();

      expect(states).toHaveLength(1);
      expect(states[0]!.status).toBe("active");
      expect(states[0]!.id).toBe("reg-test");
      expect(states[0]!.loaded_at).toBeTruthy();

      // Hooks should be wired
      const hookRunner = registry.getHookRunner();
      const result = await hookRunner.run("before_step", {
        session_id: "s1",
        plugin_id: "kernel",
        step_id: "step-1",
      });
      expect(result.action).toBe("modify");
      expect((result as { data: Record<string, unknown> }).data.registered).toBe(true);

      // Command should be registered
      const commands = registry.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]!.name).toBe("greet");
      expect(commands[0]!.pluginId).toBe("reg-test");
    });

    it("loads a plugin with a tool registration", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "tool-test");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: tool-test\nname: Tool Test\nversion: "1.0.0"\ndescription: Tests tool registration\nentry: index.js\npermissions: []\nprovides:\n  tools:\n    - my-custom-tool\n`,
      );
      await writeFile(
        join(pluginDir, "index.js"),
        `export async function register(api) {
  api.registerTool(
    {
      name: "my-custom-tool",
      version: "1.0.0",
      description: "A test tool",
      runner: "internal",
      input_schema: { type: "object", properties: { msg: { type: "string" } } },
      output_schema: { type: "object" },
      permissions: ["test:run:my-custom-tool"],
      timeout_ms: 5000,
      supports: { mock: true, dry_run: false },
    },
    async (input) => ({ success: true, output: "hello from tool", metadata: {} }),
  );
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      const states = await registry.discoverAndLoadAll();

      expect(states).toHaveLength(1);
      expect(states[0]!.status).toBe("active");

      // Tool should now be in the ToolRegistry
      const tool = toolRegistry.get("my-custom-tool");
      expect(tool).toBeDefined();
      expect(tool!.name).toBe("my-custom-tool");
      expect(tool!.runner).toBe("internal");
    });

    it("loads the real example-logger plugin via loadPlugin()", async () => {
      const pluginDir = join(REAL_PLUGINS_DIR, "example-logger");
      const registry = new PluginRegistry({
        journal,
        toolRegistry,
        pluginsDir: REAL_PLUGINS_DIR,
      });

      const state = await registry.loadPlugin(pluginDir);
      expect(state.status).toBe("active");
      expect(state.id).toBe("example-logger");
      expect(state.manifest.provides.hooks).toContain("before_step");
    });
  });

  // ─── 3. Hook Execution Lifecycle ────────────────────────────────────

  describe("Hook Execution Lifecycle", () => {
    it("fires before_step and after_step hooks in priority order", async () => {
      const pluginsDir = join(testDir, "plugins");

      // Plugin A: priority 50 (fires first)
      const dirA = join(pluginsDir, "hook-a");
      await mkdir(dirA, { recursive: true });
      await writeFile(
        join(dirA, "plugin.yaml"),
        `id: hook-a\nname: Hook A\nversion: "1.0.0"\ndescription: High priority\nentry: index.js\npermissions: []\nprovides:\n  hooks:\n    - before_step\n    - after_step\n`,
      );
      await writeFile(
        join(dirA, "index.js"),
        `export async function register(api) {
  api.registerHook("before_step", async (ctx) => {
    return { action: "continue", data: { order: [..."a"] } };
  }, { priority: 50 });
  api.registerHook("after_step", async (ctx) => {
    return { action: "continue", data: { after_a: true } };
  }, { priority: 50 });
}
`,
      );

      // Plugin B: priority 100 (fires second)
      const dirB = join(pluginsDir, "hook-b");
      await mkdir(dirB, { recursive: true });
      await writeFile(
        join(dirB, "plugin.yaml"),
        `id: hook-b\nname: Hook B\nversion: "1.0.0"\ndescription: Low priority\nentry: index.js\npermissions: []\nprovides:\n  hooks:\n    - before_step\n    - after_step\n`,
      );
      await writeFile(
        join(dirB, "index.js"),
        `export async function register(api) {
  api.registerHook("before_step", async (ctx) => {
    return { action: "continue", data: { b_saw_order: ctx.order } };
  }, { priority: 100 });
  api.registerHook("after_step", async (ctx) => {
    return { action: "continue", data: { after_b: true } };
  }, { priority: 100 });
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      await registry.discoverAndLoadAll();
      const hookRunner = registry.getHookRunner();

      // before_step: A runs first (priority 50), injects { order: ["a"] }
      // B runs second (priority 100), sees ctx.order from A's merged data
      const beforeResult = await hookRunner.run("before_step", {
        session_id: "s1",
        plugin_id: "kernel",
        step_id: "step-1",
      });
      expect(beforeResult.action).toBe("modify");
      const data = (beforeResult as { data: Record<string, unknown> }).data;
      expect(data.order).toEqual(["a"]);
      // B saw the order from A
      expect(data.b_saw_order).toEqual(["a"]);

      // after_step: both should merge data
      const afterResult = await hookRunner.run("after_step", {
        session_id: "s1",
        plugin_id: "kernel",
        step_id: "step-1",
      });
      expect(afterResult.action).toBe("modify");
      const afterData = (afterResult as { data: Record<string, unknown> }).data;
      expect(afterData.after_a).toBe(true);
      expect(afterData.after_b).toBe(true);
    });

    it("before_step block action stops hook chain execution", async () => {
      const pluginsDir = join(testDir, "plugins");

      const dir = join(pluginsDir, "blocker");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "plugin.yaml"),
        `id: blocker\nname: Blocker\nversion: "1.0.0"\ndescription: Blocks steps\nentry: index.js\npermissions: []\nprovides:\n  hooks:\n    - before_step\n`,
      );
      await writeFile(
        join(dir, "index.js"),
        `export async function register(api) {
  api.registerHook("before_step", async (ctx) => {
    return { action: "block", reason: "Denied by policy" };
  });
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      await registry.discoverAndLoadAll();
      const hookRunner = registry.getHookRunner();

      const result = await hookRunner.run("before_step", {
        session_id: "s1",
        plugin_id: "kernel",
        step_id: "step-1",
      });

      expect(result.action).toBe("block");
      expect((result as { reason: string }).reason).toBe("Denied by policy");
    });

    it("hook context data merges across plugins", async () => {
      const pluginsDir = join(testDir, "plugins");

      // Plugin that injects { enriched: "yes" } via modify
      const dir = join(pluginsDir, "enricher");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "plugin.yaml"),
        `id: enricher\nname: Enricher\nversion: "1.0.0"\ndescription: Enriches context\nentry: index.js\npermissions: []\nprovides:\n  hooks:\n    - before_step\n`,
      );
      await writeFile(
        join(dir, "index.js"),
        `export async function register(api) {
  api.registerHook("before_step", async (ctx) => {
    return { action: "modify", data: { enriched: "yes", timestamp: 12345 } };
  });
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      await registry.discoverAndLoadAll();
      const hookRunner = registry.getHookRunner();

      const result = await hookRunner.run("before_step", {
        session_id: "s1",
        plugin_id: "kernel",
      });

      expect(result.action).toBe("modify");
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.enriched).toBe("yes");
      expect(data.timestamp).toBe(12345);
    });

    it("journal records hook_fired events with correct plugin_id", async () => {
      const registry = new PluginRegistry({
        journal,
        toolRegistry,
        pluginsDir: REAL_PLUGINS_DIR,
      });

      await registry.discoverAndLoadAll();
      const hookRunner = registry.getHookRunner();

      await hookRunner.run("before_step", {
        session_id: "journal-test",
        plugin_id: "kernel",
        step_id: "s1",
        tool: "test-tool",
      });

      const events = await journal.readAll();
      const hookFired = events.filter(
        (e) => e.type === "plugin.hook_fired" && (e.payload as Record<string, unknown>).plugin_id === "example-logger",
      );
      expect(hookFired.length).toBeGreaterThan(0);
    });
  });

  // ─── 4. Plugin Route Registration ──────────────────────────────────

  describe("Plugin Route Registration", () => {
    it("registers routes that appear in the registry getRoutes()", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "route-plugin");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: route-plugin\nname: Route Plugin\nversion: "1.0.0"\ndescription: Has routes\nentry: index.js\npermissions: []\nprovides:\n  routes:\n    - status\n    - info\n`,
      );
      await writeFile(
        join(pluginDir, "index.js"),
        `export async function register(api) {
  api.registerRoute("GET", "status", async (req, res) => {
    res.json({ ok: true });
  });
  api.registerRoute("GET", "info", async (req, res) => {
    res.json({ version: "1.0.0" });
  });
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      await registry.discoverAndLoadAll();

      const routes = registry.getRoutes();
      expect(routes).toHaveLength(2);

      const statusRoute = routes.find((r) => r.path.includes("status"));
      expect(statusRoute).toBeDefined();
      expect(statusRoute!.method).toBe("GET");
      expect(statusRoute!.pluginId).toBe("route-plugin");
      expect(statusRoute!.path).toContain("/api/plugins/route-plugin/");

      const infoRoute = routes.find((r) => r.path.includes("info"));
      expect(infoRoute).toBeDefined();
      expect(infoRoute!.method).toBe("GET");
    });

    it("routes are removed after plugin unload", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "rm-route");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: rm-route\nname: Route Remover\nversion: "1.0.0"\ndescription: Unload route test\nentry: index.js\npermissions: []\nprovides:\n  routes:\n    - health\n`,
      );
      await writeFile(
        join(pluginDir, "index.js"),
        `export async function register(api) {
  api.registerRoute("GET", "health", async (req, res) => {
    res.json({ status: "up" });
  });
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      await registry.discoverAndLoadAll();
      expect(registry.getRoutes()).toHaveLength(1);

      await registry.unloadPlugin("rm-route");
      expect(registry.getRoutes()).toHaveLength(0);
    });
  });

  // ─── 5. Plugin Service Lifecycle ────────────────────────────────────

  describe("Plugin Service Lifecycle", () => {
    it("starts services on load and stops them on unload", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "svc-plugin");
      await mkdir(pluginDir, { recursive: true });

      // The plugin registers a service that records start/stop calls via
      // a side-channel file we can check afterwards.
      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: svc-plugin\nname: Service Plugin\nversion: "1.0.0"\ndescription: Service lifecycle test\nentry: index.js\npermissions: []\nprovides:\n  services:\n    - heartbeat\n  hooks:\n    - before_step\n`,
      );
      await writeFile(
        join(pluginDir, "index.js"),
        `import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function register(api) {
  const markerDir = api.config.markerDir;
  api.registerService({
    name: "heartbeat",
    async start() {
      writeFileSync(join(markerDir, "started"), "1");
    },
    async stop() {
      writeFileSync(join(markerDir, "stopped"), "1");
    },
    async health() {
      return { ok: true, detail: "beating" };
    },
  });

  // Need at least one hook from provides.hooks
  api.registerHook("before_step", async () => ({ action: "observe" }));
}
`,
      );

      const markerDir = join(testDir, "markers");
      await mkdir(markerDir, { recursive: true });

      const registry = new PluginRegistry({
        journal,
        toolRegistry,
        pluginsDir,
        pluginConfigs: { "svc-plugin": { markerDir } },
      });

      const states = await registry.discoverAndLoadAll();
      expect(states).toHaveLength(1);
      expect(states[0]!.status).toBe("active");

      // Verify service was started
      const { readFile } = await import("node:fs/promises");
      const started = await readFile(join(markerDir, "started"), "utf-8");
      expect(started).toBe("1");

      // Journal should record service_started
      const eventsAfterLoad = await journal.readAll();
      const startedEvents = eventsAfterLoad.filter((e) => e.type === "plugin.service_started");
      expect(startedEvents.length).toBe(1);

      // Unload should stop the service
      await registry.unloadPlugin("svc-plugin");

      const stopped = await readFile(join(markerDir, "stopped"), "utf-8");
      expect(stopped).toBe("1");

      // Journal should record service_stopped
      const eventsAfterUnload = await journal.readAll();
      const stoppedEvents = eventsAfterUnload.filter((e) => e.type === "plugin.service_stopped");
      expect(stoppedEvents.length).toBe(1);
    });

    it("records service_failed event when a service start throws", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "bad-svc");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: bad-svc\nname: Bad Service\nversion: "1.0.0"\ndescription: Service that fails to start\nentry: index.js\npermissions: []\nprovides:\n  services:\n    - broken\n  hooks:\n    - before_step\n`,
      );
      await writeFile(
        join(pluginDir, "index.js"),
        `export async function register(api) {
  api.registerService({
    name: "broken",
    async start() { throw new Error("port in use"); },
    async stop() {},
  });
  api.registerHook("before_step", async () => ({ action: "observe" }));
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      const states = await registry.discoverAndLoadAll();

      // Plugin still loads as "active" since service failure is non-fatal
      expect(states[0]!.status).toBe("active");

      const events = await journal.readAll();
      const failedEvents = events.filter((e) => e.type === "plugin.service_failed");
      expect(failedEvents.length).toBe(1);
      const payload = failedEvents[0]!.payload as Record<string, unknown>;
      expect(payload.error).toContain("port in use");
    });
  });

  // ─── 6. Invalid Plugin Handling ─────────────────────────────────────

  describe("Invalid Plugin Handling", () => {
    it("skips plugin with malformed YAML in plugin.yaml", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "bad-yaml");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(join(pluginDir, "plugin.yaml"), `{{{{{not: valid: yaml:`);
      await writeFile(join(pluginDir, "index.js"), `export function register() {}`);

      const discovery = new PluginDiscovery();
      const plugins = await discovery.scanDirectory(pluginsDir);
      expect(plugins).toEqual([]);
    });

    it("skips plugin with invalid manifest (missing required fields)", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "missing-fields");
      await mkdir(pluginDir, { recursive: true });

      // Missing id, version, entry
      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `name: Incomplete\ndescription: Missing fields\n`,
      );
      await writeFile(join(pluginDir, "index.js"), `export function register() {}`);

      const discovery = new PluginDiscovery();
      const plugins = await discovery.scanDirectory(pluginsDir);
      expect(plugins).toEqual([]);
    });

    it("handles missing entry file gracefully", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "no-entry");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: no-entry\nname: No Entry\nversion: "1.0.0"\ndescription: Entry file missing\nentry: missing.js\npermissions: []\nprovides: {}\n`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      const states = await registry.discoverAndLoadAll();

      expect(states).toHaveLength(1);
      expect(states[0]!.status).toBe("failed");
      expect(states[0]!.error).toContain("Failed to import");
    });

    it("handles register() function that throws", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "throws-on-register");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: throws-on-register\nname: Thrower\nversion: "1.0.0"\ndescription: Throws during register\nentry: index.js\npermissions: []\nprovides: {}\n`,
      );
      await writeFile(
        join(pluginDir, "index.js"),
        `export async function register(api) { throw new Error("init explosion"); }`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      const states = await registry.discoverAndLoadAll();

      expect(states).toHaveLength(1);
      expect(states[0]!.status).toBe("failed");
      expect(states[0]!.error).toContain("init explosion");

      // Journal should have plugin.failed event
      const events = await journal.readAll();
      const failedEvents = events.filter((e) => e.type === "plugin.failed");
      expect(failedEvents.length).toBeGreaterThan(0);
    });

    it("handles entry file that does not export register()", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "no-register");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: no-register\nname: No Register\nversion: "1.0.0"\ndescription: No register export\nentry: index.js\npermissions: []\nprovides: {}\n`,
      );
      await writeFile(join(pluginDir, "index.js"), `export const value = 42;`);

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      const states = await registry.discoverAndLoadAll();

      expect(states).toHaveLength(1);
      expect(states[0]!.status).toBe("failed");
      expect(states[0]!.error).toContain("does not export a register() function");
    });

    it("rejects plugin with path traversal in entry field", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "traversal");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: traversal\nname: Traversal\nversion: "1.0.0"\ndescription: Path traversal attempt\nentry: ../../../etc/passwd\npermissions: []\nprovides: {}\n`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      const states = await registry.discoverAndLoadAll();

      expect(states).toHaveLength(1);
      expect(states[0]!.status).toBe("failed");
      expect(states[0]!.error).toContain("unsafe entry path");
    });

    it("valid plugins still load when an invalid plugin is in the same directory", async () => {
      const pluginsDir = join(testDir, "plugins");

      // Valid plugin
      const goodDir = join(pluginsDir, "good-plugin");
      await mkdir(goodDir, { recursive: true });
      await writeFile(
        join(goodDir, "plugin.yaml"),
        `id: good-plugin\nname: Good Plugin\nversion: "1.0.0"\ndescription: Works fine\nentry: index.js\npermissions: []\nprovides:\n  hooks:\n    - before_step\n`,
      );
      await writeFile(
        join(goodDir, "index.js"),
        `export async function register(api) {\n  api.registerHook("before_step", async () => ({ action: "observe" }));\n}`,
      );

      // Invalid plugin (bad YAML)
      const badDir = join(pluginsDir, "bad-plugin");
      await mkdir(badDir, { recursive: true });
      await writeFile(join(badDir, "plugin.yaml"), `not valid yaml {{{`);

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
      const states = await registry.discoverAndLoadAll();

      // Only the valid plugin should appear (bad one is skipped during discovery)
      expect(states).toHaveLength(1);
      expect(states[0]!.id).toBe("good-plugin");
      expect(states[0]!.status).toBe("active");
    });
  });

  // ─── Full Lifecycle: discover → load → fire → unload → reload ─────

  describe("Full Lifecycle", () => {
    it("discover → load → fire hooks → unload → verify hooks stop → reload", async () => {
      const pluginsDir = join(testDir, "plugins");
      const pluginDir = join(pluginsDir, "lifecycle");
      await mkdir(pluginDir, { recursive: true });

      await writeFile(
        join(pluginDir, "plugin.yaml"),
        `id: lifecycle\nname: Lifecycle Plugin\nversion: "1.0.0"\ndescription: Full lifecycle test\nentry: index.js\npermissions: []\nprovides:\n  hooks:\n    - before_step\n    - after_step\n  routes:\n    - ping\n  commands:\n    - hello\n`,
      );
      await writeFile(
        join(pluginDir, "index.js"),
        `export async function register(api) {
  api.registerHook("before_step", async (ctx) => {
    return { action: "continue", data: { lifecycle: "active" } };
  });
  api.registerHook("after_step", async (ctx) => {
    return { action: "observe" };
  });
  api.registerRoute("GET", "ping", async (req, res) => {
    res.json({ pong: true });
  });
  api.registerCommand("hello", {
    description: "Say hello",
    action: async () => {},
  });
}
`,
      );

      const registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });

      // Phase 1: Discover and load
      const states = await registry.discoverAndLoadAll();
      expect(states).toHaveLength(1);
      expect(states[0]!.status).toBe("active");

      // Phase 2: Fire hooks and verify
      const hookRunner = registry.getHookRunner();
      const result1 = await hookRunner.run("before_step", {
        session_id: "lifecycle",
        plugin_id: "kernel",
        step_id: "s1",
      });
      expect(result1.action).toBe("modify");
      expect((result1 as { data: Record<string, unknown> }).data.lifecycle).toBe("active");

      // Verify routes and commands exist
      expect(registry.getRoutes()).toHaveLength(1);
      expect(registry.getCommands()).toHaveLength(1);

      // Phase 3: Unload
      await registry.unloadPlugin("lifecycle");
      expect(registry.getPlugin("lifecycle")!.status).toBe("unloaded");
      expect(registry.getRoutes()).toHaveLength(0);
      expect(registry.getCommands()).toHaveLength(0);

      // Phase 4: Hooks should not fire for unloaded plugin
      const result2 = await hookRunner.run("before_step", {
        session_id: "lifecycle",
        plugin_id: "kernel",
        step_id: "s2",
      });
      expect(result2.action).toBe("continue");
      expect(result2).not.toHaveProperty("data");

      // Phase 5: Reload
      const reloaded = await registry.reloadPlugin("lifecycle");
      expect(reloaded.status).toBe("active");

      // Phase 6: Hooks fire again after reload
      const result3 = await hookRunner.run("before_step", {
        session_id: "lifecycle",
        plugin_id: "kernel",
        step_id: "s3",
      });
      expect(result3.action).toBe("modify");
      expect((result3 as { data: Record<string, unknown> }).data.lifecycle).toBe("active");

      // Routes and commands restored
      expect(registry.getRoutes()).toHaveLength(1);
      expect(registry.getCommands()).toHaveLength(1);

      // Phase 7: Verify full journal trail
      const events = await journal.readAll();
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("plugin.discovered");
      expect(eventTypes).toContain("plugin.loading");
      expect(eventTypes).toContain("plugin.loaded");
      expect(eventTypes).toContain("plugin.hook_fired");
      expect(eventTypes).toContain("plugin.unloaded");
      expect(eventTypes).toContain("plugin.reloaded");
    });
  });
});
