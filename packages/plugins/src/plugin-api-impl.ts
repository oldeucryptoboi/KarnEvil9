import type {
  PluginApi,
  PluginManifest,
  PluginLogger,
  ToolManifest,
  ToolHandler,
  HookName,
  HookHandler,
  HookOptions,
  HookRegistration,
  RouteHandler,
  CommandOptions,
  Planner,
  PluginService,
} from "@karnevil9/schemas";

const ALLOWED_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export class PluginApiImpl implements PluginApi {
  readonly id: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly logger: PluginLogger;

  readonly _tools: Array<{ manifest: ToolManifest; handler: ToolHandler }> = [];
  readonly _hooks: HookRegistration[] = [];
  readonly _routes: Array<{ method: string; path: string; handler: RouteHandler }> = [];
  readonly _commands: Array<{ name: string; opts: CommandOptions }> = [];
  readonly _planners: Planner[] = [];
  readonly _services: PluginService[] = [];

  private manifest: PluginManifest;

  constructor(manifest: PluginManifest, config: Record<string, unknown>, logger: PluginLogger) {
    this.id = manifest.id;
    this.manifest = manifest;
    this.config = Object.freeze({ ...config });
    this.logger = logger;
  }

  registerTool(manifest: ToolManifest, handler: ToolHandler): void {
    const declaredTools = this.manifest.provides.tools ?? [];
    if (!declaredTools.includes(manifest.name)) {
      throw new Error(
        `Plugin "${this.id}" tried to register tool "${manifest.name}" not declared in provides.tools`
      );
    }
    this._tools.push({ manifest, handler });
  }

  registerHook(hook: HookName, handler: HookHandler, opts?: HookOptions): void {
    const declaredHooks = this.manifest.provides.hooks ?? [];
    if (!declaredHooks.includes(hook)) {
      throw new Error(
        `Plugin "${this.id}" tried to register hook "${hook}" not declared in provides.hooks`
      );
    }
    this._hooks.push({
      plugin_id: this.id,
      hook,
      handler,
      priority: opts?.priority ?? 100,
      timeout_ms: opts?.timeout_ms ?? 5000,
    });
  }

  registerRoute(method: string, path: string, handler: RouteHandler): void {
    const upperMethod = method.toUpperCase();
    if (!ALLOWED_HTTP_METHODS.has(upperMethod)) {
      throw new Error(
        `Plugin "${this.id}" tried to register route with invalid HTTP method "${method}"`
      );
    }
    const declaredRoutes = this.manifest.provides.routes ?? [];
    const routeName = path.replace(/^\//, "");
    if (!declaredRoutes.includes(routeName) && !declaredRoutes.includes(path)) {
      throw new Error(
        `Plugin "${this.id}" tried to register route "${routeName}" not declared in provides.routes`
      );
    }
    const prefix = `/api/plugins/${this.id}/`;
    if (!path.startsWith(prefix)) {
      path = `${prefix}${path.replace(/^\//, "")}`;
    }
    // Wrap handler with error isolation and timeout
    const pluginId = this.id;
    const wrappedHandler: RouteHandler = async (req, res) => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          handler(req, res),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Route handler timeout")), 30000);
            timer.unref();
          }),
        ]);
      } catch (err) {
        console.error(`[plugin:${pluginId}] Route error:`, err instanceof Error ? err.message : String(err));
        try {
          res.status(500).json({ error: `Plugin "${pluginId}" route handler failed` });
        } catch { /* response may already be sent */ }
      } finally {
        clearTimeout(timer!);
      }
    };
    this._routes.push({ method: upperMethod, path, handler: wrappedHandler });
  }

  registerCommand(name: string, opts: CommandOptions): void {
    const declaredCommands = this.manifest.provides.commands ?? [];
    if (!declaredCommands.includes(name)) {
      throw new Error(
        `Plugin "${this.id}" tried to register command "${name}" not declared in provides.commands`
      );
    }
    this._commands.push({ name, opts });
  }

  registerPlanner(planner: Planner): void {
    const declaredPlanners = this.manifest.provides.planners ?? [];
    if (declaredPlanners.length === 0) {
      throw new Error(
        `Plugin "${this.id}" tried to register a planner but none declared in provides.planners`
      );
    }
    this._planners.push(planner);
  }

  registerService(service: PluginService): void {
    const declaredServices = this.manifest.provides.services ?? [];
    if (declaredServices.length === 0) {
      throw new Error(
        `Plugin "${this.id}" tried to register a service but none declared in provides.services`
      );
    }
    this._services.push(service);
  }
}
