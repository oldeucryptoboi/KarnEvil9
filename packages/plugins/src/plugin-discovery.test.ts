import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { PluginDiscovery } from "./plugin-discovery.js";

describe("PluginDiscovery", () => {
  let testDir: string;
  let discovery: PluginDiscovery;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openvger-test-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    discovery = new PluginDiscovery();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const validManifest = `
id: test-plugin
name: Test Plugin
version: "1.0.0"
description: A test plugin
entry: index.js
permissions: []
provides:
  hooks:
    - before_step
`;

  it("scans a valid directory", async () => {
    const pluginDir = join(testDir, "test-plugin");
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, "plugin.yaml"), validManifest);

    const results = await discovery.scanDirectory(testDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.manifest.id).toBe("test-plugin");
    expect(results[0]!.manifest.name).toBe("Test Plugin");
    expect(results[0]!.directory).toBe(pluginDir);
    expect(results[0]!.contentHash).toBeTruthy();
  });

  it("skips invalid manifests", async () => {
    const invalidDir = join(testDir, "invalid-plugin");
    await mkdir(invalidDir);
    await writeFile(join(invalidDir, "plugin.yaml"), "name: missing-fields");

    const results = await discovery.scanDirectory(testDir);
    expect(results).toHaveLength(0);
  });

  it("returns content hashes for cache invalidation", async () => {
    const pluginDir = join(testDir, "test-plugin");
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, "plugin.yaml"), validManifest);

    const results1 = await discovery.scanDirectory(testDir);
    const hash1 = results1[0]!.contentHash;

    // Same content should produce same hash
    const results2 = await discovery.scanDirectory(testDir);
    expect(results2[0]!.contentHash).toBe(hash1);

    // Modified content should produce different hash
    await writeFile(join(pluginDir, "plugin.yaml"), validManifest + "\n# modified");
    const results3 = await discovery.scanDirectory(testDir);
    expect(results3[0]!.contentHash).not.toBe(hash1);
  });

  it("returns empty array for non-existent directory", async () => {
    const results = await discovery.scanDirectory("/nonexistent/path");
    expect(results).toHaveLength(0);
  });

  it("scanSingle returns null for missing manifest", async () => {
    const emptyDir = join(testDir, "empty");
    await mkdir(emptyDir);
    const result = await discovery.scanSingle(emptyDir);
    expect(result).toBeNull();
  });

  it("scans multiple plugins", async () => {
    for (const name of ["plugin-a", "plugin-b"]) {
      const dir = join(testDir, name);
      await mkdir(dir);
      await writeFile(join(dir, "plugin.yaml"), validManifest.replace("test-plugin", name));
    }

    const results = await discovery.scanDirectory(testDir);
    expect(results).toHaveLength(2);
  });
});
