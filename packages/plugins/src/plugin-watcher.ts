import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { Journal } from "@karnevil9/journal";
import type { PluginRegistry } from "./plugin-registry.js";
import { PluginDiscovery } from "./plugin-discovery.js";

export interface PluginWatcherConfig {
  /** The plugin registry to reload plugins through */
  registry: PluginRegistry;
  /** The journal for logging reload events */
  journal: Journal;
  /** Root plugins directory to watch */
  pluginsDir: string;
  /** Debounce delay in milliseconds (default: 500) */
  debounceMs?: number;
}

export interface PluginReloadEvent {
  pluginId: string;
  directory: string;
  timestamp: string;
}

export interface PluginReloadError {
  pluginId: string;
  directory: string;
  error: string;
  timestamp: string;
}

/**
 * PluginWatcher monitors plugin directories for file changes and
 * triggers hot-reload of modified plugins via the PluginRegistry.
 *
 * Uses Node.js built-in `fs.watch` with debouncing to avoid
 * rapid reloads from editors that perform multiple write operations.
 *
 * Emits:
 * - "reload" (PluginReloadEvent) on successful reload
 * - "error"  (PluginReloadError) on failed reload
 */
export class PluginWatcher extends EventEmitter {
  private config: PluginWatcherConfig;
  private debounceMs: number;
  private watchers = new Map<string, ReturnType<typeof watch>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reloading = new Set<string>();
  private discovery = new PluginDiscovery();
  private contentHashes = new Map<string, string>();
  private running = false;

  /** Expose `pluginsDir` for testing */
  get pluginsDir(): string {
    return this.config.pluginsDir;
  }

  constructor(config: PluginWatcherConfig) {
    super();
    this.config = config;
    this.debounceMs = config.debounceMs ?? 500;
  }

  /**
   * Start watching the plugins directory and all plugin subdirectories.
   * Also watches the root pluginsDir for new plugin directories being added.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const pluginsDir = resolve(this.config.pluginsDir);

    // Snapshot initial content hashes for all existing plugins
    await this.snapshotHashes(pluginsDir);

    // Watch the root plugins directory for new/removed subdirectories
    this.watchRootDir(pluginsDir);

    // Watch each existing plugin subdirectory
    let entries;
    try {
      entries = await readdir(pluginsDir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist — nothing to watch
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(pluginsDir, entry.name);
      this.watchPluginDir(pluginDir, entry.name);
    }

    await this.config.journal.tryEmit("system", "plugin.watcher_started", {
      plugins_dir: pluginsDir,
      watched_count: this.watchers.size,
    });
  }

  /** Stop watching all directories and clear timers. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Close all fs.watch handles
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    // Clear all pending debounce timers
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.contentHashes.clear();
    this.reloading.clear();

    await this.config.journal.tryEmit("system", "plugin.watcher_stopped", {
      plugins_dir: this.config.pluginsDir,
    });
  }

  /** Returns the set of currently watched directory keys. */
  getWatchedDirs(): string[] {
    return [...this.watchers.keys()];
  }

  /** Check if the watcher is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Snapshot content hashes for all plugins currently on disk.
   * Used to detect actual content changes vs. no-op fs events.
   */
  private async snapshotHashes(pluginsDir: string): Promise<void> {
    const discovered = await this.discovery.scanDirectory(pluginsDir);
    for (const d of discovered) {
      this.contentHashes.set(d.manifest.id, d.contentHash);
    }
  }

  /** Watch the root plugins directory for additions/removals of plugin subdirs. */
  private watchRootDir(pluginsDir: string): void {
    try {
      const watcher = watch(pluginsDir, (eventType, filename) => {
        if (!this.running || !filename) return;

        // A new subdirectory may have been added or removed
        const subDir = join(pluginsDir, filename);
        this.debouncedHandleRootChange(subDir, filename);
      });

      watcher.on("error", (err) => {
        // Non-fatal: log and continue watching other dirs
        console.warn(`[plugin-watcher] Root dir watch error: ${err.message}`);
      });

      this.watchers.set("__root__", watcher);
    } catch (err) {
      console.warn(
        `[plugin-watcher] Could not watch root dir ${pluginsDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Watch an individual plugin subdirectory for file changes. */
  private watchPluginDir(pluginDir: string, dirName: string): void {
    // Avoid duplicate watchers
    if (this.watchers.has(dirName)) return;

    try {
      const watcher = watch(pluginDir, { recursive: true }, (_eventType, _filename) => {
        if (!this.running) return;
        this.debouncedReload(dirName, pluginDir);
      });

      watcher.on("error", (err) => {
        console.warn(`[plugin-watcher] Watch error for "${dirName}": ${err.message}`);
        // Remove broken watcher
        this.watchers.delete(dirName);
      });

      this.watchers.set(dirName, watcher);
    } catch (err) {
      console.warn(
        `[plugin-watcher] Could not watch ${pluginDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Debounced handler for root directory changes (new plugins added). */
  private debouncedHandleRootChange(subDir: string, dirName: string): void {
    const key = `__root__:${dirName}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.handleRootChange(subDir, dirName);
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  /** Handle potential new plugin directory appearing in root. */
  private async handleRootChange(subDir: string, dirName: string): Promise<void> {
    try {
      const stats = await stat(subDir).catch(() => null);

      if (stats?.isDirectory()) {
        // New directory appeared — start watching if not already
        if (!this.watchers.has(dirName)) {
          this.watchPluginDir(subDir, dirName);

          // Attempt to load it as a new plugin
          const discovered = await this.discovery.scanSingle(subDir);
          if (discovered) {
            try {
              await this.config.registry.loadPlugin(subDir);
              this.contentHashes.set(discovered.manifest.id, discovered.contentHash);

              const event: PluginReloadEvent = {
                pluginId: discovered.manifest.id,
                directory: subDir,
                timestamp: new Date().toISOString(),
              };
              this.emit("reload", event);

              await this.config.journal.tryEmit("system", "plugin.hot_loaded", {
                plugin_id: discovered.manifest.id,
                directory: subDir,
              });
            } catch (err) {
              const errEvent: PluginReloadError = {
                pluginId: discovered.manifest.id,
                directory: subDir,
                error: err instanceof Error ? err.message : String(err),
                timestamp: new Date().toISOString(),
              };
              this.emit("error", errEvent);
            }
          }
        }
      } else {
        // Directory was removed — close the watcher if it exists
        const watcher = this.watchers.get(dirName);
        if (watcher) {
          watcher.close();
          this.watchers.delete(dirName);
        }
      }
    } catch {
      // Non-fatal: ignore transient fs errors
    }
  }

  /** Debounced plugin reload — coalesces rapid changes into a single reload. */
  private debouncedReload(dirName: string, pluginDir: string): void {
    const existing = this.debounceTimers.get(dirName);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(dirName);
      void this.handlePluginChange(dirName, pluginDir);
    }, this.debounceMs);

    this.debounceTimers.set(dirName, timer);
  }

  /** Handle a detected change in a plugin directory. */
  private async handlePluginChange(dirName: string, pluginDir: string): Promise<void> {
    // Prevent concurrent reloads of the same plugin
    if (this.reloading.has(dirName)) return;
    this.reloading.add(dirName);

    try {
      // Re-scan to check if the content actually changed
      const discovered = await this.discovery.scanSingle(pluginDir);
      if (!discovered) {
        // Manifest gone or invalid — skip silently
        return;
      }

      const pluginId = discovered.manifest.id;
      const oldHash = this.contentHashes.get(pluginId);

      // Only reload if the content hash actually changed
      if (oldHash === discovered.contentHash) {
        return;
      }

      await this.config.journal.tryEmit("system", "plugin.hot_reloading", {
        plugin_id: pluginId,
        directory: pluginDir,
        old_hash: oldHash ?? "none",
        new_hash: discovered.contentHash,
      });

      // Check if the plugin is already loaded in the registry
      const existingPlugin = this.config.registry.getPlugin(pluginId);

      if (existingPlugin) {
        // Reload existing plugin (unload + re-load with cache busting)
        await this.config.registry.reloadPlugin(pluginId);
      } else {
        // New plugin that wasn't loaded before
        await this.config.registry.loadPlugin(pluginDir);
      }

      // Update content hash
      this.contentHashes.set(pluginId, discovered.contentHash);

      const event: PluginReloadEvent = {
        pluginId,
        directory: pluginDir,
        timestamp: new Date().toISOString(),
      };
      this.emit("reload", event);

      await this.config.journal.tryEmit("system", "plugin.hot_reloaded", {
        plugin_id: pluginId,
        directory: pluginDir,
        content_hash: discovered.contentHash,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Determine plugin ID from the directory name or scanned manifest
      let pluginId = dirName;
      try {
        const d = await this.discovery.scanSingle(pluginDir);
        if (d) pluginId = d.manifest.id;
      } catch { /* use dirName as fallback */ }

      const errEvent: PluginReloadError = {
        pluginId,
        directory: pluginDir,
        error: errMsg,
        timestamp: new Date().toISOString(),
      };
      this.emit("error", errEvent);

      await this.config.journal.tryEmit("system", "plugin.hot_reload_failed", {
        plugin_id: pluginId,
        directory: pluginDir,
        error: errMsg,
      });
    } finally {
      this.reloading.delete(dirName);
    }
  }
}
