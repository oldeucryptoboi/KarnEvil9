#!/usr/bin/env node
import { Command } from "commander";
import { v4 as uuid } from "uuid";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { Journal } from "@openflaw/journal";
import { ToolRegistry, ToolRuntime } from "@openflaw/tools";
import { PermissionEngine } from "@openflaw/permissions";
import { Kernel } from "@openflaw/kernel";
import { MockPlanner } from "@openflaw/planner";
import { ApiServer } from "@openflaw/api";
import type { Task, ApprovalDecision, PermissionRequest } from "@openflaw/schemas";

const JOURNAL_PATH = resolve("journal/events.jsonl");
const TOOLS_DIR = resolve("tools/examples");
const DEFAULT_PORT = 3100;

async function cliApprovalPrompt(request: PermissionRequest): Promise<ApprovalDecision> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const scopes = request.permissions.map((p) => p.scope).join(", ");
  console.log(`\n--- Permission Request ---`);
  console.log(`Tool: ${request.tool_name}`);
  console.log(`Step: ${request.step_id}`);
  console.log(`Scopes: ${scopes}`);
  console.log(`Options: [a]llow once, [s]ession, [g]lobal, [d]eny`);
  return new Promise<ApprovalDecision>((resolve) => {
    rl.question("Decision: ", (answer) => {
      rl.close();
      switch (answer.trim().toLowerCase()) {
        case "a": resolve("allow_once"); break;
        case "s": resolve("allow_session"); break;
        case "g": resolve("allow_always"); break;
        default: resolve("deny"); break;
      }
    });
  });
}

async function createRuntime() {
  const journal = new Journal(JOURNAL_PATH);
  await journal.init();
  const registry = new ToolRegistry();
  await registry.loadFromDirectory(TOOLS_DIR);
  const permissions = new PermissionEngine(journal, cliApprovalPrompt);
  const runtime = new ToolRuntime(registry, permissions, journal);
  return { journal, registry, permissions, runtime };
}

const program = new Command();
program.name("openflaw").description("OpenFlaw — Deterministic agent runtime").version("0.1.0");

program.command("run").description("Run a task end-to-end").argument("<task>", "Task description")
  .option("-m, --mode <mode>", "Execution mode: real, dry_run, mock", "mock")
  .option("--max-steps <n>", "Maximum steps", "20")
  .action(async (taskText: string, opts: { mode: string; maxSteps: string }) => {
    const { journal, registry, permissions, runtime } = await createRuntime();
    const task: Task = { task_id: uuid(), text: taskText, created_at: new Date().toISOString() };
    const kernel = new Kernel({
      journal, toolRuntime: runtime, toolRegistry: registry, permissions,
      planner: new MockPlanner(), mode: opts.mode as "real" | "dry_run" | "mock",
      limits: { max_steps: parseInt(opts.maxSteps, 10), max_duration_ms: 300000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true },
    });
    journal.on((event) => {
      const ts = event.timestamp.split("T")[1]?.slice(0, 8) ?? "";
      console.log(`[${ts}] ${event.type}`);
    });
    console.log(`\nOpenFlaw session starting...`);
    console.log(`Task: ${taskText}`);
    console.log(`Mode: ${opts.mode}`);
    console.log(`Tools: ${registry.list().map((t) => t.name).join(", ") || "(none)"}\n`);
    await kernel.createSession(task);
    const session = await kernel.run();
    console.log(`\nSession ${session.session_id}`);
    console.log(`Status: ${session.status}`);
    const state = kernel.getTaskState();
    if (state) {
      const snapshot = state.getSnapshot();
      console.log(`Steps completed: ${snapshot.completed_steps}/${snapshot.total_steps}`);
    }
  });

program.command("plan").description("Generate a plan without executing").argument("<task>", "Task description")
  .action(async (taskText: string) => {
    const { registry } = await createRuntime();
    const task: Task = { task_id: uuid(), text: taskText, created_at: new Date().toISOString() };
    const plan = await new MockPlanner().generatePlan(task, registry.getSchemasForPlanner(), {}, {});
    console.log(JSON.stringify(plan, null, 2));
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
  .action(async (opts: { port: string }) => {
    const { journal, registry } = await createRuntime();
    const server = new ApiServer(registry, journal);
    journal.on((event) => { server.broadcastEvent(event.session_id, event); });
    server.listen(parseInt(opts.port, 10));
  });

program.parse();
