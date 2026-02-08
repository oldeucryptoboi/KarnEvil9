import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import type { PluginManifest } from "@openvger/schemas";
import { validatePluginManifestData } from "@openvger/schemas";

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  directory: string;
  contentHash: string;
}

export class PluginDiscovery {
  async scanDirectory(pluginsDir: string): Promise<DiscoveredPlugin[]> {
    let entries;
    try {
      entries = await readdir(pluginsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: DiscoveredPlugin[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(pluginsDir, entry.name);
      const discovered = await this.scanSingle(pluginDir);
      if (discovered) results.push(discovered);
    }
    return results;
  }

  async scanSingle(pluginDir: string): Promise<DiscoveredPlugin | null> {
    const manifestPath = join(pluginDir, "plugin.yaml");
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      return null;
    }

    const contentHash = createHash("sha256").update(raw).digest("hex");
    let data: unknown;
    try {
      data = yaml.load(raw);
    } catch (err) {
      console.warn(`[plugin-discovery] Failed to parse ${manifestPath}: ${err}`);
      return null;
    }

    const validation = validatePluginManifestData(data);
    if (!validation.valid) {
      console.warn(`[plugin-discovery] Invalid manifest at ${manifestPath}: ${validation.errors.join(", ")}`);
      return null;
    }

    return {
      manifest: data as PluginManifest,
      directory: pluginDir,
      contentHash,
    };
  }
}
