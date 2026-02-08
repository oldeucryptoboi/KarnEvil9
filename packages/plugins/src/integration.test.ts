import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { Journal } from "@openvger/journal";
import { ToolRegistry } from "@openvger/tools";
import { PluginRegistry } from "./plugin-registry.js";

describe("Plugin System Integration", () => {
  let testDir: string;
  let pluginsDir: string;
  let journal: Journal;
  let toolRegistry: ToolRegistry;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openvger-test-${uuid()}`);
    pluginsDir = join(testDir, "plugins");
    await mkdir(pluginsDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    toolRegistry = new ToolRegistry();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("end-to-end: discover → load → fire hooks → verify journal → unload", async () => {
    // Create a plugin that registers a hook
    const pluginDir = join(pluginsDir, "e2e-plugin");
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, "plugin.yaml"), `
id: e2e-plugin
name: E2E Plugin
version: "1.0.0"
description: End-to-end test plugin
entry: index.js
permissions: []
provides:
  hooks:
    - before_step
    - after_step
`);
    await writeFile(join(pluginDir, "index.js"), `
export async function register(api) {
  api.registerHook("before_step", async (ctx) => {
    return { action: "continue", data: { injected: true } };
  });
  api.registerHook("after_step", async (ctx) => {
    return { action: "observe" };
  });
}
`);

    // Discover and load
    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    const states = await registry.discoverAndLoadAll();

    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe("active");

    // Fire hooks
    const hookRunner = registry.getHookRunner();
    const beforeResult = await hookRunner.run("before_step", {
      session_id: "test-session",
      plugin_id: "kernel",
      step_id: "step-1",
    });
    expect(beforeResult.action).toBe("modify");
    expect((beforeResult as { data: Record<string, unknown> }).data.injected).toBe(true);

    const afterResult = await hookRunner.run("after_step", {
      session_id: "test-session",
      plugin_id: "kernel",
      step_id: "step-1",
    });
    expect(afterResult.action).toBe("continue");

    // Verify journal events
    const events = await journal.readAll();
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("plugin.discovered");
    expect(eventTypes).toContain("plugin.loading");
    expect(eventTypes).toContain("plugin.loaded");
    expect(eventTypes).toContain("plugin.hook_fired");

    // Unload
    await registry.unloadPlugin("e2e-plugin");

    const unloadEvents = await journal.readAll();
    expect(unloadEvents.some((e) => e.type === "plugin.unloaded")).toBe(true);

    // Hooks should no longer fire for unloaded plugin
    const afterUnload = await hookRunner.run("before_step", {
      session_id: "test-session",
      plugin_id: "kernel",
      step_id: "step-2",
    });
    expect(afterUnload.action).toBe("continue");
  });
});
