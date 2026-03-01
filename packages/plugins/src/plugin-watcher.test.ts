import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry } from "@karnevil9/tools";
import { PluginRegistry } from "./plugin-registry.js";
import { PluginWatcher, type PluginReloadEvent, type PluginReloadError } from "./plugin-watcher.js";

/** Helper: wait for a condition with polling */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("PluginWatcher", () => {
  let testDir: string;
  let pluginsDir: string;
  let journal: Journal;
  let toolRegistry: ToolRegistry;
  let registry: PluginRegistry;
  let watcher: PluginWatcher;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-watcher-${uuid()}`);
    pluginsDir = join(testDir, "plugins");
    await mkdir(pluginsDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), {
      fsync: false,
      redact: false,
      lock: false,
    });
    await journal.init();
    toolRegistry = new ToolRegistry();
    registry = new PluginRegistry({ journal, toolRegistry, pluginsDir });
  });

  afterEach(async () => {
    if (watcher?.isRunning()) {
      await watcher.stop();
    }
    await rm(testDir, { recursive: true, force: true });
  });

  async function createPlugin(
    id: string,
    code: string,
    provides?: Record<string, string[]>,
  ): Promise<string> {
    const dir = join(pluginsDir, id);
    await mkdir(dir, { recursive: true });

    let providesYaml = "provides: {}";
    if (provides && Object.keys(provides).length > 0) {
      const lines = Object.entries(provides).map(([k, v]) => {
        if (v.length === 0) return `  ${k}: []`;
        return `  ${k}:\n${v.map((i) => `    - ${i}`).join("\n")}`;
      });
      providesYaml = `provides:\n${lines.join("\n")}`;
    }

    await writeFile(
      join(dir, "plugin.yaml"),
      `id: ${id}
name: ${id}
version: "1.0.0"
description: Test plugin ${id}
entry: index.js
permissions: []
${providesYaml}
`,
    );
    await writeFile(join(dir, "index.js"), code);
    return dir;
  }

  it("starts and stops without error", async () => {
    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 50,
    });

    await watcher.start();
    expect(watcher.isRunning()).toBe(true);
    expect(watcher.getWatchedDirs()).toContain("__root__");

    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);
    expect(watcher.getWatchedDirs()).toHaveLength(0);
  });

  it("watches existing plugin subdirectories on start", async () => {
    await createPlugin(
      "existing",
      `export async function register(api) {}`,
      {},
    );

    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 50,
    });
    await watcher.start();

    // Should have root + existing plugin dir
    const watched = watcher.getWatchedDirs();
    expect(watched).toContain("__root__");
    expect(watched).toContain("existing");
  });

  it("detects file changes and triggers reload", { timeout: 15000 }, async () => {
    // Create and load initial plugin
    await createPlugin(
      "hot-reload",
      `export async function register(api) {}`,
      {},
    );
    await registry.discoverAndLoadAll();
    expect(registry.getPlugin("hot-reload")?.status).toBe("active");

    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 100,
    });
    await watcher.start();

    // Small settle delay for fs.watch initialization
    await new Promise((r) => setTimeout(r, 100));

    // Track reload events
    const reloadEvents: PluginReloadEvent[] = [];
    watcher.on("reload", (evt: PluginReloadEvent) => reloadEvents.push(evt));

    // Modify the plugin manifest (changes content hash)
    await writeFile(
      join(pluginsDir, "hot-reload", "plugin.yaml"),
      `id: hot-reload
name: hot-reload-updated
version: "2.0.0"
description: Updated test plugin
entry: index.js
permissions: []
provides: {}
`,
    );

    // Wait for the debounced reload to fire
    await waitFor(() => reloadEvents.length > 0, 10000);

    expect(reloadEvents).toHaveLength(1);
    expect(reloadEvents[0]!.pluginId).toBe("hot-reload");

    // Plugin should still be active after reload
    expect(registry.getPlugin("hot-reload")?.status).toBe("active");
  });

  it("debounces multiple rapid changes into a single reload", { timeout: 15000 }, async () => {
    await createPlugin(
      "debounce-test",
      `export async function register(api) {}`,
      {},
    );
    await registry.discoverAndLoadAll();

    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 200,
    });
    await watcher.start();

    // Small settle delay for fs.watch initialization
    await new Promise((r) => setTimeout(r, 100));

    const reloadEvents: PluginReloadEvent[] = [];
    watcher.on("reload", (evt: PluginReloadEvent) => reloadEvents.push(evt));

    // Fire multiple rapid changes
    const dir = join(pluginsDir, "debounce-test");
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(dir, "plugin.yaml"),
        `id: debounce-test
name: debounce-test
version: "1.0.${i}"
description: Debounce iteration ${i}
entry: index.js
permissions: []
provides: {}
`,
      );
      // Small gap between writes (much less than debounce)
      await new Promise((r) => setTimeout(r, 20));
    }

    // Wait longer than debounce + reload time
    await waitFor(() => reloadEvents.length > 0, 10000);

    // Should have coalesced into a single reload (or at most 2 if timing is tight)
    expect(reloadEvents.length).toBeLessThanOrEqual(2);
    expect(reloadEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("emits error event when reload fails on bad plugin", { timeout: 15000 }, async () => {
    await createPlugin(
      "bad-reload",
      `export async function register(api) {}`,
      {},
    );
    await registry.discoverAndLoadAll();

    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 100,
    });
    await watcher.start();

    // Small settle delay for fs.watch initialization
    await new Promise((r) => setTimeout(r, 100));

    const errorEvents: PluginReloadError[] = [];
    watcher.on("error", (evt: PluginReloadError) => {
      errorEvents.push(evt);
    });

    // Break the plugin: change manifest entry to point to a non-existent file.
    // This triggers a content hash change AND causes the import to fail
    // (avoids ESM module caching issues in the vitest environment).
    await writeFile(
      join(pluginsDir, "bad-reload", "plugin.yaml"),
      `id: bad-reload
name: bad-reload
version: "2.0.0"
description: Broken plugin
entry: does-not-exist.js
permissions: []
provides: {}
`,
    );

    await waitFor(() => errorEvents.length > 0, 10000);

    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents[0]!.pluginId).toBe("bad-reload");
    expect(errorEvents[0]!.error).toBeTruthy();

    // Watcher should still be running (not crashed)
    expect(watcher.isRunning()).toBe(true);
  });

  it("does not reload when content hash is unchanged", async () => {
    await createPlugin(
      "no-change",
      `export async function register(api) {}`,
      {},
    );
    await registry.discoverAndLoadAll();

    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 50,
    });
    await watcher.start();

    const reloadEvents: PluginReloadEvent[] = [];
    watcher.on("reload", (evt: PluginReloadEvent) => reloadEvents.push(evt));

    // Touch the JS file but don't change the manifest (content hash is manifest-based)
    await writeFile(
      join(pluginsDir, "no-change", "index.js"),
      `export async function register(api) { /* same */ }`,
    );

    // Wait a bit -- no reload should fire
    await new Promise((r) => setTimeout(r, 500));
    expect(reloadEvents).toHaveLength(0);
  });

  it("start is idempotent", async () => {
    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 50,
    });

    await watcher.start();
    const watchedBefore = watcher.getWatchedDirs().length;

    // Second start should be a no-op
    await watcher.start();
    expect(watcher.getWatchedDirs().length).toBe(watchedBefore);
  });

  it("stop is idempotent", async () => {
    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 50,
    });

    // Stop before start -- should not throw
    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);

    await watcher.start();
    await watcher.stop();

    // Second stop -- should not throw
    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });

  it("handles missing plugins directory gracefully", async () => {
    const missingDir = join(testDir, "nonexistent-plugins");
    watcher = new PluginWatcher({
      registry: new PluginRegistry({ journal, toolRegistry, pluginsDir: missingDir }),
      journal,
      pluginsDir: missingDir,
      debounceMs: 50,
    });

    // Should not throw
    await watcher.start();
    expect(watcher.isRunning()).toBe(true);

    await watcher.stop();
  });

  it("unloadPlugin clears hooks and tools from registry", async () => {
    await createPlugin(
      "with-hook",
      `
      export async function register(api) {
        api.registerHook("before_step", async (ctx) => ({ action: "observe" }));
      }
    `,
      { hooks: ["before_step"] },
    );

    await registry.discoverAndLoadAll();
    const state = registry.getPlugin("with-hook");
    expect(state?.status).toBe("active");

    // HookRunner should have the hook
    const hookRunner = registry.getHookRunner();
    const result1 = await hookRunner.run("before_step", {
      session_id: "s1",
      hook: "before_step",
    });
    // "observe" maps to action="observe" which passes through as continue
    expect(result1.action).toBeDefined();

    // Unload
    await registry.unloadPlugin("with-hook");
    expect(registry.getPlugin("with-hook")?.status).toBe("unloaded");

    // Hook runner should no longer fire plugin hooks
    const result2 = await hookRunner.run("before_step", {
      session_id: "s1",
      hook: "before_step",
    });
    expect(result2.action).toBe("continue");
  });

  it("unloadPlugin removes tools from tool registry", async () => {
    await createPlugin(
      "with-tool",
      `
      export async function register(api) {
        api.registerTool(
          {
            name: "watcher-test-tool",
            version: "1.0.0",
            description: "test",
            runner: "internal",
            input_schema: { type: "object", additionalProperties: false },
            output_schema: { type: "object", additionalProperties: false },
            permissions: [],
            timeout_ms: 5000,
            supports: { mock: true, dry_run: false },
            mock_responses: [{}],
          },
          async () => ({ success: true })
        );
      }
    `,
      { tools: ["watcher-test-tool"] },
    );

    await registry.discoverAndLoadAll();
    expect(toolRegistry.get("watcher-test-tool")).toBeDefined();

    await registry.unloadPlugin("with-tool");
    expect(toolRegistry.get("watcher-test-tool")).toBeUndefined();
  });

  it("logs journal events on start and stop", async () => {
    watcher = new PluginWatcher({
      registry,
      journal,
      pluginsDir,
      debounceMs: 50,
    });

    await watcher.start();
    await watcher.stop();

    const events = await journal.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("plugin.watcher_started");
    expect(types).toContain("plugin.watcher_stopped");
  });
});
