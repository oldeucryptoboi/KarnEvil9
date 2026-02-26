import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Journal } from "@karnevil9/journal";
import type { PluginApi, PluginRegisterFn } from "@karnevil9/schemas";
import type { DiscoveredPlugin } from "./plugin-discovery.js";

export class PluginLoader {
  private journal: Journal;
  private registerTimeoutMs: number;

  constructor(journal: Journal, options?: { registerTimeoutMs?: number }) {
    this.journal = journal;
    this.registerTimeoutMs = options?.registerTimeoutMs ?? 5000;
  }

  async load(
    discovered: DiscoveredPlugin,
    api: PluginApi
  ): Promise<{ success: boolean; error?: string }> {
    const { manifest, directory } = discovered;

    await this.journal.emit(manifest.id, "plugin.loading", {
      plugin_id: manifest.id,
      name: manifest.name,
      version: manifest.version,
    });

    // Validate entry path against directory traversal
    if (manifest.entry.includes("..") || manifest.entry.startsWith("/")) {
      const message = `Plugin "${manifest.id}" has unsafe entry path: "${manifest.entry}" (must be relative, no "..")`;
      await this.journal.tryEmit(manifest.id, "plugin.failed", {
        plugin_id: manifest.id,
        error: message,
      });
      return { success: false, error: message };
    }

    let mod: Record<string, unknown>;
    try {
      const entryPath = join(directory, manifest.entry);
      // Verify resolved path is within the plugin directory
      const { resolve: resolvePath } = await import("node:path");
      const resolvedEntry = resolvePath(entryPath);
      const resolvedDir = resolvePath(directory);
      if (!resolvedEntry.startsWith(resolvedDir + "/") && resolvedEntry !== resolvedDir) {
        throw new Error(`Entry path "${manifest.entry}" resolves outside plugin directory`);
      }
      const entryUrl = pathToFileURL(entryPath).href;
      mod = (await import(entryUrl)) as Record<string, unknown>;
    } catch (err) {
      const message = `Failed to import plugin "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`;
      await this.journal.tryEmit(manifest.id, "plugin.failed", {
        plugin_id: manifest.id,
        error: message,
      });
      return { success: false, error: message };
    }

    const registerFn = mod.register as PluginRegisterFn | undefined;
    if (typeof registerFn !== "function") {
      const message = `Plugin "${manifest.id}" does not export a register() function`;
      await this.journal.tryEmit(manifest.id, "plugin.failed", {
        plugin_id: manifest.id,
        error: message,
      });
      return { success: false, error: message };
    }

    try {
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([
        registerFn(api),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Plugin "${manifest.id}" (${manifest.name}) register() timed out after ${this.registerTimeoutMs}ms`)),
            this.registerTimeoutMs
          );
          timer.unref();
        }),
      ]).finally(() => clearTimeout(timer!));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.journal.tryEmit(manifest.id, "plugin.failed", {
        plugin_id: manifest.id,
        error: message,
      });
      return { success: false, error: message };
    }

    await this.journal.emit(manifest.id, "plugin.loaded", {
      plugin_id: manifest.id,
      name: manifest.name,
      version: manifest.version,
    });

    return { success: true };
  }
}
