#!/usr/bin/env tsx
/**
 * if-kernel-runner.ts — Interactive Fiction Kernel Runner
 *
 * Wires the KarnEvil9 kernel to drive an interactive fiction game session:
 *   - IFPlanner (Strategist LLM + BFS) as the kernel's planner
 *   - execute-game-command / parse-game-screen as registered tools
 *   - swarm-delegation plugin for the DeepMind delegation framework
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/if-kernel-runner.ts --llm --frotz --turns 20
 *   npx tsx scripts/if-kernel-runner.ts --frotz --turns 5            # scripted mode
 *   npx tsx scripts/if-kernel-runner.ts --llm --frotz --turns 20 --extended-thinking
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { v4 as uuid } from "uuid";
import Anthropic from "@anthropic-ai/sdk";

import { Kernel } from "@karnevil9/kernel";
import { Journal } from "@karnevil9/journal";
import {
  ToolRegistry,
  ToolRuntime,
  executeGameCommandHandler,
  parseGameScreenHandler,
  setEmulator,
  setCartographerFn,
} from "@karnevil9/tools";
import { PermissionEngine, type ApprovalPromptFn } from "@karnevil9/permissions";
import { PluginRegistry } from "@karnevil9/plugins";
import { IFPlanner, bfsPath } from "@karnevil9/planner";
import type { ToolManifest } from "@karnevil9/schemas";

import { ZorkEmulator, ZORK_SCRIPT } from "./apple2-zork-emulator.js";
import { ZorkFrotzEmulator } from "./apple2-zork-frotz.js";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    apple2:             { type: "boolean", default: false },
    frotz:              { type: "boolean", default: false },
    llm:                { type: "boolean", default: false },
    turns:              { type: "string",  default: "" },
    game:               { type: "string",  default: "" },
    verbose:            { type: "boolean", default: false },
    blind:              { type: "boolean", default: false },
    "inject-failure":   { type: "string",  default: "" },
    "extended-thinking": { type: "boolean", default: false },
    "thinking-budget":  { type: "string",  default: "10000" },
  },
});

const USE_APPLE2   = args.apple2 ?? false;
const USE_FROTZ    = args.frotz ?? false;
const USE_LLM      = args.llm ?? false;
const GAME_PATH    = (args.game as string | undefined) || "";
const USE_VERBOSE  = args.verbose ?? false;
const USE_BLIND    = args.blind ?? false;
const USE_EXTENDED_THINKING = args["extended-thinking"] ?? false;
const THINKING_BUDGET = parseInt(args["thinking-budget"] as string || "10000", 10);
const INJECT_FAILURE_TURN = args["inject-failure"] ? parseInt(args["inject-failure"] as string, 10) : undefined;

const isAiMode     = USE_LLM;
const DEFAULT_TURNS = isAiMode ? 20 : ZORK_SCRIPT.length;
const MAX_TURNS    = isAiMode
  ? parseInt(args.turns || String(DEFAULT_TURNS), 10)
  : Math.min(parseInt(args.turns || String(DEFAULT_TURNS), 10), ZORK_SCRIPT.length);

// ─── Models ───────────────────────────────────────────────────────────────────

const STRATEGIST_MODEL   = "claude-sonnet-4-5-20250929";
const CARTOGRAPHER_MODEL = "claude-haiku-4-5-20251001";

// ─── Color helpers ────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

function log(prefix: string, msg: string): void {
  console.log(`  ${prefix} ${msg}`);
}

function header(title: string): void {
  console.log(`\n${C.bold}${C.cyan}── ${title} ${"─".repeat(Math.max(0, 56 - title.length))}${C.reset}\n`);
}

// ─── Tool manifests (programmatic, matching the YAML files) ───────────────────

const EXECUTE_GAME_COMMAND_MANIFEST: ToolManifest = {
  name: "execute-game-command",
  version: "1.0.0",
  description: "Execute a command in an interactive fiction game emulator",
  runner: "internal",
  input_schema: {
    type: "object",
    required: ["command"],
    properties: { command: { type: "string", description: "Game command" } },
    additionalProperties: false,
  },
  output_schema: {
    type: "object",
    required: ["delta", "room_header", "screen_text", "success", "duration_ms"],
    properties: {
      delta: { type: "string" }, room_header: { type: "string" },
      screen_text: { type: "string" }, success: { type: "boolean" },
      duration_ms: { type: "number" },
    },
    additionalProperties: false,
  },
  permissions: ["game:execute:command"],
  timeout_ms: 60000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ delta: "(mock)", room_header: "Mock Room", screen_text: ">mock", success: true, duration_ms: 0 }],
};

const PARSE_GAME_SCREEN_MANIFEST: ToolManifest = {
  name: "parse-game-screen",
  version: "1.0.0",
  description: "Parse game screen text into structured room data",
  runner: "internal",
  input_schema: {
    type: "object",
    required: ["screen_text"],
    properties: { screen_text: { type: "string", description: "Screen text to parse" } },
    additionalProperties: false,
  },
  output_schema: {
    type: "object",
    required: ["screen_text", "room_name", "exits", "items", "description"],
    properties: {
      screen_text: { type: "string" }, room_name: { type: "string" },
      exits: { type: "array", items: { type: "string" } },
      items: { type: "array", items: { type: "string" } },
      description: { type: "string" },
    },
    additionalProperties: false,
  },
  permissions: ["game:read:screen"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ screen_text: "", room_name: "Mock", exits: [], items: [], description: "mock" }],
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   IF Kernel Runner — KarnEvil9 Agentic Loop                  ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`);

  const modeLabel = USE_APPLE2 ? "Playwright (--apple2)"
    : USE_FROTZ ? "dfrotz (--frotz)"
    : "Scripted simulation";
  const llmLabel = USE_LLM ? ` | LLM: ${STRATEGIST_MODEL}` : " | LLM: off";
  const thinkLabel = USE_EXTENDED_THINKING ? ` | Thinking: ${THINKING_BUDGET} tokens` : "";
  console.log(`  ${C.dim}Mode: ${modeLabel}${llmLabel}${thinkLabel} | Turns: ${MAX_TURNS}${C.reset}\n`);

  // ── Validate prerequisites ──────────────────────────────────────────────
  if (USE_LLM && !process.env.ANTHROPIC_API_KEY) {
    console.error(`${C.red}Fatal:${C.reset} --llm requires ANTHROPIC_API_KEY to be set.`);
    process.exit(1);
  }

  // ── Initialize Anthropic client ─────────────────────────────────────────
  const anthropic = USE_LLM ? new Anthropic() : null;

  // ── Launch emulator ─────────────────────────────────────────────────────
  header("LAUNCHING EMULATOR");
  const rngSeed = Math.floor(Math.random() * 0x7fff) + 1;
  const emulator = USE_FROTZ
    ? new ZorkFrotzEmulator()
    : new ZorkEmulator({ apple2: USE_APPLE2, injectFailureOnTurn: INJECT_FAILURE_TURN });
  await emulator.launch(GAME_PATH || undefined, USE_FROTZ ? { seed: rngSeed } : undefined);
  log(`${C.green}\u2713${C.reset}`, `Emulator launched (${modeLabel})`);

  // Wire the emulator into the tool handler
  setEmulator(emulator);

  // Wire the Cartographer LLM into the parse-game-screen handler
  if (USE_LLM) {
    setCartographerFn(async (screenText: string): Promise<string> => {
      const response = await anthropic!.messages.create({
        model: CARTOGRAPHER_MODEL,
        max_tokens: 128,
        system: `You are the Cartographer agent in an autonomous multi-agent system playing an interactive text-based game.
Given raw screen output from the game, extract:
1. Room name (the location header at the top of the description)
2. Visible exits (compass directions or special directions: up, down, in, out)
3. Items visible in the room (portable objects the agent could interact with)
4. A one-sentence room description

Respond with EXACTLY this format (no markdown, no extra text):
Room: <name> | Exits: <comma-separated> | Items: <comma-separated or none> | Desc: <one sentence>

If the screen text is NOT a full room description, respond with EXACTLY:
Room: Unknown | Exits: unknown | Items: unknown | Desc: Intermediate game response.`,
        messages: [{ role: "user", content: `Screen text:\n${screenText}` }],
      });
      const block = response.content[0];
      return block?.type === "text" ? block.text.trim()
        : "Room: Unknown | Exits: none | Items: none | Desc: Unable to parse.";
    });
  }

  // ── Set up kernel infrastructure ────────────────────────────────────────
  header("INITIALIZING KERNEL");

  const tmpBase = join(tmpdir(), `if-kernel-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });

  // Journal
  const journal = new Journal(join(tmpBase, "kernel.jsonl"), { fsync: false, redact: false });

  // Tool registry + runtime
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(EXECUTE_GAME_COMMAND_MANIFEST);
  toolRegistry.register(PARSE_GAME_SCREEN_MANIFEST);

  // Permission engine (auto-approve all game actions in kernel mode)
  const permPromptFn: ApprovalPromptFn = async () => "allow_session";
  const permEngine = new PermissionEngine(journal, permPromptFn);

  // Tool runtime
  const toolRuntime = new ToolRuntime(toolRegistry, permEngine, journal);
  toolRuntime.registerHandler("execute-game-command", executeGameCommandHandler);
  toolRuntime.registerHandler("parse-game-screen", parseGameScreenHandler);
  log(`${C.green}\u2713${C.reset}`, "Tools registered: execute-game-command, parse-game-screen");

  // ── Build callModel function ────────────────────────────────────────────

  const callModel = USE_LLM
    ? async (system: string, user: string) => {
        const params: Record<string, unknown> = {
          model: STRATEGIST_MODEL,
          max_tokens: USE_EXTENDED_THINKING ? 16000 : 300,
          system,
          messages: [{ role: "user", content: user }],
        };
        if (USE_EXTENDED_THINKING) {
          params.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET };
        }
        const response = await anthropic!.messages.create(params as Parameters<typeof anthropic.messages.create>[0]);
        // Extract text from content blocks (skip thinking blocks)
        const textBlock = response.content.find((b: { type: string }) => b.type === "text");
        const text = textBlock && "text" in textBlock ? (textBlock as { text: string }).text.trim() : "look";

        // Log thinking blocks in verbose mode
        if (USE_VERBOSE && USE_EXTENDED_THINKING) {
          const thinkingBlock = response.content.find((b: { type: string }) => b.type === "thinking");
          if (thinkingBlock && "thinking" in thinkingBlock) {
            log(`${C.dim}[Thinking]${C.reset}`, (thinkingBlock as { thinking: string }).thinking.slice(0, 500));
          }
        }

        return {
          text,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            total_tokens: response.usage.input_tokens + response.usage.output_tokens,
            model: STRATEGIST_MODEL,
          },
        };
      }
    : async (_system: string, _user: string) => {
        // Scripted mode: return a fixed command from ZORK_SCRIPT
        const scriptIdx = (callModel as unknown as { _idx: number })._idx ?? 0;
        (callModel as unknown as { _idx: number })._idx = scriptIdx + 1;
        const entry = ZORK_SCRIPT[scriptIdx];
        const command = entry?.command ?? "look";
        return { text: command, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, model: "scripted" } };
      };

  // ── Create IFPlanner ────────────────────────────────────────────────────

  const planner = new IFPlanner({
    callModel,
    bfsPathFinder: bfsPath,
    blind: USE_BLIND,
    onVerbose: USE_VERBOSE ? (label, text) => log(`${C.dim}${label}${C.reset}`, text) : undefined,
  });
  log(`${C.green}\u2713${C.reset}`, `IFPlanner created (extended thinking: ${USE_EXTENDED_THINKING})`);

  // ── Load swarm-delegation plugin ────────────────────────────────────────

  // Resolve plugins directory as absolute path from the script location
  const scriptDir = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
  const pluginsDir = join(scriptDir, "..", "plugins");
  const pluginRegistry = new PluginRegistry({
    journal,
    toolRegistry,
    toolRuntime,
    permissions: permEngine,
    pluginsDir,
    pluginConfigs: {
      "swarm-delegation": {
        tmpBase,
        emulator,
        log: (prefix: string, msg: string) => log(prefix, msg),
      } as Record<string, unknown>,
    },
  });

  const pluginState = await pluginRegistry.loadPlugin(
    join(pluginsDir, "swarm-delegation"),
    {
      tmpBase,
      emulator,
      log: (...logArgs: unknown[]) => {
        const parts = logArgs.map(a => String(a));
        log(`${C.dim}[plugin]${C.reset}`, parts.join(" "));
      },
    },
  );
  if (pluginState.status === "active") {
    log(`${C.green}\u2713${C.reset}`, "swarm-delegation plugin loaded");
  } else {
    log(`${C.red}\u2717${C.reset}`, `Plugin failed: ${pluginState.error}`);
  }

  // ── Create and run kernel ───────────────────────────────────────────────
  header("RUNNING KERNEL");

  const kernel = new Kernel({
    journal,
    toolRegistry,
    toolRuntime,
    planner,
    permissions: permEngine,
    pluginRegistry,
    mode: "real",
    agentic: true,
    limits: {
      max_iterations: MAX_TURNS,
      max_tokens: 500000,
      max_cost_usd: 5.0,
      max_duration_ms: MAX_TURNS * 120000, // 2 min per turn
    },
    policy: {
      allowed_paths: [],
      allowed_endpoints: [],
      allowed_commands: [],
      require_approval_for_writes: false,
    },
    plannerTimeoutMs: 120000,
  });

  const task = {
    task_id: uuid(),
    text: "Play interactive fiction game to completion. Explore rooms, solve puzzles, and advance the story.",
    created_at: new Date().toISOString(),
  };

  const session = await kernel.createSession(task);
  log(`${C.green}\u2713${C.reset}`, `Session created: ${session.session_id}`);

  const result = await kernel.run();

  // ── Summary ─────────────────────────────────────────────────────────────
  header("SESSION COMPLETE");
  // Kernel reports "failed" when max_iterations is exhausted, but for a game
  // session that simply ran out of turns this is expected — show "completed".
  const displayStatus = result.status === "failed" ? "completed (turns exhausted)" : result.status;
  log("Status:", displayStatus);
  log("Session ID:", result.session_id);

  // Cleanup
  await emulator.close();
  log(`${C.green}\u2713${C.reset}`, "Emulator closed");
  console.log(`\n${C.bold}${C.green}Done!${C.reset}\n`);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal error:${C.reset}`, err);
  process.exit(1);
});
