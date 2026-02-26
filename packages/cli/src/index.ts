#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { v4 as uuid } from "uuid";
import { resolve } from "node:path";
import { hostname } from "node:os";
import * as readline from "node:readline";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime, readFileHandler, writeFileHandler, shellExecHandler, httpRequestHandler, createBrowserHandler } from "@karnevil9/tools";
import type { BrowserDriverLike } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import { createPlanner } from "./llm-adapters.js";
import { ApiServer } from "@karnevil9/api";
import { MetricsCollector } from "@karnevil9/metrics";
import { PluginRegistry } from "@karnevil9/plugins";
import { ActiveMemory } from "@karnevil9/memory";
import { ScheduleStore, Scheduler } from "@karnevil9/scheduler";
import { MeshManager, WorkDistributor, DEFAULT_SWARM_CONFIG } from "@karnevil9/swarm";
import type { SwarmConfig } from "@karnevil9/swarm";
import type { Task, ApprovalDecision, PermissionRequest, Planner } from "@karnevil9/schemas";
import type { ChatWebSocket } from "./chat-client.js";

function parsePort(value: string, label = "port"): number {
  const port = parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: "${value}" (must be 1–65535)`);
  }
  return port;
}

function parsePositiveInt(value: string, label: string, fallback?: number): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Invalid ${label}: "${value}" (must be a positive integer)`);
  }
  return n;
}

// Global error handlers — prevent silent crashes from unhandled rejections/exceptions
process.on("unhandledRejection", (reason) => {
  console.error("[karnevil9] Unhandled rejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[karnevil9] Uncaught exception:", err);
  process.exit(1);
});

const JOURNAL_PATH = process.env.KARNEVIL9_JOURNAL_PATH ?? resolve("journal/events.jsonl");
const TOOLS_DIR = process.env.KARNEVIL9_TOOLS_DIR ?? resolve("tools/examples");
const MEMORY_PATH = process.env.KARNEVIL9_MEMORY_PATH ?? resolve("sessions/memory.jsonl");
const SCHEDULER_PATH = process.env.KARNEVIL9_SCHEDULER_PATH ?? resolve("sessions/schedules.jsonl");
const DEFAULT_PORT = parseInt(process.env.KARNEVIL9_PORT ?? "3100", 10);

async function cliApprovalPrompt(request: PermissionRequest): Promise<ApprovalDecision> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const scopes = request.permissions.map((p) => p.scope).join(", ");
  console.log(`\n--- Permission Request ---`);
  console.log(`Tool: ${request.tool_name}`);
  console.log(`Step: ${request.step_id}`);
  console.log(`Scopes: ${scopes}`);
  console.log(`Options: [a]llow once, [s]ession, [g]lobal, [d]eny, [c]onstrained, [o]bserved`);
  return new Promise<ApprovalDecision>((resolve, reject) => {
    let answered = false;
    rl.question("Decision: ", (answer) => {
      answered = true;
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
      rl.close();
    });
    rl.on("error", (err) => { rl.close(); reject(err); });
    rl.on("close", () => { if (!answered) resolve("deny"); });
  });
}

async function createRuntime(
  policy?: { allowed_paths: string[]; allowed_endpoints: string[]; allowed_commands: string[]; require_approval_for_writes: boolean },
  approvalPrompt?: (request: PermissionRequest) => Promise<ApprovalDecision>,
  browserDriver?: BrowserDriverLike,
) {
  const journal = new Journal(JOURNAL_PATH);
  await journal.init();
  const registry = new ToolRegistry();
  await registry.loadFromDirectory(TOOLS_DIR);
  const permissions = new PermissionEngine(journal, approvalPrompt ?? cliApprovalPrompt);
  const defaultPolicy = policy ?? { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };
  const runtime = new ToolRuntime(registry, permissions, journal, defaultPolicy);
  runtime.registerHandler("read-file", readFileHandler);
  runtime.registerHandler("write-file", writeFileHandler);
  runtime.registerHandler("shell-exec", shellExecHandler);
  runtime.registerHandler("http-request", httpRequestHandler);
  runtime.registerHandler("browser", createBrowserHandler(browserDriver));
  return { journal, registry, permissions, runtime };
}

const program = new Command();
program.name("karnevil9").description("KarnEvil9 — Deterministic agent runtime").version("0.1.0");

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
  .option("--browser <mode>", "Browser driver: managed, stealth, or extension", "managed")
  .option("--auto-approve", "Auto-approve all permission requests for the session")
  .action(async (taskText: string, opts: { mode: string; maxSteps: string; pluginsDir: string; planner?: string; model?: string; agentic?: boolean; contextBudget?: boolean; checkpointDir?: string; memory?: boolean; browser: string; autoApprove?: boolean }) => {
    const policy = { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };
    let browserDriver: BrowserDriverLike | undefined;
    if (opts.browser === "managed") {
      const { ManagedDriver } = await import("@karnevil9/browser-relay");
      browserDriver = new ManagedDriver({ headless: true });
    } else if (opts.browser === "stealth") {
      const { ManagedDriver } = await import("@karnevil9/browser-relay");
      browserDriver = new ManagedDriver({ headless: false, channel: "chrome", userDataDir: resolve("sessions/browser-profile") });
    }
    const approvalFn = opts.autoApprove
      ? async (_request: PermissionRequest): Promise<ApprovalDecision> => "allow_session"
      : undefined;
    // Validate planner early — fails fast before plugin loading and network auth
    const planner = createPlanner({ planner: opts.planner, model: opts.model, agentic: opts.agentic });

    const { journal, registry, permissions, runtime } = await createRuntime(policy, approvalFn, browserDriver);
    const removeShutdownHandler = journal.registerShutdownHandler();
    const task: Task = { task_id: uuid(), text: taskText, created_at: new Date().toISOString() };

    const pluginsDir = resolve(opts.pluginsDir);
    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
      pluginConfigs: {
        "claude-code": { journal, apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.KARNEVIL9_CLAUDE_CODE_MODEL },
        "openai-codex": { journal, apiKey: process.env.OPENAI_API_KEY, model: process.env.KARNEVIL9_CODEX_MODEL },
        "grok-search": { journal, apiKey: process.env.XAI_API_KEY ?? process.env.XAI_KEY, model: process.env.KARNEVIL9_GROK_MODEL },
        "github-repo": {},
      },
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
      planner,
      mode: opts.mode as "real" | "dry_run" | "mock",
      limits: { max_steps: parsePositiveInt(opts.maxSteps, "max-steps", 20), max_duration_ms: 300000, max_cost_usd: 10, max_tokens: 100000, max_iterations: 10 },
      plannerTimeoutMs: 90000,
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
      if (event.type === "agent.started") console.log(`  Agent ${event.payload.agent_type} started`);
      if (event.type === "agent.completed") console.log(`  Agent ${event.payload.agent_type} completed (${event.payload.duration_ms}ms)`);
      if (event.type === "agent.failed") console.log(`  Agent ${event.payload.agent_type} failed: ${event.payload.error}`);
      if (event.type === "agent.aborted") console.log(`  Agent ${event.payload.agent_type} aborted`);
    });
    console.log(`\nKarnEvil9 session starting...`);
    console.log(`Task: ${taskText}`);
    console.log(`Mode: ${opts.mode}`);
    console.log(`Tools: ${registry.list().map((t) => t.name).join(", ") || "(none)"}`);
    console.log(`Plugins: ${activePlugins.map((p) => p.id).join(", ") || "(none)"}\n`);
    try {
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
    } finally {
      removeShutdownHandler();
      if (browserDriver && "close" in browserDriver) {
        await (browserDriver as { close(): Promise<void> }).close();
      }
      await journal.close();
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
      console.error(`\nTokens: ${usage.total_tokens.toLocaleString()} (${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out)`);
      if (usage.cost_usd !== undefined && usage.cost_usd > 0) {
        console.error(`Estimated cost: $${usage.cost_usd.toFixed(4)}`);
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
  .option("--browser <mode>", "Browser driver: managed, stealth, or extension", "managed")
  .option("--swarm", "Enable swarm mesh for P2P task distribution")
  .option("--swarm-token <token>", "Shared secret for swarm peer auth")
  .option("--swarm-seeds <urls>", "Comma-separated seed URLs for peer discovery")
  .option("--swarm-name <name>", "Display name for this swarm node")
  .option("--swarm-mdns", "Enable mDNS discovery (default: true)")
  .option("--swarm-gossip", "Enable gossip protocol (default: true)")
  .option("--auto-approve", "Auto-approve all permission requests for the session")
  .action(async (opts: { port: string; pluginsDir: string; planner?: string; model?: string; agentic?: boolean; insecure?: boolean; memory?: boolean; browser: string; swarm?: boolean; swarmToken?: string; swarmSeeds?: string; swarmName?: string; swarmMdns?: boolean; swarmGossip?: boolean; autoApprove?: boolean }) => {
    // Late-binding ref: set after ApiServer is constructed
    let apiServerRef: ApiServer | null = null;
    const serverApprovalPrompt = opts.autoApprove
      ? async (_request: PermissionRequest): Promise<ApprovalDecision> => "allow_session"
      : async (request: PermissionRequest): Promise<ApprovalDecision> => {
          if (!apiServerRef) return "deny";
          return new Promise<ApprovalDecision>((resolve) => {
            apiServerRef!.registerApproval(request.request_id, request, resolve);
          });
        };
    let browserDriver: BrowserDriverLike | undefined;
    if (opts.browser === "managed") {
      const { ManagedDriver } = await import("@karnevil9/browser-relay");
      browserDriver = new ManagedDriver({ headless: true });
    } else if (opts.browser === "stealth") {
      const { ManagedDriver } = await import("@karnevil9/browser-relay");
      browserDriver = new ManagedDriver({ headless: false, channel: "chrome", userDataDir: resolve("sessions/browser-profile") });
    }
    const { journal, registry, permissions, runtime } = await createRuntime(undefined, serverApprovalPrompt, browserDriver);
    const metricsCollector = new MetricsCollector();

    let activeMemory: ActiveMemory | undefined;
    if (opts.memory !== false) {
      activeMemory = new ActiveMemory(MEMORY_PATH);
      await activeMemory.load();
    }

    // Bootstrap scheduler before plugins so the scheduler-tool plugin can access it
    const planner = createPlanner({ planner: opts.planner, model: opts.model, agentic: opts.agentic });
    const scheduleStore = new ScheduleStore(SCHEDULER_PATH);
    const pluginsDir = resolve(opts.pluginsDir);
    const port = parsePort(opts.port);
    // pluginRegistry reference needed by sessionFactory — assigned after construction
    let pluginRegistry!: PluginRegistry;

    // Per-session planner cache keyed by "provider:model" to reuse across sessions
    const plannerCache = new Map<string, Planner>();
    const mlxBaseURL = process.env.KARNEVIL9_MLX_BASE_URL ?? "http://localhost:8080/v1";

    // Shared session factory used by scheduler and slack plugins
    const sharedSessionFactory = async (task: Task, sessionOpts?: { mode?: string; agentic?: boolean; planner?: string; model?: string }) => {
      let sessionPlanner = planner;
      if (sessionOpts?.planner || sessionOpts?.model) {
        const provider = sessionOpts.planner ?? opts.planner ?? "mock";
        const model = sessionOpts.model ?? opts.model;
        const cacheKey = `${provider}:${model ?? "default"}`;
        let cached = plannerCache.get(cacheKey);
        if (!cached) {
          cached = createPlanner({
            planner: provider,
            model,
            agentic: sessionOpts?.agentic ?? opts.agentic,
            baseURL: provider === "openai" ? mlxBaseURL : undefined,
          });
          plannerCache.set(cacheKey, cached);
        }
        sessionPlanner = cached;
      }

      const kernel = new Kernel({
        journal, toolRuntime: runtime, toolRegistry: registry, permissions,
        pluginRegistry,
        planner: sessionPlanner,
        mode: (sessionOpts?.mode ?? (opts.agentic ? "real" : "mock")) as "real" | "dry_run" | "mock",
        limits: { max_steps: 20, max_duration_ms: 300000, max_cost_usd: 10, max_tokens: 200000 },
        policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true },
        agentic: sessionOpts?.agentic ?? opts.agentic ?? false,
        activeMemory,
        preGrantedScopes: [
          ...pluginRegistry.getPluginPermissions(),
          // Pre-grant built-in tool scopes for automated sessions (scheduled tasks)
          "filesystem:read:workspace",
          "filesystem:write:workspace",
          "shell:exec:workspace",
          "http:request:external",
          "github:read:repos",
          "github:write:issues",
        ],
        plannerTimeoutMs: Number(process.env.KARNEVIL9_PLANNER_TIMEOUT_MS) || 180_000,
      });
      const session = await kernel.createSession(task);
      // Run in background — don't block the caller
      void kernel.run().catch((err) => {
        console.error(`[session] Session ${session.session_id} failed:`, err);
      });
      return { session_id: session.session_id, status: session.status };
    };

    const scheduler = new Scheduler({
      store: scheduleStore,
      journal,
      sessionFactory: sharedSessionFactory,
    });
    await scheduler.start();
    console.log(`Scheduler started (${scheduleStore.size} schedules loaded)`);

    const apiToken = process.env.KARNEVIL9_API_TOKEN;

    // Bootstrap swarm if enabled
    const swarmEnabled = opts.swarm || process.env.KARNEVIL9_SWARM_ENABLED === "true";
    let meshManager: MeshManager | undefined;
    let workDistributor: WorkDistributor | undefined;
    if (swarmEnabled) {
      const swarmConfig: SwarmConfig = {
        ...DEFAULT_SWARM_CONFIG,
        enabled: true,
        token: opts.swarmToken ?? process.env.KARNEVIL9_SWARM_TOKEN,
        node_name: opts.swarmName ?? process.env.KARNEVIL9_SWARM_NODE_NAME ?? hostname(),
        api_url: `http://localhost:${port}`,
        seeds: (opts.swarmSeeds ?? process.env.KARNEVIL9_SWARM_SEEDS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean).filter((s: string) => {
          try { new URL(s); return true; } catch { console.warn(`[swarm] Ignoring invalid seed URL: ${s}`); return false; }
        }),
        mdns: opts.swarmMdns ?? (process.env.KARNEVIL9_SWARM_MDNS !== "false"),
        gossip: opts.swarmGossip ?? (process.env.KARNEVIL9_SWARM_GOSSIP !== "false"),
        max_peers: parsePositiveInt(process.env.KARNEVIL9_SWARM_MAX_PEERS ?? "50", "KARNEVIL9_SWARM_MAX_PEERS", 50),
        capabilities: registry.list().map((t) => t.name),
      };
      meshManager = new MeshManager({
        config: swarmConfig,
        journal,
        onTaskRequest: async (request) => {
          // Accept and run delegated tasks
          const task: Task = { task_id: request.task_id, text: request.task_text, created_at: new Date().toISOString() };
          try {
            await sharedSessionFactory(task);
            return { accepted: true };
          } catch (err) {
            return { accepted: false, reason: err instanceof Error ? err.message : "Internal error" };
          }
        },
      });
      workDistributor = new WorkDistributor({
        meshManager,
        strategy: "round_robin",
        delegation_timeout_ms: swarmConfig.delegation_timeout_ms,
        max_retries: 2,
      });
      // Wire result handling: when mesh receives results, resolve distributor delegations
      meshManager = new MeshManager({
        config: swarmConfig,
        journal,
        onTaskRequest: async (request) => {
          const task: Task = { task_id: request.task_id, text: request.task_text, created_at: new Date().toISOString() };
          try {
            await sharedSessionFactory(task);
            return { accepted: true };
          } catch (err) {
            return { accepted: false, reason: err instanceof Error ? err.message : "Internal error" };
          }
        },
        onTaskResult: (result) => {
          workDistributor!.resolveTask(result);
        },
      });
      // Recreate distributor with the final meshManager
      workDistributor = new WorkDistributor({
        meshManager,
        strategy: "round_robin",
        delegation_timeout_ms: swarmConfig.delegation_timeout_ms,
        max_retries: 2,
      });
    }

    pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
      pluginConfigs: {
        "scheduler-tool": { scheduler },
        "moltbook": { scheduler, autoSchedule: true },
        "slack": {
          sessionFactory: sharedSessionFactory,
          journal,
          apiBaseUrl: `http://localhost:${port}`,
          apiToken,
        },
        "signal": {
          sessionFactory: sharedSessionFactory,
          journal,
          apiBaseUrl: `http://localhost:${port}`,
          apiToken,
        },
        "gmail": {
          sessionFactory: sharedSessionFactory,
          journal,
          apiBaseUrl: `http://localhost:${port}`,
          apiToken,
        },
        "whatsapp": {
          sessionFactory: sharedSessionFactory,
          journal,
          apiBaseUrl: `http://localhost:${port}`,
          apiToken,
        },
        "twitter": {
          sessionFactory: sharedSessionFactory,
          journal,
          apiBaseUrl: `http://localhost:${port}`,
          apiToken,
        },
        "swarm": {
          meshManager,
          workDistributor,
          sessionFactory: sharedSessionFactory,
          journal,
        },
        "claude-code": { journal, apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.KARNEVIL9_CLAUDE_CODE_MODEL, maxTurns: process.env.KARNEVIL9_CLAUDE_CODE_MAX_TURNS ? parsePositiveInt(process.env.KARNEVIL9_CLAUDE_CODE_MAX_TURNS, "KARNEVIL9_CLAUDE_CODE_MAX_TURNS") : undefined },
        "openai-codex": { journal, apiKey: process.env.OPENAI_API_KEY, model: process.env.KARNEVIL9_CODEX_MODEL },
        "grok-search": { journal, apiKey: process.env.XAI_API_KEY ?? process.env.XAI_KEY, model: process.env.KARNEVIL9_GROK_MODEL },
        "vault": {
          journal,
          vaultRoot: process.env.KARNEVIL9_VAULT_ROOT ?? resolve("vault"),
          classifierModel: process.env.KARNEVIL9_VAULT_CLASSIFIER_MODEL,
        },
        "github-repo": {},
      },
    });
    await pluginRegistry.discoverAndLoadAll();
    const active = pluginRegistry.listPlugins().filter((p) => p.status === "active");
    if (active.length > 0) {
      console.log(`Plugins loaded: ${active.map((p) => p.id).join(", ")}`);
    }

    const corsOrigins = process.env.KARNEVIL9_CORS_ORIGINS;
    const apiServer = new ApiServer({
      toolRegistry: registry, journal, toolRuntime: runtime, permissions,
      pluginRegistry,
      planner,
      agentic: opts.agentic ?? false,
      activeMemory,
      metricsCollector,
      scheduler,
      swarm: meshManager,
      apiToken,
      insecure: opts.insecure === true,
      corsOrigins: corsOrigins ? corsOrigins.split(",").map((s) => s.trim()) : undefined,
      approvalTimeoutMs: parsePositiveInt(process.env.KARNEVIL9_APPROVAL_TIMEOUT_MS ?? "300000", "KARNEVIL9_APPROVAL_TIMEOUT_MS", 300000),
      maxConcurrentSessions: parsePositiveInt(process.env.KARNEVIL9_MAX_SESSIONS ?? "50", "KARNEVIL9_MAX_SESSIONS", 50),
    });
    apiServerRef = apiServer;
    apiServer.listen(port);

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\nShutting down...");
      await apiServer.shutdown();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });

// ─── Chat Command ─────────────────────────────────────────────────

program.command("chat").description("Interactive chat session via WebSocket")
  .option("--url <url>", "WebSocket URL", "ws://localhost:3100/api/ws")
  .option("--token <token>", "API token (defaults to KARNEVIL9_API_TOKEN)")
  .option("--mode <mode>", "Execution mode: real, dry_run, mock", "real")
  .action(async (opts: { url: string; token?: string; mode: string }) => {
    const { WebSocket: WS } = await import("ws");
    const { ChatClient, RealTerminalIO } = await import("./chat-client.js");

    const token = opts.token ?? process.env.KARNEVIL9_API_TOKEN;
    const wsUrl = token ? `${opts.url}?token=${encodeURIComponent(token)}` : opts.url;

    let statusBar: import("./status-bar.js").StatusBarLike | undefined;
    if (process.stdout.isTTY) {
      const { StatusBar, RealStatusBarWriter } = await import("./status-bar.js");
      statusBar = new StatusBar(new RealStatusBarWriter(), { wsUrl, mode: opts.mode });
      process.stdout.on("resize", () => statusBar!.onResize());
      process.on("exit", () => statusBar!.teardown());
    }

    const client = new ChatClient({
      wsUrl,
      mode: opts.mode,
      wsFactory: (url) => new WS(url) as ChatWebSocket,
      terminal: new RealTerminalIO(),
      statusBar,
    });
    client.connect();
  });

// ─── Relay Command ────────────────────────────────────────────────

program.command("relay").description("Start the browser relay server")
  .option("-p, --port <port>", "Port number", "9222")
  .option("--driver <type>", "Driver: managed or extension", "managed")
  .option("--no-headless", "Run browser with visible window (managed only)")
  .option("--bridge-port <port>", "Bridge WebSocket port for extension driver", "9225")
  .action(async (opts: { port: string; driver: string; headless: boolean; bridgePort: string }) => {
    const { ManagedDriver, ExtensionDriver, RelayServer } = await import("@karnevil9/browser-relay");
    const driverType = opts.driver;

    let browserDriver;
    if (driverType === "extension") {
      const driver = new ExtensionDriver({ bridgePort: parsePort(opts.bridgePort, "bridge-port") });
      await driver.startBridge();
      browserDriver = driver;
      console.log(`Using extension driver (bridge WS on port ${opts.bridgePort})`);
    } else {
      browserDriver = new ManagedDriver({ headless: opts.headless });
      console.log(`Using managed driver (Playwright, headless=${opts.headless})`);
    }

    const server = new RelayServer({ port: parsePort(opts.port), driver: browserDriver, driverName: driverType });
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

// ─── Vault Commands ─────────────────────────────────────────────

const vaultCmd = program.command("vault").description("Vault management");

vaultCmd.command("sync")
  .description("Run full vault pipeline: dropzone → classify → vectorize → discover → dashboard → context → insights")
  .option("--skip-classify", "Skip LLM classification")
  .option("--skip-vectorize", "Skip embedding generation")
  .option("--skip-discover", "Skip relationship discovery")
  .option("--skip-insights", "Skip LLM insights generation")
  .option("--limit <n>", "Max items per phase", "500")
  .option("--plugins-dir <dir>", "Plugins directory", "plugins")
  .action(async (opts: { skipClassify?: boolean; skipVectorize?: boolean; skipDiscover?: boolean; skipInsights?: boolean; limit: string; pluginsDir: string }) => {
    const { journal, registry, permissions, runtime } = await createRuntime();
    const pluginsDir = resolve(opts.pluginsDir);
    const pluginRegistry = new PluginRegistry({
      journal, toolRegistry: registry, toolRuntime: runtime, permissions,
      pluginsDir,
      pluginConfigs: {
        vault: {
          journal,
          vaultRoot: process.env.KARNEVIL9_VAULT_ROOT ?? resolve("vault"),
          classifierModel: process.env.KARNEVIL9_VAULT_CLASSIFIER_MODEL,
        },
      },
    });
    await pluginRegistry.discoverAndLoadAll();

    // Find and execute the vault-sync command
    const commands = pluginRegistry.getCommands();
    const syncCmd = commands.find((c: { name: string }) => c.name === "vault-sync");
    if (!syncCmd) {
      console.error("Vault plugin not loaded or vault-sync command not found");
      process.exit(1);
    }
    await syncCmd.opts.action(opts);
    await journal.close();
  });

program.parse();
