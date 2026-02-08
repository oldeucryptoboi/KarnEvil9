import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import type { PluginManifest } from "@openvger/schemas";
import { Journal } from "@openvger/journal";
import { PluginLoader } from "./plugin-loader.js";
import { PluginApiImpl } from "./plugin-api-impl.js";
import { PluginLoggerImpl } from "./plugin-logger.js";
import type { DiscoveredPlugin } from "./plugin-discovery.js";

describe("PluginLoader", () => {
  let testDir: string;
  let journalPath: string;
  let journal: Journal;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openvger-test-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journalPath = join(testDir, "journal.jsonl");
    journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
    return {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      entry: "index.js",
      permissions: [],
      provides: { hooks: ["before_step"] },
      ...overrides,
    };
  }

  function makeApi(manifest: PluginManifest): PluginApiImpl {
    return new PluginApiImpl(manifest, {}, new PluginLoggerImpl(manifest.id));
  }

  it("loads a valid plugin", async () => {
    const pluginDir = join(testDir, "valid-plugin");
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, "index.js"), `
      export async function register(api) {
        api.registerHook("before_step", async (ctx) => ({ action: "observe" }));
      }
    `);

    const manifest = makeManifest();
    const discovered: DiscoveredPlugin = { manifest, directory: pluginDir, contentHash: "abc" };
    const loader = new PluginLoader(journal);
    const api = makeApi(manifest);
    const result = await loader.load(discovered, api);

    expect(result.success).toBe(true);
    expect(api._hooks).toHaveLength(1);
  });

  it("times out on hanging register()", async () => {
    const pluginDir = join(testDir, "hanging-plugin");
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, "index.js"), `
      export async function register(api) {
        await new Promise(() => {}); // never resolves
      }
    `);

    const manifest = makeManifest();
    const discovered: DiscoveredPlugin = { manifest, directory: pluginDir, contentHash: "abc" };
    const loader = new PluginLoader(journal, { registerTimeoutMs: 100 });
    const api = makeApi(manifest);
    const result = await loader.load(discovered, api);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("rejects missing export", async () => {
    const pluginDir = join(testDir, "no-export");
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, "index.js"), `
      export const name = "not a register function";
    `);

    const manifest = makeManifest();
    const discovered: DiscoveredPlugin = { manifest, directory: pluginDir, contentHash: "abc" };
    const loader = new PluginLoader(journal);
    const api = makeApi(manifest);
    const result = await loader.load(discovered, api);

    expect(result.success).toBe(false);
    expect(result.error).toContain("register()");
  });

  it("handles import errors", async () => {
    const manifest = makeManifest();
    const discovered: DiscoveredPlugin = {
      manifest,
      directory: join(testDir, "nonexistent"),
      contentHash: "abc",
    };
    const loader = new PluginLoader(journal);
    const api = makeApi(manifest);
    const result = await loader.load(discovered, api);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to import");
  });

  it("journals loading and loaded events", async () => {
    const pluginDir = join(testDir, "journaled-plugin");
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, "index.js"), `
      export async function register(api) {}
    `);

    const manifest = makeManifest({ provides: {} });
    const discovered: DiscoveredPlugin = { manifest, directory: pluginDir, contentHash: "abc" };
    const loader = new PluginLoader(journal);
    const api = makeApi(manifest);
    await loader.load(discovered, api);

    const events = await journal.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("plugin.loading");
    expect(types).toContain("plugin.loaded");
  });
});
