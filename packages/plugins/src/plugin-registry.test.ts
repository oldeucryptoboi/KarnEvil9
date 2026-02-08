import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { Journal } from "@openvger/journal";
import { ToolRegistry } from "@openvger/tools";
import { PluginRegistry } from "./plugin-registry.js";

describe("PluginRegistry", () => {
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

  async function createPlugin(id: string, code: string, provides?: Record<string, string[]>) {
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

    await writeFile(join(dir, "plugin.yaml"), `id: ${id}
name: ${id}
version: "1.0.0"
description: Test plugin ${id}
entry: index.js
permissions: []
${providesYaml}
`);
    await writeFile(join(dir, "index.js"), code);
  }

  it("discovers and loads plugins", async () => {
    await createPlugin("simple", `
      export async function register(api) {}
    `, {});

    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    const states = await registry.discoverAndLoadAll();

    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe("active");
  });

  it("loadPlugin from specific directory", async () => {
    await createPlugin("specific", `
      export async function register(api) {}
    `, {});

    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    const state = await registry.loadPlugin(join(pluginsDir, "specific"));

    expect(state.status).toBe("active");
    expect(state.id).toBe("specific");
  });

  it("unloadPlugin removes plugin", async () => {
    await createPlugin("unloadable", `
      export async function register(api) {}
    `, {});

    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    await registry.discoverAndLoadAll();

    expect(registry.getPlugin("unloadable")!.status).toBe("active");
    await registry.unloadPlugin("unloadable");
    expect(registry.getPlugin("unloadable")!.status).toBe("unloaded");
  });

  it("reloadPlugin refreshes a plugin", async () => {
    await createPlugin("reloadable", `
      export async function register(api) {}
    `, {});

    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    await registry.discoverAndLoadAll();

    const state = await registry.reloadPlugin("reloadable");
    expect(state.status).toBe("active");
  });

  it("collects routes from plugins", async () => {
    await createPlugin("with-route", `
      export async function register(api) {
        api.registerRoute("GET", "status", async (req, res) => {
          res.json({ ok: true });
        });
      }
    `, { routes: ["status"] });

    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    await registry.discoverAndLoadAll();

    const routes = registry.getRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]!.path).toContain("/api/plugins/with-route/status");
  });

  it("starts and stops services", async () => {
    await createPlugin("with-service", `
      export async function register(api) {
        api.registerService({
          name: "bg",
          start: async () => {},
          stop: async () => {},
        });
      }
    `, { services: ["bg"] });

    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    await registry.discoverAndLoadAll();

    const events = await journal.readAll();
    expect(events.some((e) => e.type === "plugin.service_started")).toBe(true);

    await registry.unloadPlugin("with-service");
    const events2 = await journal.readAll();
    expect(events2.some((e) => e.type === "plugin.service_stopped")).toBe(true);
  });

  it("handles failed plugin load gracefully", async () => {
    await createPlugin("bad", `
      export async function register(api) {
        throw new Error("Plugin init failed");
      }
    `, {});

    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    const states = await registry.discoverAndLoadAll();

    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe("failed");
    expect(states[0]!.error).toContain("Plugin init failed");
  });

  it("listPlugins returns all plugin states", async () => {
    await createPlugin("a", `export async function register(api) {}`, {});
    await createPlugin("b", `export async function register(api) {}`, {});

    const registry = new PluginRegistry({
      journal, toolRegistry, pluginsDir,
    });
    await registry.discoverAndLoadAll();

    expect(registry.listPlugins()).toHaveLength(2);
  });
});
