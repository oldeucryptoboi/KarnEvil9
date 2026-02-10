import type {
  PluginState,
  RouteHandler,
  CommandOptions,
} from "@karnevil9/schemas";
import { validateToolInput } from "@karnevil9/schemas";
import type { Journal } from "@karnevil9/journal";
import type { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import type { PermissionEngine } from "@karnevil9/permissions";
import { PluginDiscovery, type DiscoveredPlugin } from "./plugin-discovery.js";
import { PluginLoader } from "./plugin-loader.js";
import { PluginApiImpl } from "./plugin-api-impl.js";
import { PluginLoggerImpl } from "./plugin-logger.js";
import { HookRunner } from "./hook-runner.js";

export interface PluginRegistryConfig {
  journal: Journal;
  toolRegistry: ToolRegistry;
  toolRuntime?: ToolRuntime;
  permissions?: PermissionEngine;
  pluginsDir: string;
  registerTimeoutMs?: number;
  pluginConfigs?: Record<string, Record<string, unknown>>;
}

export class PluginRegistry {
  private config: PluginRegistryConfig;
  private plugins = new Map<string, PluginState>();
  private discovery = new PluginDiscovery();
  private loader: PluginLoader;
  private hookRunner: HookRunner;
  private discoveredCache = new Map<string, DiscoveredPlugin>();
  private pluginApis = new Map<string, PluginApiImpl>();
  private allRoutes: Array<{ pluginId: string; method: string; path: string; handler: RouteHandler }> = [];
  private allCommands: Array<{ pluginId: string; name: string; opts: CommandOptions }> = [];

  constructor(config: PluginRegistryConfig) {
    this.config = config;
    this.loader = new PluginLoader(config.journal, {
      registerTimeoutMs: config.registerTimeoutMs,
    });
    this.hookRunner = new HookRunner(config.journal);
  }

  async discoverAndLoadAll(): Promise<PluginState[]> {
    const discovered = await this.discovery.scanDirectory(this.config.pluginsDir);
    const results: PluginState[] = [];

    for (const d of discovered) {
      await this.config.journal.tryEmit(d.manifest.id, "plugin.discovered", {
        plugin_id: d.manifest.id,
        name: d.manifest.name,
        version: d.manifest.version,
        directory: d.directory,
      });

      const state = await this.loadDiscovered(d);
      results.push(state);
    }

    return results;
  }

  async loadPlugin(pluginDir: string, config?: Record<string, unknown>): Promise<PluginState> {
    const discovered = await this.discovery.scanSingle(pluginDir);
    if (!discovered) {
      throw new Error(`No valid plugin found at ${pluginDir}`);
    }
    if (config) {
      const pluginConfigs = this.config.pluginConfigs ?? {};
      pluginConfigs[discovered.manifest.id] = config;
      this.config.pluginConfigs = pluginConfigs;
    }
    return this.loadDiscovered(discovered);
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const state = this.plugins.get(pluginId);
    if (!state) return;

    const api = this.pluginApis.get(pluginId);
    if (api) {
      // Stop services in reverse order
      for (const service of [...api._services].reverse()) {
        try {
          await service.stop();
          await this.config.journal.tryEmit(pluginId, "plugin.service_stopped", {
            plugin_id: pluginId,
            service: service.name,
          });
        } catch (err) {
          await this.config.journal.tryEmit(pluginId, "plugin.service_failed", {
            plugin_id: pluginId,
            service: service.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Unregister hooks
      this.hookRunner.unregisterPlugin(pluginId);

      // Unregister tools
      for (const { manifest } of api._tools) {
        this.config.toolRegistry.unregister(manifest.name);
      }

      // Remove routes
      this.allRoutes = this.allRoutes.filter((r) => r.pluginId !== pluginId);

      // Remove commands
      this.allCommands = this.allCommands.filter((c) => c.pluginId !== pluginId);
    }

    state.status = "unloaded";
    this.pluginApis.delete(pluginId);

    await this.config.journal.tryEmit(pluginId, "plugin.unloaded", {
      plugin_id: pluginId,
    });
  }

  async reloadPlugin(pluginId: string): Promise<PluginState> {
    const cached = this.discoveredCache.get(pluginId);
    if (!cached) {
      throw new Error(`Plugin "${pluginId}" not found for reload`);
    }

    // Re-scan to pick up changes
    const freshDiscovered = await this.discovery.scanSingle(cached.directory);
    if (!freshDiscovered) {
      throw new Error(`Plugin "${pluginId}" manifest is no longer valid`);
    }

    // Load new instance first (atomic swap) — if loading fails, old plugin stays active
    const oldState = this.plugins.get(pluginId);
    const oldApi = this.pluginApis.get(pluginId);
    try {
      // Temporarily remove old registrations to avoid conflicts
      await this.unloadPlugin(pluginId);
      const state = await this.loadDiscovered(freshDiscovered);

      if (state.status === "failed") {
        // Reload failed — try to restore old state
        if (oldState) {
          this.plugins.set(pluginId, oldState);
          if (oldApi) this.pluginApis.set(pluginId, oldApi);
        }
        throw new Error(`Reload failed: ${state.error}`);
      }

      await this.config.journal.tryEmit(pluginId, "plugin.reloaded", {
        plugin_id: pluginId,
        content_hash: freshDiscovered.contentHash,
      });

      return state;
    } catch (err) {
      // If we already unloaded but failed to load, attempt to restore
      if (!this.plugins.has(pluginId) && oldState) {
        oldState.status = "failed";
        oldState.error = `Reload failed: ${err instanceof Error ? err.message : String(err)}`;
        this.plugins.set(pluginId, oldState);
      }
      throw err;
    }
  }

  getHookRunner(): HookRunner {
    return this.hookRunner;
  }

  getPlugin(id: string): PluginState | undefined {
    return this.plugins.get(id);
  }

  listPlugins(): PluginState[] {
    return [...this.plugins.values()];
  }

  getRoutes(): Array<{ pluginId: string; method: string; path: string; handler: RouteHandler }> {
    return this.allRoutes;
  }

  getCommands(): Array<{ pluginId: string; name: string; opts: CommandOptions }> {
    return this.allCommands;
  }

  private async loadDiscovered(discovered: DiscoveredPlugin): Promise<PluginState> {
    const { manifest } = discovered;
    const pluginConfig = this.config.pluginConfigs?.[manifest.id] ?? {};

    // Validate config against config_schema if present
    if (manifest.config_schema) {
      const configValidation = validateToolInput(pluginConfig, manifest.config_schema);
      if (!configValidation.valid) {
        const state: PluginState = {
          id: manifest.id,
          manifest,
          status: "failed",
          failed_at: new Date().toISOString(),
          error: `Config validation failed: ${configValidation.errors.join(", ")}`,
          config: pluginConfig,
        };
        this.plugins.set(manifest.id, state);
        return state;
      }
    }

    const logger = new PluginLoggerImpl(manifest.id);
    const api = new PluginApiImpl(manifest, pluginConfig, logger);

    const state: PluginState = {
      id: manifest.id,
      manifest,
      status: "loading",
      config: pluginConfig,
    };
    this.plugins.set(manifest.id, state);

    const result = await this.loader.load(discovered, api);

    if (!result.success) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.error = result.error;
      return state;
    }

    // Wire tools
    for (const { manifest: toolManifest, handler } of api._tools) {
      this.config.toolRegistry.register(toolManifest);
      if (this.config.toolRuntime) {
        this.config.toolRuntime.registerHandler(toolManifest.name, handler);
      }
    }

    // Wire hooks
    for (const hookReg of api._hooks) {
      this.hookRunner.register(hookReg);
    }

    // Store routes
    for (const route of api._routes) {
      this.allRoutes.push({ pluginId: manifest.id, ...route });
    }

    // Store commands
    for (const cmd of api._commands) {
      this.allCommands.push({ pluginId: manifest.id, ...cmd });
    }

    // Start services
    for (const service of api._services) {
      try {
        await service.start();
        await this.config.journal.tryEmit(manifest.id, "plugin.service_started", {
          plugin_id: manifest.id,
          service: service.name,
        });
      } catch (err) {
        await this.config.journal.tryEmit(manifest.id, "plugin.service_failed", {
          plugin_id: manifest.id,
          service: service.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    state.status = "active";
    state.loaded_at = new Date().toISOString();
    this.discoveredCache.set(manifest.id, discovered);
    this.pluginApis.set(manifest.id, api);

    return state;
  }
}
