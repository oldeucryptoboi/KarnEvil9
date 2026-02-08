#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { v4 as uuid } from "uuid";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { Journal } from "@jarvis/journal";
import { ToolRegistry, ToolRuntime, readFileHandler, writeFileHandler, shellExecHandler, httpRequestHandler, browserHandler } from "@jarvis/tools";
import { PermissionEngine } from "@jarvis/permissions";
import { Kernel } from "@jarvis/kernel";
import { createPlanner } from "./llm-adapters.js";
import { ApiServer } from "@jarvis/api";
import { MetricsCollector } from "@jarvis/metrics";
import { PluginRegistry } from "@jarvis/plugins";
import { ActiveMemory } from "@jarvis/memory";
import type { Task, ApprovalDecision, PermissionRequest } from "@jarvis/schemas";

const JOURNAL_PATH = process.env.JARVIS_JOURNAL_PATH ?? resolve("journal/events.jsonl");
const TOOLS_DIR = process.env.JARVIS_TOOLS_DIR ?? resolve("tools/examples");
const MEMORY_PATH = process.env.JARVIS_MEMORY_PATH ?? resolve("sessions/memory.jsonl");
const DEFAULT_PORT = parseInt(process.env.JARVIS_PORT ?? "3100", 10);

async function cliApprovalPrompt(request: PermissionRequest): Promise<ApprovalDecision> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const scopes = request.permissions.map((p) => p.scope).join(", ");
  console.log(`\n--- Permission Request ---`);
  console.log(`Tool: ${request.tool_name}`);
  console.log(`Step: ${request.step_id}`);
  console.log(`Scopes: ${scopes}`);
  console.log(`Options: [a]llow once, [s]ession, [g]lobal, [d]eny, [c]onstrained, [o]bserved`);
  return new Promise<ApprovalDecision>((resolve) => {
    rl.question("Decision: ", (answer) => {
      rl.close();
      switch (answer.trim().toLowerCase()) {
        case "a": resolve("allow_once"); break;
        case "s": resolve("allow_session"); break;
        case "g": resolve("allow_always"); break;
        case "c": resolve({
          type: "allow_constrained",
          scope: "session",
          constraints: { readonly_paths: [process.cwd()] },
        }); break;
        case "o": resolve({
          type: "allow_observed",
          scope: "session",
          telemetry_level: "detailed",
        }); break;
        default: resolve("deny"); break;
      }
    });
  });
}

async function createRuntime(policy?: { allowed_paths: string[]; allowed_endpoints: string[]; allowed_commands: string[]; require_approval_for_writes: boolean }) {
  const journal = new Journal(JOURNAL_PATH);
  await journal.init();
  const registry = new ToolRegistry();
  await registry.loadFromDirectory(TOOLS_DIR);
  const permissions = new PermissionEngine(journal, cliApprovalPrompt);
  const defaultPolicy = policy ?? { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };
  const runtime = new ToolRuntime(registry, permissions, journal, defaultPolicy);
  runtime.registerHandler("read-file", readFileHandler);
  runtime.registerHandler("write-file", writeFileHandler);
  runtime.registerHandler("shell-exec", shellExecHandler);
  runtime.registerHandler("http-request", httpRequestHandler);
  runtime.registerHandler("browser", browserHandler);
  return { journal, registry, permissions, runtime };
}

const program = new Command();
program.name("jarvis").description("Jarvis — Deterministic agent runtime").version("0.1.0");

program.command("run").description("Run a task end-to-end").argument("<task>", "Task description")
  .option("-m, --mode <mode>", "Execution mode: real, dry_run, mock", "mock")
  .option("--max-steps <n>", "Maximum steps", "20")
  .option("--plugins-dir <dir>", "Plugins directory", "plugins")
  .option("--planner <type>", "Planner: mock, claude, openai, router")
  .option("--model <name>", "Model name")
  .option("--agentic", "Enable agentic feedback loop")
  .option("--context-budget", "Enable proactive context budget management (requires --agentic)")
  .option("--checkpoint-dir <dir>", "Directory for checkpoint files", "sessions/checkpoints")
  .option("--no-memory", "Disable cross-session active memory")
  .action(async (taskText: string, opts: { mode: string; maxSteps: string; pluginsDir: string; planner?: string; model?: string; agentic?: boolean; contextBudget?: boolean; checkpointDir?: string; memory?: boolean }) => {
    const policy = { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };
    const { journal, registry, permissions, runtime } = await createRuntime(policy);
    const task: Task = { task_id: uuid(), text: taskText, created_at: new Date().toISOString() };

    const pluginsDir = resolve(opts.pluginsDir);
    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
    });
    const pluginStates = await pluginRegistry.discoverAndLoadAll();
    const activePlugins = pluginStates.filter((p) => p.status === "active");

    let activeMemory: ActiveMemory | undefined;
    if (opts.memory !== false) {
      activeMemory = new ActiveMemory(MEMORY_PATH);
      await activeMemory.load();
    }

    const kernel = new Kernel({
      journal, toolRuntime: runtime, toolRegistry: registry, permissions,
      pluginRegistry,
      planner: createPlanner({ planner: opts.planner, model: opts.model, agentic: opts.agentic }),
      mode: opts.mode as "real" | "dry_run" | "mock",
      limits: { max_steps: parseInt(opts.maxSteps, 10), max_duration_ms: 300000, max_cost_usd: 10, max_tokens: 100000, max_iterations: 10 },
      policy,
      agentic: opts.agentic ?? false,
      activeMemory,
      ...(opts.contextBudget && opts.agentic ? { contextBudgetConfig: {} } : {}),
      ...(opts.checkpointDir ? { checkpointDir: opts.checkpointDir } : {}),
    });
    journal.on((event) => {
      const ts = event.timestamp.split("T")[1]?.slice(0, 8) ?? "";
      console.log(`[${ts}] ${event.type}`);
      if (event.type === "step.succeeded" && event.payload.output != null) {
        const out = event.payload.output as Record<string, unknown>;
        console.log(`\n--- Output (${event.payload.step_id}) ---`);
        if (typeof out === "string") {
          console.log(out);
        } else if (typeof out === "object" && out !== null && "content" in out) {
          console.log(String(out.content));
        } else {
          console.log(JSON.stringify(out, null, 2));
        }
        console.log(`--- End ---\n`);
      }
      if (event.type === "step.failed" && event.payload.error != null) {
        const err = event.payload.error as { code: string; message: string };
        console.log(`  Error [${err.code}]: ${err.message}`);
      }
      if (event.type === "context.budget_assessed") {
        const fraction = ((event.payload.fraction as number) * 100).toFixed(0);
        console.log(`  Budget: ${fraction}% used → ${event.payload.verdict}`);
      }
      if (event.type === "context.delegation_started") {
        console.log(`  Delegating: ${event.payload.reason}`);
      }
      if (event.type === "context.delegation_completed") {
        console.log(`  Delegation ${event.payload.status}: ${event.payload.findings_count ?? 0} findings, ${event.payload.tokens_used ?? 0} tokens`);
      }
      if (event.type === "context.checkpoint_triggered" || event.type === "context.summarize_triggered") {
        console.log(`  ${event.type}: ${event.payload.reason}`);
      }
      if (event.type === "context.checkpoint_saved") {
        console.log(`  Checkpoint saved: ${event.payload.checkpoint_path}`);
      }
    });
    console.log(`\nJarvis session starting...`);
    console.log(`Task: ${taskText}`);
    console.log(`Mode: ${opts.mode}`);
    console.log(`Tools: ${registry.list().map((t) => t.name).join(", ") || "(none)"}`);
    console.log(`Plugins: ${activePlugins.map((p) => p.id).join(", ") || "(none)"}\n`);
    await kernel.createSession(task);
    const session = await kernel.run();
    console.log(`\nSession ${session.session_id}`);
    console.log(`Status: ${session.status}`);
    const state = kernel.getTaskState();
    if (state) {
      const snapshot = state.getSnapshot();
      console.log(`Steps completed: ${snapshot.completed_steps}/${snapshot.total_steps}`);
    }
    const usage = kernel.getUsageSummary();
    if (usage && usage.total_tokens > 0) {
      console.log(`Tokens: ${usage.total_tokens.toLocaleString()} (${usage.total_input_tokens.toLocaleString()} in / ${usage.total_output_tokens.toLocaleString()} out)`);
      if (usage.total_cost_usd > 0) {
        console.log(`Estimated cost: $${usage.total_cost_usd.toFixed(4)}`);
      }
    }
  });

program.command("plan").description("Generate a plan without executing").argument("<task>", "Task description")
  .option("--planner <type>", "Planner: mock, claude, openai, router")
  .option("--model <name>", "Model name")
  .action(async (taskText: string, opts: { planner?: string; model?: string }) => {
    const { registry } = await createRuntime();
    const task: Task = { task_id: uuid(), text: taskText, created_at: new Date().toISOString() };
    const planner = createPlanner({ planner: opts.planner, model: opts.model });
    const { plan, usage } = await planner.generatePlan(task, registry.getSchemasForPlanner(), {}, {});
    console.log(JSON.stringify(plan, null, 2));
    if (usage && usage.total_tokens > 0) {
      console.log(`\nTokens: ${usage.total_tokens.toLocaleString()} (${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out)`);
      if (usage.cost_usd !== undefined && usage.cost_usd > 0) {
        console.log(`Estimated cost: $${usage.cost_usd.toFixed(4)}`);
      }
    }
  });

const toolsCmd = program.command("tools").description("Tool management");
toolsCmd.command("list").description("List registered tools").action(async () => {
  const { registry } = await createRuntime();
  const tools = registry.list();
  if (tools.length === 0) { console.log("No tools registered."); return; }
  for (const tool of tools) {
    console.log(`${tool.name} v${tool.version} [${tool.runner}]`);
    console.log(`  ${tool.description}`);
    console.log(`  Permissions: ${tool.permissions.join(", ") || "(none)"}\n`);
  }
});

const sessionCmd = program.command("session").description("Session management");
sessionCmd.command("ls").description("List sessions from journal").action(async () => {
  const journal = new Journal(JOURNAL_PATH);
  await journal.init();
  const events = await journal.readAll();
  const sessions = new Map<string, { status: string; created: string; events: number }>();
  for (const event of events) {
    const existing = sessions.get(event.session_id);
    if (!existing) {
      sessions.set(event.session_id, { status: event.type.replace("session.", ""), created: event.timestamp, events: 1 });
    } else {
      existing.events++;
      if (event.type.startsWith("session.")) existing.status = event.type.replace("session.", "");
    }
  }
  if (sessions.size === 0) { console.log("No sessions found."); return; }
  for (const [id, info] of sessions) console.log(`${id}  [${info.status}]  ${info.events} events  ${info.created}`);
});

sessionCmd.command("watch").description("Watch a session's events").argument("<id>", "Session ID")
  .action(async (sessionId: string) => {
    const journal = new Journal(JOURNAL_PATH);
    await journal.init();
    const events = await journal.readSession(sessionId);
    if (events.length === 0) { console.log(`No events found for session ${sessionId}`); return; }
    for (const event of events) {
      const ts = event.timestamp.split("T")[1]?.slice(0, 12) ?? "";
      console.log(`[${ts}] ${event.type}`);
      if (Object.keys(event.payload).length > 0) console.log(`         ${JSON.stringify(event.payload)}`);
    }
  });

program.command("replay").description("Replay a session").argument("<id>", "Session ID")
  .option("--mode <mode>", "Replay mode: audit, mock", "audit")
  .action(async (sessionId: string, opts: { mode: string }) => {
    const journal = new Journal(JOURNAL_PATH);
    await journal.init();
    const events = await journal.readSession(sessionId);
    if (events.length === 0) { console.log(`No events found for session ${sessionId}`); return; }
    console.log(`Replaying session ${sessionId} (${opts.mode} mode)\n${events.length} events\n`);
    for (const event of events) {
      const ts = event.timestamp.split("T")[1]?.slice(0, 12) ?? "";
      console.log(`[${ts}] ${event.type}`);
      if (opts.mode === "audit" && Object.keys(event.payload).length > 0) {
        for (const line of JSON.stringify(event.payload, null, 2).split("\n")) console.log(`         ${line}`);
      }
    }
    const integrity = await journal.verifyIntegrity();
    console.log(`\nJournal integrity: ${integrity.valid ? "OK" : `BROKEN at event ${integrity.brokenAt}`}`);
  });

program.command("server").description("Start the API server")
  .option("-p, --port <port>", "Port number", String(DEFAULT_PORT))
  .option("--plugins-dir <dir>", "Plugins directory", "plugins")
  .option("--planner <type>", "Planner: mock, claude, openai, router")
  .option("--model <name>", "Model name")
  .option("--agentic", "Enable agentic feedback loop")
  .option("--insecure", "Allow running without an API token (unauthenticated)")
  .option("--no-memory", "Disable cross-session active memory")
  .action(async (opts: { port: string; pluginsDir: string; planner?: string; model?: string; agentic?: boolean; insecure?: boolean; memory?: boolean }) => {
    const { journal, registry, permissions, runtime } = await createRuntime();
    const pluginsDir = resolve(opts.pluginsDir);
    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
    });
    await pluginRegistry.discoverAndLoadAll();
    const active = pluginRegistry.listPlugins().filter((p) => p.status === "active");
    if (active.length > 0) {
      console.log(`Plugins loaded: ${active.map((p) => p.id).join(", ")}`);
    }
    const metricsCollector = new MetricsCollector();
    const apiToken = process.env.JARVIS_API_TOKEN;
    const corsOrigins = process.env.JARVIS_CORS_ORIGINS;
    const apiServer = new ApiServer({
      toolRegistry: registry, journal, toolRuntime: runtime, permissions,
      pluginRegistry,
      planner: createPlanner({ planner: opts.planner, model: opts.model, agentic: opts.agentic }),
      agentic: opts.agentic ?? false,
      metricsCollector,
      apiToken,
      insecure: opts.insecure === true,
      corsOrigins: corsOrigins ? corsOrigins.split(",").map((s) => s.trim()) : undefined,
      approvalTimeoutMs: parseInt(process.env.JARVIS_APPROVAL_TIMEOUT_MS ?? "300000", 10),
      maxConcurrentSessions: parseInt(process.env.JARVIS_MAX_SESSIONS ?? "50", 10),
    });
    apiServer.listen(parseInt(opts.port, 10));

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\nShutting down...");
      await apiServer.shutdown();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });

// ─── Relay Command ────────────────────────────────────────────────

program.command("relay").description("Start the browser relay server")
  .option("-p, --port <port>", "Port number", "9222")
  .option("--driver <type>", "Driver: managed or extension", "managed")
  .option("--no-headless", "Run browser with visible window (managed only)")
  .option("--bridge-port <port>", "Bridge WebSocket port for extension driver", "9225")
  .action(async (opts: { port: string; driver: string; headless: boolean; bridgePort: string }) => {
    const { ManagedDriver, ExtensionDriver, RelayServer } = await import("@jarvis/browser-relay");
    const driverType = opts.driver;

    let browserDriver;
    if (driverType === "extension") {
      const driver = new ExtensionDriver({ bridgePort: parseInt(opts.bridgePort, 10) });
      await driver.startBridge();
      browserDriver = driver;
      console.log(`Using extension driver (bridge WS on port ${opts.bridgePort})`);
    } else {
      browserDriver = new ManagedDriver({ headless: opts.headless });
      console.log(`Using managed driver (Playwright, headless=${opts.headless})`);
    }

    const server = new RelayServer({ port: parseInt(opts.port, 10), driver: browserDriver, driverName: driverType });
    await server.listen();
  });

// ─── Plugin Commands ───────────────────────────────────────────────

const pluginsCmd = program.command("plugins").description("Plugin management");

pluginsCmd.command("list").description("List loaded plugins")
  .option("--plugins-dir <dir>", "Plugins directory", "plugins")
  .action(async (opts: { pluginsDir: string }) => {
    const { journal, registry, permissions, runtime } = await createRuntime();
    const pluginsDir = resolve(opts.pluginsDir);
    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
    });
    await pluginRegistry.discoverAndLoadAll();
    const plugins = pluginRegistry.listPlugins();
    if (plugins.length === 0) { console.log("No plugins found."); return; }
    for (const p of plugins) {
      console.log(`${p.id} v${p.manifest.version} [${p.status}]`);
      console.log(`  ${p.manifest.description}`);
      const provides = Object.entries(p.manifest.provides)
        .filter(([, v]) => v && (v as unknown[]).length > 0)
        .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
        .join("; ");
      if (provides) console.log(`  Provides: ${provides}`);
      console.log();
    }
  });

pluginsCmd.command("info").description("Show plugin details").argument("<id>", "Plugin ID")
  .option("--plugins-dir <dir>", "Plugins directory", "plugins")
  .action(async (pluginId: string, opts: { pluginsDir: string }) => {
    const { journal, registry, permissions, runtime } = await createRuntime();
    const pluginsDir = resolve(opts.pluginsDir);
    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
    });
    await pluginRegistry.discoverAndLoadAll();
    const plugin = pluginRegistry.getPlugin(pluginId);
    if (!plugin) { console.log(`Plugin "${pluginId}" not found.`); return; }
    console.log(JSON.stringify(plugin, null, 2));
  });

pluginsCmd.command("reload").description("Reload a plugin").argument("<id>", "Plugin ID")
  .option("--plugins-dir <dir>", "Plugins directory", "plugins")
  .action(async (pluginId: string, opts: { pluginsDir: string }) => {
    const { journal, registry, permissions, runtime } = await createRuntime();
    const pluginsDir = resolve(opts.pluginsDir);
    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
    });
    await pluginRegistry.discoverAndLoadAll();
    const state = await pluginRegistry.reloadPlugin(pluginId);
    console.log(`Plugin "${pluginId}" reloaded: ${state.status}`);
  });

program.parse();
