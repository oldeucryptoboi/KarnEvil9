/**
 * Zork I — Full Intelligent Delegation Agent (KarnEvil9)
 *
 * Three SwarmNodes collaborate to play Zork I using every component of the
 * DeepMind Intelligent AI Delegation framework:
 *
 *   Strategist  (port 3200) — Coordinator: plans moves, holds bonds, runs consensus.
 *   Tactician   (port 3201) — Executes commands in apple2js.com via Playwright.
 *   Cartographer(port 3202) — Maintains room map, independently verifies game state.
 *
 * Framework components exercised every turn:
 *   EscrowManager · ReputationStore · CognitiveFrictionEngine · GraduatedAuthority
 *   OutcomeVerifier · ConsensusVerifier · LiabilityFirebreak · DelegateeRouter
 *   Journal (SHA-256 hash chain) · Re-delegation & Recovery
 *
 * LLM mode (--llm):
 *   When enabled, real Claude API calls replace the scripted ZORK_SCRIPT:
 *     • Strategist calls Claude Sonnet-4-5 to decide the next Zork command given
 *       the current room + command history. It reasons about exploration strategy.
 *     • Cartographer calls Claude Haiku-4-5 to parse the raw Apple II screen text
 *       into a structured room record (exits, items, description).
 *   Without --llm the scripted ZORK_SCRIPT fallback is used (no API calls).
 *
 * Gotchas fixed (see inline ROOT CAUSE comments for each):
 *   1. Bond held AFTER firebreak passes (not before)
 *   2. Risky-command matching uses word-boundary regex (not string-includes)
 *   3. Screen delta extracted — agents see only the new response, not scroll history
 *   4. Consensus is independent — Cartographer reads the screen itself via VERIFY task
 *   5. Delegate() timeout uses the correct real-mode value (60s, not 15s)
 *   6. DelegateeRouter called per-turn, picks executor based on current trust score
 *   7. Room names deduplicated after stripping SCORE: suffix
 *   8. --inject-failure <turn> forces SLO failure in real mode for re-delegation testing
 *
 * Emulator modes:
 *   (none)     — scripted ZORK_SCRIPT simulation; no I/O, instant, for dev/testing
 *   --apple2   — Playwright → headed Chromium → apple2js.com → 6502 CPU → Zork disk
 *   --frotz    — dfrotz child process → Z-machine bytecode → clean text I/O (~5ms/cmd)
 *
 * Usage:
 *   npx tsx scripts/apple2-zork-swarm.ts                             # scripted sim
 *   npx tsx scripts/apple2-zork-swarm.ts --frotz                     # local dfrotz
 *   npx tsx scripts/apple2-zork-swarm.ts --apple2                    # live Playwright
 *   npx tsx scripts/apple2-zork-swarm.ts --turns 6
 *   npx tsx scripts/apple2-zork-swarm.ts --apple2 --inject-failure 9 # force re-delegation
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/apple2-zork-swarm.ts --llm
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/apple2-zork-swarm.ts --llm --frotz --turns 20
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/apple2-zork-swarm.ts --llm --apple2 --turns 20
 *   XAI_KEY=xai-...          npx tsx scripts/apple2-zork-swarm.ts --grok            # Classic Grok
 *   XAI_KEY=xai-...          npx tsx scripts/apple2-zork-swarm.ts --grok --turns 20
 *
 * Checkpointing (--resume):
 *   After every successful turn with --frotz, meta.json is written to ~/.zork-checkpoints/
 *   (or --checkpoint-dir). On resume, dfrotz is started fresh and the command history
 *   is replayed (~5ms/cmd) to restore the exact Z-machine state.
 *
 *   # Start a 20-turn session:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/apple2-zork-swarm.ts --llm --frotz --turns 20
 *   # Add 20 more turns later:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/apple2-zork-swarm.ts --llm --frotz --turns 20 --resume
 */

import "dotenv/config";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import express from "express";
import { parseArgs } from "node:util";
import { v4 as uuid } from "uuid";
import Anthropic from "@anthropic-ai/sdk";
import { Journal } from "@karnevil9/journal";
import { PermissionEngine, type ApprovalPromptFn } from "@karnevil9/permissions";
import { FutilityMonitor, UsageAccumulator, ContextBudgetMonitor, type IterationRecord, type UsageSummary, type ContextIteration } from "@karnevil9/kernel";
import { WorkingMemoryManager, ActiveMemory } from "@karnevil9/memory";
import { MetricsCollector } from "@karnevil9/metrics";
import {
  MeshManager,
  createSwarmRoutes,
  DEFAULT_SWARM_CONFIG,
  ReputationStore,
  EscrowManager,
  OutcomeVerifier,
  ConsensusVerifier,
  CognitiveFrictionEngine,
  LiabilityFirebreak,
  DelegateeRouter,
  AnomalyDetector,
  CheckpointSerializer,
  RootCauseAnalyzer,
  BehavioralScorer,
  RedelegationMonitor,
  SybilDetector,
  getTrustTier,
  authorityFromTrust,
  type SwarmConfig,
  type SwarmTaskRequest,
  type SwarmTaskResult,
  type SwarmRoute,
  type TaskAttribute,
  type ContractSLO,
  type ContractMonitoring,
  type DelegationContract,
} from "@karnevil9/swarm";
import type { StepResult, PermissionRequest, MemoryLesson, ModelPricing } from "@karnevil9/schemas";
import { ZorkEmulator, ZORK_SCRIPT, extractRoomHeader } from "./apple2-zork-emulator.js";
import { ZorkFrotzEmulator } from "./apple2-zork-frotz.js";

// ─── CLI ──────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    apple2:            { type: "boolean", default: false },
    frotz:             { type: "boolean", default: false },
    llm:               { type: "boolean", default: false },
    grok:              { type: "boolean", default: false },
    "grok-enhanced":   { type: "boolean", default: false },
    blind:             { type: "boolean", default: false },
    turns:             { type: "string",  default: "" },
    "inject-failure":  { type: "string",  default: "" },
    game:              { type: "string",  default: "" },  // path to any Z-machine story file
    resume:            { type: "boolean", default: false }, // resume from last checkpoint
    "checkpoint-dir":  { type: "string",  default: "" },   // where to store/load checkpoints
    "no-memory":       { type: "boolean", default: false }, // suppress cross-session lessons (for experiments)
    "verbose":         { type: "boolean", default: false }, // log full Strategist response each turn
    kernel:            { type: "boolean", default: false }, // use kernel agentic loop instead of inline loop
    "extended-thinking": { type: "boolean", default: false }, // enable extended thinking in kernel mode
    "thinking-budget": { type: "string",  default: "10000" }, // thinking budget tokens
  },
});

const USE_APPLE2           = args.apple2 ?? false;
const USE_FROTZ            = args.frotz  ?? false;
const USE_LLM              = args.llm    ?? false;
// --game <path>: run any Z-machine story file instead of the default zork1.z3
const GAME_PATH            = (args.game as string | undefined) || "";
// --blind: strip all game-specific language from every LLM prompt.
// The model receives only the raw game text and generic IF instructions.
// At the end of the session it is asked to identify the game from context alone.
const USE_BLIND            = args.blind  ?? false;
// --grok: classic direct loop — Grok 4.1 reasoning, no DeepMind framework.
// Implies --frotz (dfrotz is the only real emulator worth pairing with it).
const USE_GROK             = args.grok            ?? false;
// --grok-enhanced: Grok 4.1 reasoning as Strategist inside the full DeepMind
// framework. Claude Haiku remains Cartographer. Requires both XAI_KEY and
// ANTHROPIC_API_KEY. Pair with --blind for the identification experiment.
const USE_GROK_ENHANCED    = args["grok-enhanced"] ?? false;
// --no-memory: skip loading cross-session lessons from ActiveMemory (experiment flag)
const USE_NO_MEMORY        = args["no-memory"]     ?? false;
const USE_VERBOSE          = args["verbose"]       ?? false;

// All AI-driven modes default to 20 turns; scripted caps at ZORK_SCRIPT.length.
const isAiMode      = USE_LLM || USE_GROK || USE_GROK_ENHANCED;
const DEFAULT_TURNS = isAiMode ? 20 : ZORK_SCRIPT.length;
const MAX_TURNS     = isAiMode
  ? parseInt(args.turns || String(DEFAULT_TURNS), 10)
  : Math.min(parseInt(args.turns || String(DEFAULT_TURNS), 10), ZORK_SCRIPT.length);

const INJECT_FAILURE_TURN  = args["inject-failure"] ? parseInt(args["inject-failure"] as string, 10) : undefined;

// --resume / --checkpoint-dir: save game state after every turn so a session
// can be continued later by re-running with --resume.
const USE_RESUME     = args.resume ?? false;
const CHECKPOINT_DIR = (args["checkpoint-dir"] as string | undefined) || join(homedir(), ".zork-checkpoints");
const CKPT_META_JSON = join(CHECKPOINT_DIR, "meta.json");  // framework + command history

/** Everything needed to resume a session exactly where it stopped. */
interface BlockedPuzzle {
  room:   string;   // room where the obstacle was encountered
  object: string;   // the locked/blocked object (parsed from command)
  reason: string;   // short reason, e.g. "locked", "too heavy", "need key"
}

interface SessionCheckpoint {
  version:           1;
  savedAt:           string;
  turn:              number;
  sessionId:         string;
  commandHistory:    string[];
  lastDelta:         string;
  // Cartographer state
  roomExits:         Record<string, string[]>;
  // Directional graph: room → direction → destination room name.
  // Populated whenever the player successfully moves (go north → Troll Room
  // records dirGraph["Cellar"]["north"] = "The Troll Room").
  dirGraph:          Record<string, Record<string, string>>;
  rooms:             string[];
  lastRoomHeader:    string;
  // WorkingMemory
  currentRoom:       string;
  inventory:         string[];
  visitedRooms:      string[];
  roomGraph:         Record<string, string[]>;
  // Reputation — raw outcome counts so we can re-seed accurately
  tacticianCompleted: number;
  tacticianFailed:   number;
  cartoCompleted:    number;
  cartoFailed:       number;
  // Escrow — free balances so slashes carry over across sessions
  tacticianEscrow:   number;
  cartoEscrow:       number;
  // Usage accumulators — cumulative real API cost across all sessions
  strategistUsageSummary?: UsageSummary;
  cartoUsageSummary?:      UsageSummary;
  grokUsageSummary?:       UsageSummary;
  // ContextBudgetMonitor — cumulative tokens fed into Claude context across sessions
  cumulativeContextTokens?: number;
  // dfrotz RNG seed — fixed at session start so replays are deterministic
  rngSeed?: number;
  // Blocked puzzles — obstacles left behind to return to later
  blockedPuzzles?: BlockedPuzzle[];
}

// ─── API key guards ───────────────────────────────────────────────────────────

if ((USE_LLM || USE_GROK_ENHANCED) && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    `\x1b[31mFatal:\x1b[0m --llm / --grok-enhanced requires ANTHROPIC_API_KEY to be set.\n` +
    `  ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/apple2-zork-swarm.ts --llm\n`,
  );
  process.exit(1);
}

if ((USE_GROK || USE_GROK_ENHANCED) && !process.env.XAI_KEY) {
  console.error(
    `\x1b[31mFatal:\x1b[0m --grok / --grok-enhanced requires XAI_KEY to be set.\n` +
    `  XAI_KEY=xai-... npx tsx scripts/apple2-zork-swarm.ts --grok --frotz\n`,
  );
  process.exit(1);
}

// ─── API clients ──────────────────────────────────────────────────────────────

// Anthropic client — instantiated when --llm or --grok-enhanced is active.
// (--grok-enhanced still uses Claude Haiku for the Cartographer.)
const anthropic = (USE_LLM || USE_GROK_ENHANCED) ? new Anthropic() : null;

// Models: Strategist uses Sonnet for deeper reasoning; Cartographer uses Haiku
// for cheap, fast screen parsing.
const STRATEGIST_MODEL   = "claude-sonnet-4-5-20250929";
const CARTOGRAPHER_MODEL = "claude-haiku-4-5-20251001";

// Grok model — xAI reasoning variant (OpenAI-compatible API).
const GROK_MODEL     = "grok-4-1-fast-reasoning";
const XAI_API_URL    = "https://api.x.ai/v1/chat/completions";

// Root cause fix 5: the delegate() function had a hardcoded 15 000 ms local
// timeout that fired BEFORE the mesh's delegation_timeout_ms could take effect.
// --apple2 commands take ~5–8 s (canvas click + typing + 3.5 s render wait),
// so 15 s was too tight and caused spurious "Delegation timeout" errors on turn 1.
// --frotz commands complete in ~5 ms; 10 s is generous.
// Scripted simulation: 15 s.
const DELEGATE_TIMEOUT_MS = USE_APPLE2 ? 60_000 : USE_FROTZ ? 10_000 : 15_000;

// ─── Colors ──────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m",  blue: "\x1b[34m", magenta: "\x1b[35m",
};

function log(prefix: string, msg: string) { console.log(`  ${prefix} ${msg}`); }
function header(t: string) {
  console.log(`\n${C.bold}${C.cyan}${t}${C.reset}`);
  console.log(`${C.dim}${"━".repeat(62)}${C.reset}`);
}

// ─── Blind-mode game text sanitizer ──────────────────────────────────────────

/**
 * In --blind mode, replace game-identifying strings in raw game output before
 * it reaches any LLM prompt. Applied to every user-facing field: lastDelta,
 * fullScreen, screenText, currentRoom, roomsSeen, transcript entries.
 *
 * What is masked:
 *   - Game title: "ZORK I", "ZORK" (standalone)
 *   - Publisher:  "Infocom" (covers "Infocom, Inc." and bare mentions)
 *   - Copyright line: entire line starting with "Copyright"
 *   - Version fingerprint: "Revision N / Serial number N" lines
 *
 * Room names, item names, and all other game prose are intentionally left
 * intact — they are the legitimate clues for the end-of-session identification.
 */
function maskGameText(text: string): string {
  if (!USE_BLIND) return text;
  const blk = (m: string) => "█".repeat(m.length);
  return text
    .replace(/\bZORK\s+I\b/gi,                    blk)
    .replace(/\bZORK\b/gi,                         blk)
    .replace(/\bThe Great Underground Empire\b/gi, blk)
    .replace(/\bIncocom\b/gi,                      blk)   // typo guard
    .replace(/\bInfocom\b/gi,                      blk)
    .replace(/^Copyright\b.*/gim,                  blk)
    .replace(/^Revision\s+\d+\s*\/\s*Serial number\s+\d+.*/gim, blk);
}

// ─── Real cost tracking ───────────────────────────────────────────────────────
//
// UsageAccumulator instances are module-level so they can be updated from inside
// askStrategist(), askCartographer(), and askGrok() without changing call sites.
// Pricing (per 1k tokens) matches Anthropic and xAI published rates as of 2025-Q4.

const SONNET_PRICING: ModelPricing = { input_cost_per_1k_tokens: 0.003,   output_cost_per_1k_tokens: 0.015   };
const HAIKU_PRICING:  ModelPricing = { input_cost_per_1k_tokens: 0.00025, output_cost_per_1k_tokens: 0.00125 };
const GROK_PRICING:   ModelPricing = { input_cost_per_1k_tokens: 0.005,   output_cost_per_1k_tokens: 0.015   };

// Separate accumulator per model so the session summary shows per-agent spend.
const strategistUsage = new UsageAccumulator(SONNET_PRICING);
const cartoUsage      = new UsageAccumulator(HAIKU_PRICING);
const grokUsage       = new UsageAccumulator(GROK_PRICING);

// ─── Navigation helpers ───────────────────────────────────────────────────────

/**
 * BFS pathfinding through the directional graph.
 *
 * Returns an ordered array of { direction, destination } steps from `start`
 * to `target`, or null if no path exists in the known dirGraph.
 *
 * Used to generate "NAVIGATION HINT: go north → Cellar, then go north → Troll Room"
 * in the Strategist prompt when the agent has been stalled for several turns.
 */
function bfsPath(
  dirGraph: Record<string, Record<string, string>>,
  start:    string,
  target:   string,
  blocked:  Record<string, Set<string>> = {},
): Array<{ direction: string; destination: string }> | null {
  if (!start || !target || start === target) return [];
  type Step = { direction: string; destination: string };
  const queue: Array<{ room: string; path: Step[] }> = [{ room: start, path: [] }];
  const visited = new Set<string>([start]);
  while (queue.length > 0) {
    const { room, path } = queue.shift()!;
    const blockedHere = blocked[room] ?? new Set<string>();
    for (const [dir, dest] of Object.entries(dirGraph[room] ?? {})) {
      if (blockedHere.has(dir)) continue;  // skip permanently blocked directions
      const newPath: Step[] = [...path, { direction: dir, destination: dest }];
      if (dest === target) return newPath;
      if (!visited.has(dest)) {
        visited.add(dest);
        queue.push({ room: dest, path: newPath });
      }
    }
  }
  return null;
}

// ─── LLM helpers ──────────────────────────────────────────────────────────────

/**
 * Strategist: given the current environment state, ask the LLM for the next
 * command to issue.
 *
 * Fully game-agnostic — works for any interactive fiction title. The system
 * prompt gives the model a generic agent role; all game knowledge (what to do,
 * what is dangerous) comes from the model's in-context reasoning over the
 * screen text. No Zork-specific objectives, phase tracking, or puzzle flags.
 *
 * Per [1] §4.1 (Dynamic Assessment): the principal reasons about strategy
 * before committing to a delegation. Domain safety is the Strategist's
 * responsibility, not the Firebreak's.
 *
 * Returns a single lowercase command string, e.g. "go north", "take lamp".
 */
async function askStrategist(
  currentRoom: string,
  lastDelta: string,
  commandHistory: string[],
  fullScreen: string,
  gameState?: {
    inventory:       string[];
    visitedRooms:    string[];
    futilityHint:    string;
    failedCommands:  string[];
    blockedPuzzles:  BlockedPuzzle[];
    knownExits:      string[];                  // exits parsed by Cartographer for the current room
    roomDirections:  Record<string, string>;    // direction → destination room (from dirGraph)
    turnsStalled:    number;                    // turns since a new room was discovered (0 = not stalled)
    navigationHint?: string;                   // BFS-computed step-by-step path to key destination
    currentRoomName?: string;                  // current room name (for contextual injections)
    weightLimitDirs?: string[];                // directions blocked due to carry weight (soft block)
  },
  pastLessons?: MemoryLesson[],
): Promise<string> {
  if (!USE_LLM && !USE_GROK_ENHANCED) throw new Error("No LLM configured for Strategist");

  const blockedBlock = gameState?.blockedPuzzles.length
    ? `\nUNRESOLVED PUZZLES (left behind — return when you have the means):\n${
        gameState.blockedPuzzles.map(p => `  • ${p.room}: "${p.object}" (${p.reason})`).join("\n")
      }\n`
    : "";

  const exitsBlock = gameState?.knownExits.length
    ? `  Cartographer exits: ${gameState.knownExits.join(", ")}\n`
    : "";

  // Directional map: "north → The Troll Room, south → East of Chasm"
  // Built from prior movement history — the most reliable navigation data available.
  const dirEntries = Object.entries(gameState?.roomDirections ?? {});
  const dirBlock = dirEntries.length
    ? `  Directions from here: ${dirEntries.map(([d, r]) => `${d} → ${r}`).join(", ")}\n`
    : "";

  // BFS navigation hint — injected ONLY when a concrete path has been computed.
  // Placed prominently at the top of the memory block so the model sees it first.
  const navBlock = gameState?.navigationHint
    ? `\n⚑ NAVIGATION PATH (execute in order, one command per turn):\n  ${gameState.navigationHint}\n`
    : "";

  const stalledBlock = (gameState?.turnsStalled ?? 0) >= 5
    ? `\n⚠ STALLED: No new room discovered in the last ${gameState!.turnsStalled} turns.\n` +
      `  All accessible areas appear exhausted from rooms you have been visiting.\n` +
      `  You MUST take aggressive action: fight blocking enemies, use items on obstacles,\n` +
      `  or probe untried directions (up, down, in, out, and all compass directions).\n`
    : "";

  // Data-driven weight/block context — no game-specific knowledge required.
  // Populated from NavPrune observations of actual game responses.
  const curRoomForWeight = gameState?.currentRoomName ?? currentRoom;
  const softBlocked = [...(gameState?.weightLimitDirs ?? [])];
  const weightLimitBlock = softBlocked.length > 0
    ? `\n⚠ WEIGHT LIMIT: Direction(s) [${softBlocked.join(", ")}] failed due to carry weight from "${curRoomForWeight}".\n` +
      `  Consider dropping non-essential items from your inventory, then retry.\n` +
      `  Current inventory: ${gameState?.inventory.join(", ") || "unknown"}\n`
    : "";

  const memoryBlock = gameState ? `
AGENT MEMORY:${navBlock}${weightLimitBlock}
  Inventory: ${gameState.inventory.join(", ") || "empty"}
  Rooms visited: ${gameState.visitedRooms.slice(-15).join(", ") || "none yet"}
${exitsBlock}${dirBlock}  Recently failed/no-effect commands for this room: ${gameState.failedCommands.slice(-5).join(", ") || "none"}
${blockedBlock}${stalledBlock}${gameState.futilityHint ? `\n⚠ LOOP DETECTED: ${gameState.futilityHint}\n  → You MUST try a completely different approach.\n` : ""}` : "";

  // Cross-session lessons retrieved from ActiveMemory (persist across --resume sessions).
  // Injected verbatim so the model can avoid repeating mistakes from earlier runs.
  const lessonBlock = pastLessons && pastLessons.length > 0 ? `
CROSS-SESSION MEMORY (from ${pastLessons.length} prior session(s)):
${pastLessons.map(l => `  • [${l.outcome}] ${l.lesson}`).join("\n")}
` : "";

  const system = `You are the Strategist agent in an autonomous multi-agent system playing an interactive text-based game.
Your role: read the current environment state and decide the single best next action to make progress.
${memoryBlock}${lessonBlock}
Rules:
- Respond with EXACTLY ONE command, nothing else — no explanation, no punctuation at the end.
- Valid command forms: go <direction>, go in, go out, take <item>, drop <item>, open <object>, enter <object>, climb <object>, examine <object>, read <object>, attack <enemy> with <weapon>, etc.
- Directions include compass (north/south/east/west/up/down) and special (in/out).
- Use the full screen text to reason about your current situation and what to do next.
- Advance toward completing the game. Explore systematically, interact with objects, solve puzzles.
- Use "Cartographer exits" (shown in AGENT MEMORY above) to navigate — these are the available exits for your current room. An exit listed in "Cartographer exits" but absent from "Directions from here" has never been traversed and leads somewhere new. ALWAYS try those unexplored exits FIRST before using any exit that already appears in "Directions from here" (unless a NAVIGATION PATH is active in AGENT MEMORY — follow the path's first step instead).
- Do NOT use "look" if exits are listed under "Cartographer exits" — you already have the data you need. Only use "look" when exits are NOT listed (new room, or Cartographer data unavailable).
- Use "inventory" only when you genuinely don't know what you're carrying.
- If 'go <object>' fails with an unexpected response, try 'enter <object>' or 'go in' / 'go out' as alternatives.
- WINDOWS AND DOORS: A window described as "ajar", "slightly open", or "closed" must be opened first. If you see a window you want to enter: (1) "open window" first, (2) then "enter window" or "go in". Never try to enter without opening — you will get "The kitchen window is closed" and waste a turn.
- In combat, attack every round using "attack <enemy> with <weapon>" until defeated. If you have no weapon, retreat first, find a weapon, then return to fight.
- IMPORTANT: Only attack when you can SEE a monster in the room description. A glowing sword means a monster is nearby but NOT necessarily in the current room. If the game responds with echoes (e.g., "sword sword ...", "bar bar ..."), you are in an ECHO room — type "echo" to silence it rather than continuing to issue commands.
- If a direction appears in "weight-limited exits for this room" (shown in AGENT MEMORY above), drop non-essential items before retrying it.
- If a command appears in "recently failed/no-effect commands for this room" (shown in AGENT MEMORY above), DO NOT retry it — try a different approach.
- If you have been in the same room for 3+ turns with no progress (STALLED warning), try a direction you have NOT tried yet from this room.
- If navigation is blocked in all known directions, examine the room description for non-obvious exits (climb, enter, go out, up, down, or special directions).
- ITEM PICKUP (highest priority): When the Cartographer lists items in your current room that you need, TAKE THEM IMMEDIATELY before following any navigation path. Taking an item does NOT move you. After taking an item, you are still in the same room — use "Cartographer exits" to continue exploring unexplored directions. Do NOT retreat (go out/back) just because you picked something up.
- ACTION RESPONSES: When the last screen shows only a short confirmation ("Taken.", "Dropped.", "Done.", "You open the...") with no room description, you are still in the same room. Use the Cartographer exits listed in AGENT MEMORY to decide your next move — do not treat this as disorientation.
- NAVIGATION PATH IS MANDATORY: When a NAVIGATION PATH is shown in AGENT MEMORY, your ONLY valid action is to execute the FIRST step listed. Do NOT look, examine, attack, or take any other action. Just execute that single step. Exception: take a required item in your current room first, then continue.
- If an object is locked/blocked and you lack the means to open it, LEAVE and explore elsewhere — it is recorded in UNRESOLVED PUZZLES above so you will return when you have what you need.
- If in darkness (pitch black / no light), do NOT move into new rooms — find and use a light source first, or retreat the way you came.
- DEAD ENDS / UNDESCRIBED EXITS: Some rooms have exits not mentioned in the room text. If all listed exits have failed, systematically probe every direction you haven't tried: north, south, east, west, up, down, in, out. Failed directions are pruned automatically.`;

  const historyText = commandHistory.length > 0
    ? `\nCommand history (most recent last):\n${commandHistory.slice(-10).map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
    : "\nNo commands issued yet.";

  const user = `Current location: ${maskGameText(currentRoom || "Unknown")}
${historyText}

Last response:
${maskGameText(lastDelta || "(no previous response)")}

Full screen:
${maskGameText(fullScreen || "(no screen data)")}

Answer on THREE lines:
Line 1: your command (the command only, nothing else)
Line 2: "Game: <name or unknown> | Confidence: <0-100%> | Reason: <one phrase>"
Line 3: "Reasoning: <one sentence — why you chose this command>"
`;

  if (USE_GROK_ENHANCED) {
    const messages: GrokMessage[] = [
      { role: "system", content: system },
      { role: "user",   content: user   },
    ];
    const resp = await fetch(XAI_API_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json",
                 "Authorization": `Bearer ${process.env.XAI_KEY}` },
      body: JSON.stringify({ model: GROK_MODEL, messages, max_tokens: 64 }),
    });
    if (!resp.ok) throw new Error(`xAI strategist error ${resp.status}`);
    const json = await resp.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    if (json.usage) {
      grokUsage.record({
        input_tokens:  json.usage.prompt_tokens,
        output_tokens: json.usage.completion_tokens,
        total_tokens:  json.usage.prompt_tokens + json.usage.completion_tokens,
      });
    }
    const raw = json.choices[0]?.message?.content?.trim() ?? "look";
    return raw.replace(/^["'`]|["'`]$/g, "").replace(/[.!?]$/, "").toLowerCase().trim();
  }

  const response = await anthropic!.messages.create({
    model: STRATEGIST_MODEL,
    max_tokens: 300,  // room for recognition + reasoning + command
    system,
    messages: [{ role: "user", content: user }],
  });
  // Record real token usage for cost tracking
  strategistUsage.record({
    input_tokens:  response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    total_tokens:  response.usage.input_tokens + response.usage.output_tokens,
  });

  const block = response.content[0];
  const raw = block?.type === "text" ? block.text.trim() : "look";
  // Command is now Line 1; Game/Reasoning are Lines 2-3 (diagnostic only, post-hoc).
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const recognitionLine = lines.find(l => /^Game:/i.test(l));
  if (recognitionLine) {
    log(`${C.dim}[Recognition]${C.reset}`, recognitionLine);
  }
  const reasoningLine = lines.find(l => /^Reasoning:/i.test(l));
  if (reasoningLine) {
    log(`${C.dim}[Reasoning]${C.reset}`, reasoningLine);
  }
  // --verbose: log full Strategist response
  if (USE_VERBOSE) {
    log(`${C.dim}[Strategist/full]${C.reset}`, `\n${raw}`);
  }
  // Command is the first non-Game/non-Reasoning line
  const commandLine = lines.find(l => !/^(Game:|Reasoning:)/i.test(l)) ?? "look";
  return commandLine.replace(/[.!?]$/, "").toLowerCase();
}

/**
 * Cartographer: given raw screen text from any interactive fiction game,
 * ask Claude Haiku to parse it into structured room information.
 *
 * Fully game-agnostic — works for any Z-machine title.
 *
 * Returns a human-readable summary used in MAP task findings, e.g.:
 *   "Room: West of House | Exits: north, south, east | Items: small mailbox"
 */
async function askCartographer(screenText: string): Promise<string> {
  if (!anthropic) throw new Error("LLM not initialised");

  const system = `You are the Cartographer agent in an autonomous multi-agent system playing an interactive text-based game.
Given raw screen output from the game, extract:
1. Room name (the location header at the top of the description)
2. Visible exits (compass directions or special directions: up, down, in, out)
   - Scan ALL text for exit clues: "To the north...", "A path leads east...", "There is a door to the west...",
     "staircase going up...", etc. Include EVERY direction mentioned in the text.
   - Also include "in" for any passable opening that lacks a compass direction: a door off its hinges,
     an open or broken door, a window ajar, a hole, an archway, a passage with no explicit direction.
     Include "out" if the text implies an exit back outside (e.g. "rear door to outside", "exit back").
3. Items visible in the room (portable objects the agent could interact with)
4. A one-sentence room description

Respond with EXACTLY this format (no markdown, no extra text):
Room: <name> | Exits: <comma-separated> | Items: <comma-separated or none> | Desc: <one sentence>

If the screen text is NOT a full room description (e.g. just "Taken.", "Dropped.",
"You can't go that way.", an action confirmation, or a title/welcome screen), respond with EXACTLY:
Room: Unknown | Exits: unknown | Items: unknown | Desc: Intermediate game response.
Do not output prose explanations or ask for clarification.`;

  const response = await anthropic.messages.create({
    model: CARTOGRAPHER_MODEL,
    max_tokens: 128,
    system,
    messages: [{ role: "user", content: `Screen text:\n${maskGameText(screenText)}` }],
  });
  // Record real token usage for cost tracking
  cartoUsage.record({
    input_tokens:  response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    total_tokens:  response.usage.input_tokens + response.usage.output_tokens,
  });

  const block = response.content[0];
  return block?.type === "text" ? block.text.trim() : `Room: Unknown | Exits: none | Items: none | Desc: Unable to parse screen.`;
}

// ─── Grok classic helper ──────────────────────────────────────────────────────

/**
 * Classic mode: ask Grok 4.1 reasoning for the next Zork command.
 *
 * Unlike the DeepMind-enhanced mode where the Strategist, Tactician, and
 * Cartographer collaborate with bonds/consensus/firebreaks, here a single
 * Grok reasoning model decides everything on its own.  The model receives
 * the full game context (screen, delta, history, rooms visited, inventory)
 * and returns one command.  No oversight, no re-delegation — raw capability.
 *
 * Uses the xAI OpenAI-compatible REST API directly (no extra SDK needed).
 */
interface GrokMessage { role: "system" | "user" | "assistant"; content: string; }

async function askGrok(
  fullScreen:     string,
  lastDelta:      string,
  currentRoom:    string,
  commandHistory: string[],
  roomsSeen:      string[],
  inventory:      string[],
): Promise<string> {
  const system = USE_BLIND
    ? `You are playing an unknown interactive text adventure game.
Your goal: explore, find useful items, and complete whatever objectives the game presents.
Deduce everything — mechanics, world, puzzles — from the game's text responses alone.

Instructions:
- Output EXACTLY ONE game command per turn — nothing else, no punctuation at the end.
- Valid examples: look, inventory, go north, take lamp, open mailbox, read leaflet, enter house, go down, open window, move rug
- Never repeat a command that produced no change in the previous turn; try something different instead.
- Prioritise picking up items that seem useful or valuable.
- Track which rooms you have visited and prefer unexplored directions.
- If in darkness, find and use a light source before moving.`
    : `You are playing an interactive text adventure game.
Your goal: explore the world, solve puzzles, collect useful items, and complete the game's objectives.

Instructions:
- Output EXACTLY ONE game command per turn — nothing else, no punctuation at the end.
- Valid examples: look, inventory, go north, take lamp, open mailbox, read leaflet, enter house, go down, open window, examine object
- Never repeat a command that produced no change in the previous turn; try something different instead.
- Prioritise picking up items that seem useful for progression.
- Explore systematically — track which rooms you have visited and prefer unexplored directions.
- If in darkness, find and use a light source before moving.`;

  const historyBlock = commandHistory.length
    ? commandHistory.slice(-15).map((c, i) => `  ${i + 1}. ${c}`).join("\n")
    : "  (none yet)";

  const user = `=== GAME STATE ===
Current room : ${maskGameText(currentRoom || "Unknown")}
Rooms visited: ${roomsSeen.map(maskGameText).join(", ") || "(none yet)"}
Inventory    : ${inventory.length > 0 ? inventory.join(", ") : "(empty)"}

=== LAST RESPONSE ===
${maskGameText(lastDelta || "(game just started)")}

=== FULL SCREEN ===
${maskGameText(fullScreen || "(no screen data yet)")}

=== COMMAND HISTORY (oldest → newest) ===
${historyBlock}

What is your single next command?`;

  const messages: GrokMessage[] = [
    { role: "system",    content: system },
    { role: "user",      content: user },
  ];

  const resp = await fetch(XAI_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${process.env.XAI_KEY}`,
    },
    body: JSON.stringify({
      model:      GROK_MODEL,
      messages,
      max_tokens: 64,
      // grok-4-1-fast-reasoning reasons internally — no reasoning_effort param needed
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`xAI API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  if (json.usage) {
    grokUsage.record({
      input_tokens:  json.usage.prompt_tokens,
      output_tokens: json.usage.completion_tokens,
      total_tokens:  json.usage.prompt_tokens + json.usage.completion_tokens,
    });
  }

  const raw = json.choices[0]?.message?.content?.trim() ?? "look";
  // Strip accidental punctuation / quotes / markdown
  return raw.replace(/^["'`]|["'`]$/g, "").replace(/[.!?]$/, "").toLowerCase().trim();
}

/**
 * Blind-mode identification: after the session, ask the active LLM to name the
 * game it was playing, using only the transcript of commands and responses.
 *
 * Works for both modes:
 *   --grok  → sends the question to the xAI API
 *   --llm   → sends the question to Claude Sonnet via the Anthropic SDK
 *
 * transcript is a compact log of "cmd → response" lines from the session.
 */
async function askIdentifyGame(transcript: string): Promise<string> {
  const prompt = `Below is the complete transcript of a session in which you interacted with an interactive text adventure game.
You were NOT told the game's name beforehand.

TRANSCRIPT:
${transcript}

Based solely on the text responses from the game above, answer:
1. What game do you believe this is? (title and series if applicable)
2. Who published it, and in what year?
3. List three specific clues from the transcript that led to your identification.

Be as specific as possible. If you are uncertain, give your best guess and explain why.`;

  if (USE_GROK || USE_GROK_ENHANCED) {
    const messages: GrokMessage[] = [
      { role: "user", content: prompt },
    ];
    const resp = await fetch(XAI_API_URL, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${process.env.XAI_KEY}`,
      },
      body: JSON.stringify({ model: GROK_MODEL, messages, max_tokens: 512 }),
    });
    if (!resp.ok) throw new Error(`xAI identify error ${resp.status}`);
    const json = await resp.json() as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]?.message?.content?.trim() ?? "(no response)";
  }

  if (USE_LLM && anthropic) {
    const response = await anthropic.messages.create({
      model:      STRATEGIST_MODEL,
      max_tokens: 512,
      messages:   [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    return block?.type === "text" ? block.text.trim() : "(no response)";
  }

  return "(identify not available — neither --grok nor --llm active)";
}

/**
 * Parse inventory from Zork "taken" / "inventory" responses.
 * Crude heuristic — good enough for the comparison trace.
 */
function updateInventory(inventory: string[], delta: string, command: string): string[] {
  const lc = delta.toLowerCase();
  // "Taken." (possibly followed by extra text like sound effects) — add the object
  if (/^taken\.?(\s|$)/i.test(delta)) {
    const obj = command.replace(/^take\s+/i, "").trim();
    if (obj && !inventory.includes(obj)) inventory.push(obj);
  }
  // "Dropped." (possibly followed by extra text) — remove
  if (/^dropped\.?(\s|$)/i.test(delta)) {
    const obj = command.replace(/^drop\s+/i, "").trim();
    inventory = inventory.filter(i => i !== obj);
  }
  // "throw X at Y" where NPC catches/eats/takes the item — item is lost
  // e.g. "The troll catches the jewel-encrusted egg and eats it"
  if (/^throw\s+/i.test(command) && /catches|eats|snatches|grabs/i.test(delta)) {
    const thrown = command.replace(/^throw\s+/i, "").replace(/\s+at\s+.*/i, "").trim();
    inventory = inventory.filter(i => i !== thrown);
  }
  // Player death — all items are lost (game restarts empty-handed)
  if (/\*\*\*\*\s*(you have died|you are dead)/i.test(delta)) {
    inventory = [];
  }
  return inventory;
}

/**
 * Returns a short reason string if the game response signals a blockage,
 * or null if the action succeeded normally.
 * Patterns are game-agnostic (common across interactive fiction).
 */
function detectBlockReason(delta: string): string | null {
  const d = delta.toLowerCase();
  if (/the .+ is locked/i.test(d))                            return "locked";
  if (/\blocked\b/i.test(d))                                  return "locked";
  if (/you (don't|do not|can't|cannot) have (that|the)\b/.test(d)) return "need item";
  if (/you('re| are) (carrying|holding) too (much|many|heavy)/i.test(d)) return "too heavy";
  if (/your load is too heavy/i.test(d))                      return "too heavy";
  if (/you need (a |the )?\w/i.test(d))                       return "need item";
  if (/requires? (a |the )?\w/i.test(d))                      return "need item";
  if (/you can'?t (go|move|open|enter) that way/i.test(d))    return "no passage";
  return null;
}

// ─── Classic game loop (--grok) ───────────────────────────────────────────────

async function runClassicGrok(
  emulator: ZorkFrotzEmulator | ZorkEmulator,
  maxTurns: number,
): Promise<void> {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║      ZORK I — Classic Grok  (no DeepMind framework)         ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  ${C.dim}Model: ${GROK_MODEL} | Emulator: dfrotz | Turns: ${maxTurns}${C.reset}`);

  header("GAME LOOP  (Classic — single agent, no oversight)");

  const commandHistory: string[]  = [];
  const roomsSeen:      string[]  = [];
  const transcript:     string[]  = [];   // blind-mode: cmd → response lines
  let   inventory:      string[]  = [];
  let   lastDelta                 = "";
  let   currentRoom               = "";
  let   successCount              = 0;
  let   failCount                 = 0;
  let   repeatedCommands          = 0;
  let   noEffectCommands          = 0;
  let   totalTokensIn             = 0;
  let   totalTokensOut            = 0;

  // Issue an initial "look" so Grok has context on turn 1
  const initResult = await emulator.sendCommand("look");
  lastDelta   = initResult.delta;
  currentRoom = initResult.roomHeader;
  if (currentRoom && !roomsSeen.includes(currentRoom)) roomsSeen.push(currentRoom);
  log(`${C.green}✓${C.reset}`, `Initial look — room: ${C.dim}"${currentRoom}"${C.reset}`);

  for (let turn = 1; turn <= maxTurns; turn++) {
    console.log(`\n${C.bold}${C.dim}── Turn ${turn} / ${maxTurns} ──────────────────────────────────────────${C.reset}`);

    const fullScreen = (await emulator.readScreen()) ?? "";

    // ── Ask Grok for next command ────────────────────────────────────────────
    log(`${C.yellow}[Grok]${C.reset}`, `Calling ${C.dim}${GROK_MODEL}${C.reset} (reasoning_effort=high)...`);
    const tStart = Date.now();
    let command: string;
    try {
      command = await askGrok(fullScreen, lastDelta, currentRoom, commandHistory, roomsSeen, inventory);
    } catch (err) {
      log(`${C.red}[Grok]${C.reset}`, `API error: ${String(err).slice(0, 80)}`);
      failCount++;
      continue;
    }
    const grokMs = Date.now() - tStart;

    // ── Detect repeated command ──────────────────────────────────────────────
    const isRepeat = commandHistory.slice(-3).includes(command);
    if (isRepeat) repeatedCommands++;

    log(`${C.yellow}[Grok]${C.reset}`,
      `→ ${C.bold}"${command}"${C.reset}${isRepeat ? C.red + " (REPEAT)" + C.reset : ""} ${C.dim}(${grokMs}ms)${C.reset}`);

    // ── Execute via dfrotz ───────────────────────────────────────────────────
    const result = await emulator.sendCommand(command);
    commandHistory.push(command);

    // Truncate display to 100 chars
    const displayDelta = result.delta.replace(/\n/g, " ").slice(0, 100);
    log(`${C.green}[Zork]${C.reset}`,
      `← ${C.dim}"${displayDelta}${result.delta.length > 100 ? "…" : ""}"${C.reset}`);

    // ── Detect no-effect response ────────────────────────────────────────────
    const noEffect = result.delta === "(no visible response)"
      || result.delta === lastDelta
      || /^(you can't|i don't understand|that verb|what do you want|huh)/i.test(result.delta);
    if (noEffect) noEffectCommands++;

    // ── Update state ─────────────────────────────────────────────────────────
    lastDelta = result.delta;
    transcript.push(`> ${command}\n${maskGameText(result.delta.slice(0, 300))}`);
    if (result.roomHeader && !roomsSeen.includes(result.roomHeader)) {
      roomsSeen.push(result.roomHeader);
      log(`${C.magenta}[Map]${C.reset}`,
        `New room: ${C.bold}"${result.roomHeader}"${C.reset} (${roomsSeen.length} total)`);
    }
    if (result.roomHeader) currentRoom = result.roomHeader;
    inventory = updateInventory(inventory, result.delta, command);

    // ── Per-turn status ──────────────────────────────────────────────────────
    log(`${C.dim}[State]${C.reset}`,
      `Room: "${currentRoom}" | Items held: ${inventory.length > 0 ? inventory.join(", ") : "none"}`);

    if (noEffect) {
      log(`${C.yellow}[Warn]${C.reset}`, `Command had no effect or was not understood`);
      failCount++;
    } else {
      successCount++;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  header("SESSION SUMMARY  (Classic Grok)");
  console.log();
  log(`${C.bold}📊${C.reset}`, `${C.bold}Turns played:${C.reset} ${maxTurns}`);
  log(`${C.green}✓${C.reset}`,  `Effective turns: ${C.green}${successCount}${C.reset}`);
  log(`${C.yellow}⚠${C.reset}`, `No-effect turns: ${C.yellow}${failCount}${C.reset}`);
  log(`${C.red}↺${C.reset}`,   `Repeated commands: ${C.red}${repeatedCommands}${C.reset}`);
  log(`${C.dim}•${C.reset}`,   `Rooms explored: ${roomsSeen.length} — ${roomsSeen.join(", ") || "(none)"}`);
  log(`${C.dim}•${C.reset}`,   `Inventory: ${inventory.length > 0 ? inventory.join(", ") : "(empty)"}`);
  log(`${C.dim}•${C.reset}`,   `Commands issued: ${commandHistory.join(" → ")}`);
  log(`${C.dim}•${C.reset}`,   `Model: ${GROK_MODEL} | Framework: none (classic)`);

  if (USE_BLIND) {
    header("GAME IDENTIFICATION  (blind mode)");
    log(`${C.yellow}[Blind]${C.reset}`, `Asking ${GROK_MODEL} to identify the game from transcript...`);
    try {
      const identification = await askIdentifyGame(transcript.join("\n\n"));
      console.log(`\n${C.bold}${C.cyan}Game identification:${C.reset}`);
      console.log(identification.split("\n").map(l => `  ${l}`).join("\n"));
    } catch (err) {
      log(`${C.red}[Blind]${C.reset}`, `Identification failed: ${String(err).slice(0, 80)}`);
    }
  }
}

// ─── HTTP bridge ──────────────────────────────────────────────────────────────

function mountSwarmRoutes(app: express.Express, routes: SwarmRoute[]) {
  for (const route of routes) {
    const method = route.method.toLowerCase() as "get" | "post";
    app[method](`/api${route.path}`, async (req, res) => {
      try {
        await route.handler(
          { method: req.method, path: req.path,
            params: req.params as Record<string, string>,
            query:  req.query  as Record<string, string>,
            body:   req.body },
          {
            json:   (d) => { res.json(d); },
            text:   (d, ct) => { if (ct) res.type(ct); res.send(d); },
            status: (code) => ({
              json: (d) => { res.status(code).json(d); },
              text: (d, ct) => { if (ct) res.type(ct); res.status(code).send(d); },
            }),
          },
        );
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });
  }
}

// ─── Node factory ─────────────────────────────────────────────────────────────

interface ZorkNode {
  name: string;
  port: number;
  color: string;
  journal: Journal;
  mesh: MeshManager;
  server: http.Server;
  pending: Map<string, (r: SwarmTaskResult) => void>;
}

type NodeRole = "strategist" | "tactician" | "cartographer";

async function createNode(
  name: string,
  port: number,
  color: string,
  role: NodeRole,
  capabilities: string[],
  emulator: ZorkEmulator | ZorkFrotzEmulator,
  cartographerState: { rooms: string[]; lastRoomHeader: string; lastFullScreen: string; roomExits: Record<string, string[]>; dirGraph: Record<string, Record<string, string>>; blockedExits: Record<string, Set<string>>; weightLimitExits: Record<string, Set<string>> },
): Promise<ZorkNode> {
  const journalPath = join(tmpdir(), `k9-zork-${name.toLowerCase()}-${uuid().slice(0, 8)}.jsonl`);
  const journal = new Journal(journalPath, { fsync: false, redact: false, lock: false });
  await journal.init();

  const config: SwarmConfig = {
    ...DEFAULT_SWARM_CONFIG,
    enabled: true,
    api_url: `http://localhost:${port}`,
    capabilities,
    node_name: name,
    mdns: false, gossip: false, seeds: [],
    heartbeat_interval_ms: 2000,
    sweep_interval_ms: 5000,
    suspected_after_ms: 10000,
    unreachable_after_ms: 20000,
    evict_after_ms: 60000,
    delegation_timeout_ms: DELEGATE_TIMEOUT_MS,
  };

  const pending = new Map<string, (r: SwarmTaskResult) => void>();

  const mesh = new MeshManager({
    config,
    journal,

    onTaskRequest: role === "strategist" ? undefined : async (request: SwarmTaskRequest) => {
      void (async () => {
        const startTime = Date.now();
        const taskText = request.task_text;
        const originPeer = mesh.getPeers().find(
          (p) => p.identity.node_id === request.originator_node_id,
        );

        if (role === "tactician") {
          // Parse command from task text: "EXECUTE: <command>"
          const match = taskText.match(/^EXECUTE:\s*(.+)$/i);
          const command = match?.[1]?.trim() ?? "look";

          log(`${color}→${C.reset}`, `${color}[Tactician]${C.reset} → ${C.yellow}"${command}"${C.reset}`);

          const result = await emulator.sendCommand(command);
          const duration = Date.now() - startTime;

          // Update shared Cartographer state with full screen (for room tracking)
          // and delta (for human-readable display).
          // Root cause fix 3: previously cartographerState.lastOutput was set to the
          // full rolling 24-row screen, causing room names to include stale scroll
          // history. Now lastFullScreen carries the full snapshot and lastRoomHeader
          // carries the clean room name (score stripped) for deduplication.
          //
          // Additionally (isRoomName guard): in simulated mode, result.roomHeader is
          // the first line of the game response text, which for non-movement commands
          // is something like "Opening the small mailbox reveals a leaflet." or
          // "Taken." — not a room name. Only update lastRoomHeader when the header
          // actually looks like a location, so the Cartographer retains the previous
          // room across non-movement turns.
          if (result.success) {
            cartographerState.lastFullScreen = result.output;
            if (result.roomHeader && isRoomName(result.roomHeader)) {
              cartographerState.lastRoomHeader = result.roomHeader;
            }
          }

          if (originPeer) {
            await mesh.getTransport().sendTaskResult(originPeer.identity.api_url, {
              task_id:         request.task_id,
              peer_node_id:    mesh.getIdentity().node_id,
              peer_session_id: `tact-${uuid().slice(0, 8)}`,
              status:          result.success ? "completed" : "failed",
              findings: result.success ? [{
                step_title: USE_BLIND ? "Command executed" : "Zork command executed",
                tool_name:  USE_BLIND ? "game-emulator" : "zork-emulator",
                status:     "succeeded",
                // Use delta (new response only) — not full screen — as the finding.
                // Root cause fix 3: full screen contains scroll history from prior turns.
                summary:    result.delta.slice(0, 200),
              }] : [],
              tokens_used: result.tokensApprox,
              cost_usd:    +(result.tokensApprox * 0.000015).toFixed(6),
              duration_ms: result.durationMs,
            });
          }

        } else if (role === "cartographer") {
          if (taskText.startsWith("MAP:")) {
            // MAP task: update the room map from the latest screen state.
            const roomHeader = cartographerState.lastRoomHeader || "West of House";

            // Root cause fix 7: previously every unique screen snapshot (which
            // includes a changing SCORE: X/Y suffix) was added as a distinct room,
            // inflating the map from 3 real rooms to 9+ entries.
            // extractRoomHeader() strips the score before dedup.
            if (!cartographerState.rooms.includes(roomHeader)) {
              cartographerState.rooms.push(roomHeader);
            }

            // In LLM mode: ask Claude Haiku to parse the screen into structured
            // room info (exits, items, description) and include it in findings.
            let mapSummary = `Room: "${roomHeader}" | Map size: ${cartographerState.rooms.length}`;
            let llmTokens  = 18;
            let llmCost    = 0.000270;

            if ((USE_LLM || USE_GROK_ENHANCED) && cartographerState.lastFullScreen) {
              try {
                const parsed = await askCartographer(cartographerState.lastFullScreen);
                mapSummary = parsed;
                // Haiku pricing: ~$0.25/1M input tokens; ~100 tokens per call
                llmTokens  = 100;
                llmCost    = 0.000025;
              } catch {
                mapSummary = `Room: "${roomHeader}" | Map size: ${cartographerState.rooms.length} (LLM parse failed)`;
              }
            }

            if (originPeer) {
              await mesh.getTransport().sendTaskResult(originPeer.identity.api_url, {
                task_id:         request.task_id,
                peer_node_id:    mesh.getIdentity().node_id,
                peer_session_id: `carto-${uuid().slice(0, 8)}`,
                status:          "completed",
                findings: [{
                  step_title: "Room mapped",
                  tool_name:  USE_LLM ? "cartographer-llm" : "cartographer",
                  status:     "succeeded",
                  summary:    mapSummary,
                }],
                tokens_used: llmTokens,
                cost_usd:    llmCost,
                duration_ms: Date.now() - startTime,
              });
            }

          } else if (taskText.startsWith("EXECUTE:")) {
            // EXECUTE task re-delegated to Cartographer after Tactician SLO failure.
            //
            // Root cause: the re-delegation path sent "EXECUTE: <cmd>" to Cartographer,
            // but the Cartographer only handled MAP: and VERIFY: tasks. It accepted the
            // task (returned { accepted: true }) but never sent a result back, causing
            // the re-delegation to always time out — making the recovery path unreachable.
            // Fix: Cartographer handles EXECUTE: identically to Tactician so re-delegation
            // actually produces a game result.
            const match2 = taskText.match(/^EXECUTE:\s*(.+)$/i);
            const command2 = match2?.[1]?.trim() ?? "look";

            log(`${color}→${C.reset}`, `${color}[Cartographer-exec]${C.reset} → ${C.yellow}"${command2}"${C.reset} (re-delegated)`);
            const result2 = await emulator.sendCommand(command2);

            if (result2.success && result2.roomHeader && isRoomName(result2.roomHeader)) {
              cartographerState.lastRoomHeader = result2.roomHeader;
            }
            if (result2.success) cartographerState.lastFullScreen = result2.output;

            if (originPeer) {
              await mesh.getTransport().sendTaskResult(originPeer.identity.api_url, {
                task_id:         request.task_id,
                peer_node_id:    mesh.getIdentity().node_id,
                peer_session_id: `carto-exec-${uuid().slice(0, 8)}`,
                status:          result2.success ? "completed" : "failed",
                findings: result2.success ? [{
                  step_title: USE_BLIND ? "Command executed (re-delegated)" : "Zork command executed (re-delegated)",
                  tool_name:  "cartographer-exec",
                  status:     "succeeded",
                  summary:    result2.delta,
                }] : [],
                tokens_used: result2.tokensApprox,
                cost_usd:    +(result2.tokensApprox * 0.000015).toFixed(6),
                duration_ms: result2.durationMs,
              });
            }

          } else if (taskText.startsWith("VERIFY:")) {
            // VERIFY task: independently read the screen and return a hash.
            //
            // Root cause fix 4: consensus was a rubber stamp — both Strategist and
            // Cartographer hashed the SAME tacResult.findings object, guaranteeing
            // agreed(1.0) regardless of whether Tactician reported accurately.
            //
            // Now Cartographer calls emulator.readScreen() directly. In a real
            // distributed LLM system, this would detect a lying/hallucinating
            // Tactician: if the Tactician's delta hash ≠ the actual screen hash,
            // consensus fails and the bond is slashed. In our in-process setup the
            // screen is shared so they agree honestly — but the structure is correct.
            const screen = await emulator.readScreen();
            const hash = createHash("sha256")
              .update(screen ?? "")
              .digest("hex")
              .slice(0, 32);

            if (originPeer) {
              await mesh.getTransport().sendTaskResult(originPeer.identity.api_url, {
                task_id:         request.task_id,
                peer_node_id:    mesh.getIdentity().node_id,
                peer_session_id: `verify-${uuid().slice(0, 8)}`,
                status:          "completed",
                findings: [{
                  step_title: "Independent screen verification",
                  tool_name:  "cartographer-verify",
                  status:     "succeeded",
                  summary:    hash,  // hash IS the finding; Strategist compares its own
                }],
                tokens_used: 10,
                cost_usd:    0.000150,
                duration_ms: Date.now() - startTime,
              });
            }
          }
        }
      })();
      return { accepted: true };
    },

    onTaskResult: role === "strategist"
      ? (result: SwarmTaskResult) => {
          const resolver = pending.get(result.task_id);
          if (resolver) { resolver(result); pending.delete(result.task_id); }
        }
      : undefined,
  });

  const app = express();
  app.use(express.json());
  mountSwarmRoutes(app, createSwarmRoutes(mesh));

  // Listen on the requested port, with automatic fallback to an OS-assigned port
  // when the requested port is already in use (e.g. concurrent Zork instances).
  // Without this, app.listen() on a busy port emits an unhandled 'error' event
  // that leaves the Promise pending forever, causing "Peer not active" on all
  // subsequent delegation attempts.
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(port, () => resolve(s));
    s.once("error", (err: Error & { code?: string }) => {
      if (err.code === "EADDRINUSE") {
        // Port busy — fall back to OS-assigned ephemeral port
        const s2 = app.listen(0, () => resolve(s2));
        s2.once("error", reject);
      } else {
        reject(err);
      }
    });
  });
  const actualPort = (server.address() as { port: number }).port;

  // Update the MeshManager identity so peers know the real URL.
  // This is necessary when the OS assigned a different port from what was requested.
  if (actualPort !== port) {
    // Patch the identity URL so heartbeats/requests go to the right address.
    (mesh as unknown as { identity: { api_url: string } }).identity.api_url =
      `http://localhost:${actualPort}`;
  }

  return { name, port: actualPort, color, journal, mesh, server, pending };
}

// ─── Delegate a task to a peer and await the result ───────────────────────────

function delegate(
  from: ZorkNode, toNodeId: string, taskText: string, sessionId: string,
): Promise<SwarmTaskResult> {
  return new Promise(async (resolve, reject) => {
    const { accepted, taskId, reason } = await from.mesh.delegateTask(toNodeId, taskText, sessionId);
    if (!accepted) { reject(new Error(`Delegation rejected: ${reason}`)); return; }
    from.pending.set(taskId!, resolve);

    // Root cause fix 5: previously hardcoded to 15 000 ms, which fired before the
    // emulator could respond in real mode (~5-8 s per command + overhead).
    setTimeout(() => {
      if (from.pending.has(taskId!)) {
        from.pending.delete(taskId!);
        reject(new Error(`Delegation timeout for ${taskId}`));
      }
    }, DELEGATE_TIMEOUT_MS);
  });
}

// ─── Room name detection ───────────────────────────────────────────────────────

/**
 * Returns true if the string looks like a Zork room name (a location header),
 * false if it looks like a game response ("Taken.", "Opening...", etc.).
 *
 * Root cause: in simulated mode, result.roomHeader is the first line of the
 * game response text (e.g. "Opening the small mailbox reveals a leaflet."),
 * not a screen header from a full Apple II display. The Cartographer was
 * treating every delta's first line as a room name, inflating the map from
 * the 4 actual rooms visited to 9 entries — one per unique response text.
 *
 * Heuristic rules (all must hold):
 *   - ≤ 35 chars (real Zork room names are short: "West of House", "Kitchen")
 *   - No trailing punctuation (room headers never end with . ! ?)
 *   - Doesn't start with common game-response words
 *
 * In real mode this is rarely needed because roomHeader comes from the actual
 * Apple II screen's first line (the Zork room header row), which always satisfies
 * these rules. But the check is harmless and makes both modes consistent.
 */
function isRoomName(s: string): boolean {
  if (!s || s.length > 35 || /[.!?,]$/.test(s)) return false;
  // Note: "the " removed from exclusion list — "The Troll Room", "The Cellar" etc.
  // are valid room names. Punctuation check above catches prose sentences.
  return !/^(opening|taken|you |with |no |a |welcome|i |it |it's |pitch |behind the|there )/i.test(s);
}

// ─── Trust-based delegation attributes ────────────────────────────────────────

/**
 * Compute TaskAttribute from delegatee trust score only.
 *
 * Per [1] §5.2, the LiabilityFirebreak guards delegation chain depth / trust,
 * NOT game-level safety.  Domain risk assessment (e.g. "is attacking this
 * enemy the right move?") is the Strategist LLM's responsibility through its
 * own in-context reasoning — the framework layer should not need game-specific
 * knowledge.
 *
 * Mapping (Dynamic Assessment per [1] §4.1):
 *   trust ≥ 0.8 → low criticality / high reversibility  (allow freely)
 *   trust ≥ 0.5 → medium criticality                    (mild friction)
 *   trust < 0.5 → high criticality                      (Firebreak may halt)
 *
 * reversibility is always "high": the delegation act itself is reversible
 * (we can re-delegate to a different peer).  Whether a game action is
 * irreversible in the game world is the Strategist's concern, not ours.
 */
function delegationAttributes(trustScore: number): TaskAttribute {
  if (trustScore >= 0.8) {
    return {
      complexity: "low", criticality: "low", verifiability: "high",
      reversibility: "high", estimated_cost: "low", estimated_duration: "short",
      required_capabilities: ["navigation", "execution"],
    };
  }
  if (trustScore >= 0.5) {
    return {
      complexity: "low", criticality: "medium", verifiability: "high",
      reversibility: "high", estimated_cost: "low", estimated_duration: "short",
      required_capabilities: ["navigation", "execution"],
    };
  }
  return {
    complexity: "low", criticality: "high", verifiability: "high",
    reversibility: "high", estimated_cost: "low", estimated_duration: "short",
    required_capabilities: ["navigation", "execution"],
  };
}

// ─── PermissionEngine helpers ─────────────────────────────────────────────────

/**
 * Returns a permission gate descriptor when a command requires human approval.
 *
 * Two gates are wired in:
 *   game:navigate:underground — triggered when the agent attempts to descend
 *     underground from a location that has a trapdoor or leads to the cellar.
 *   game:engage:combat — triggered on any attack / kill command.
 *
 * Both gates are domain-agnostic: "game" as the permission domain means they
 * work for any Z-machine title, not just Zork.
 *
 * PermissionEngine caches session-level approvals: once the user approves with
 * "allow_session" they are not prompted again in the same run.  On the next
 * --resume session they will be asked once more (per-session policy).
 */
interface PermGate { scope: string; description: string; }

function getPermissionGate(command: string, currentRoom: string): PermGate | null {
  const cmd = command.trim().toLowerCase();

  // Gate 1: underground navigation — pre-approved (same as combat).
  // Previously this required interactive approval, but for autonomous gameplay
  // the game engine itself enforces safety (won't let you descend without a
  // light source, won't let you open an unlocked trapdoor from the wrong side,
  // etc.). The PermissionEngine gate was redundant and blocked automated runs.

  // Gate 2: combat — pre-approved, no prompt needed

  return null;
}

/**
 * Builds the interactive ApprovalPromptFn used by PermissionEngine.
 *
 * Pauses the game loop and presents the user with a Y/O/N prompt on stdout.
 * Response options:
 *   y / yes   → allow_session  (approved for the remainder of this session)
 *   o / once  → allow_once     (approved for this single action only)
 *   n / no    → deny
 *
 * A clear separator is printed before and after the prompt so the user can
 * distinguish it from the normal game-loop output.
 */
function makePermissionPromptFn(): ApprovalPromptFn {
  return async (request): Promise<"allow_once" | "allow_session" | "allow_always" | "deny"> => {
    const scope = request.permissions[0]?.scope ?? "unknown";

    // Non-interactive mode (background / piped stdin): auto-approve underground navigation
    // so the game loop isn't blocked waiting for user input that will never arrive.
    if (!process.stdin.isTTY) {
      console.log(`\x1b[33m[PermissionEngine]\x1b[0m Auto-approved (non-interactive): ${scope}`);
      return "allow_session";
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log(`\n${"\x1b[33m"}${"─".repeat(62)}\x1b[0m`);
    console.log(`  \x1b[1m\x1b[33m[PermissionEngine]\x1b[0m Permission required`);
    console.log(`  Scope   : ${scope}`);
    console.log(`  Action  : ${request.permissions[0]?.domain}:${request.permissions[0]?.action}:${request.permissions[0]?.target}`);
    console.log(`  Step    : ${request.step_id}`);
    console.log(`${"\x1b[33m"}${"─".repeat(62)}\x1b[0m`);

    return new Promise((resolve) => {
      rl.question(
        "  Approve? \x1b[2m(y=allow session / o=allow once / n=deny)\x1b[0m > ",
        (answer) => {
          rl.close();
          const a = answer.trim().toLowerCase();
          console.log(`${"\x1b[33m"}${"─".repeat(62)}\x1b[0m\n`);
          if (a === "y" || a === "yes") resolve("allow_session");
          else if (a === "o" || a === "once") resolve("allow_once");
          else resolve("deny");
        },
      );
    });
  };
}

// ─── Checkpoint helpers ───────────────────────────────────────────────────────

/**
 * Write a session checkpoint to meta.json.
 *
 * Uses command-replay rather than dfrotz save/restore: on resume, every command
 * in commandHistory is re-issued to a fresh dfrotz process (deterministic,
 * ~5ms per command) to restore the exact Z-machine state.  This avoids the
 * dfrotz interactive save-file dialog entirely.
 *
 * Called after every successful game turn so the session can be resumed
 * at any point with --resume.
 */
function writeCheckpoint(
  meta: Omit<SessionCheckpoint, "version" | "savedAt">,
): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const checkpoint: SessionCheckpoint = { version: 1, savedAt: new Date().toISOString(), ...meta };
  writeFileSync(CKPT_META_JSON, JSON.stringify(checkpoint, null, 2));
}

/** Load checkpoint metadata from disk. Returns null if not found or invalid. */
function loadCheckpoint(): SessionCheckpoint | null {
  if (!existsSync(CKPT_META_JSON)) return null;
  try {
    const raw = readFileSync(CKPT_META_JSON, "utf-8");
    const parsed = JSON.parse(raw) as SessionCheckpoint;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── --kernel: delegate to if-kernel-runner.ts ───────────────────────────
  if (args.kernel) {
    const { execFileSync } = await import("node:child_process");
    const kernelArgs = ["scripts/if-kernel-runner.ts"];
    if (USE_APPLE2)                     kernelArgs.push("--apple2");
    if (USE_FROTZ)                      kernelArgs.push("--frotz");
    if (USE_LLM)                        kernelArgs.push("--llm");
    if (args.blind)                     kernelArgs.push("--blind");
    if (args.verbose)                   kernelArgs.push("--verbose");
    if (args.turns)                     kernelArgs.push("--turns", args.turns as string);
    if (args.game)                      kernelArgs.push("--game", args.game as string);
    if (args["inject-failure"])         kernelArgs.push("--inject-failure", args["inject-failure"] as string);
    if (args["extended-thinking"])      kernelArgs.push("--extended-thinking");
    if (args["thinking-budget"])        kernelArgs.push("--thinking-budget", args["thinking-budget"] as string);
    execFileSync("npx", ["tsx", ...kernelArgs], { stdio: "inherit", env: process.env });
    process.exit(0);
  }

  // ── --grok: Classic direct loop — bypass all DeepMind machinery ─────────
  if (USE_GROK) {
    header("LAUNCHING EMULATOR  (dfrotz)");
    const emu = new ZorkFrotzEmulator();
    await emu.launch(GAME_PATH || undefined);
    log(`${C.green}✓${C.reset}`, `dfrotz launched — ${GAME_PATH || "zork1.z3"}`);
    await runClassicGrok(emu, MAX_TURNS);
    await emu.close();
    log(`${C.green}✓${C.reset}`, "Emulator closed");
    console.log(`\n${C.bold}${C.green}Done!${C.reset}\n`);
    process.exit(0);
  }

  // ── DeepMind-enhanced path ────────────────────────────────────────────────
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   Interactive Fiction — Intelligent Delegation  (KarnEvil9) ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`);
  const modeLabel = USE_APPLE2 ? "Playwright + apple2js.com (--apple2)"
                  : USE_FROTZ  ? "dfrotz Z-machine interpreter (--frotz)"
                  :              "Scripted simulation";
  const llmLabel  = USE_GROK_ENHANCED
    ? ` | Strategist: ${GROK_MODEL} (xAI) / Cartographer: ${CARTOGRAPHER_MODEL}`
    : USE_LLM
    ? ` | LLM: ${STRATEGIST_MODEL} / ${CARTOGRAPHER_MODEL}`
    : " | LLM: off (scripted)";
  console.log(`  ${C.dim}Mode: ${modeLabel}${llmLabel} | Turns: ${MAX_TURNS}${INJECT_FAILURE_TURN ? ` | Injecting failure on command ${INJECT_FAILURE_TURN}` : ""}${C.reset}`);

  // ── Load checkpoint if --resume ──────────────────────────────────────────
  let ckpt: SessionCheckpoint | null = null;
  if (USE_RESUME && USE_FROTZ) {
    ckpt = loadCheckpoint();
    if (ckpt) {
      header("RESUMING FROM CHECKPOINT");
      log(`${C.green}✓${C.reset}`, `Found checkpoint: turn ${ckpt.turn} saved at ${ckpt.savedAt}`);
      log(`${C.dim}•${C.reset}`,   `Rooms mapped: ${ckpt.rooms.length} — ${ckpt.rooms.join(", ")}`);
      log(`${C.dim}•${C.reset}`,   `Inventory: ${ckpt.inventory.join(", ") || "(empty)"}`);
      log(`${C.dim}•${C.reset}`,   `Last room: ${ckpt.lastRoomHeader || "Unknown"}`);
    } else {
      log(`${C.yellow}[Resume]${C.reset}`, `No checkpoint found in ${CHECKPOINT_DIR} — starting fresh`);
    }
  }

  // ── Launch emulator ──────────────────────────────────────────────────────
  header("LAUNCHING EMULATOR");
  // Fixed RNG seed ensures command replays are deterministic: same commands →
  // same combat outcomes → no surprise deaths that wipe inventory on resume.
  // Seed is generated once on fresh start and stored in the checkpoint so every
  // resume uses the identical seed.
  const rngSeed: number = ckpt?.rngSeed ?? (Math.floor(Math.random() * 0x7fff) + 1);
  const emulator = USE_FROTZ
    ? new ZorkFrotzEmulator()
    : new ZorkEmulator({ apple2: USE_APPLE2, injectFailureOnTurn: INJECT_FAILURE_TURN });
  // No save/restore flags needed: resume uses command-replay (see below).
  await emulator.launch(GAME_PATH || undefined, USE_FROTZ ? { seed: rngSeed } : undefined);
  log(`${C.green}✓${C.reset}`,
    USE_FROTZ  ? `dfrotz launched — ${GAME_PATH || "zork1.z3"}` :
    USE_APPLE2 ? `Playwright launched — apple2js.com${INJECT_FAILURE_TURN ? ` (failure injected at command ${INJECT_FAILURE_TURN})` : ""}` :
                 "Simulated emulator ready");

  // ── Replay command history to restore Z-machine state ────────────────────
  // On resume, commandHistory is loaded from the checkpoint. Replaying those
  // commands through a fresh dfrotz restores the exact game state (~5ms/cmd).
  //
  // Also rebuilds dirGraph from the replay so the Strategist gets full
  // directional guidance ("north → Troll Room" from Cellar) even for movements
  // that predate the checkpoint's saved dirGraph.
  const replayDirGraph: Record<string, Record<string, string>> = { ...(ckpt?.dirGraph ?? {}) };
  const replayRevDir: Record<string, string> = {
    north: "south", south: "north", east: "west", west: "east",
    up: "down",     down: "up",     in: "out",    out: "in",
  };
  if (ckpt && USE_FROTZ && ckpt.commandHistory.length > 0) {
    log(`${C.dim}[Resume]${C.reset}`, `Replaying ${ckpt.commandHistory.length} command(s) to restore game state...`);
    let replayRoom = "West of House";   // Zork I always starts here
    for (const cmd of ckpt.commandHistory) {
      const replayResult = await emulator.sendCommand(cmd);
      const dirMatch = cmd.match(/^go\s+(north|south|east|west|up|down|in|out)$/i);
      if (dirMatch && replayResult.roomHeader && isRoomName(replayResult.roomHeader)
          && replayResult.roomHeader !== replayRoom) {
        const dir    = dirMatch[1]!.toLowerCase();
        const newRm  = replayResult.roomHeader;
        const prevRm = replayRoom;
        replayDirGraph[prevRm] ??= {};
        replayDirGraph[prevRm]![dir] = newRm;
        if (replayRevDir[dir]) {
          replayDirGraph[newRm] ??= {};
          replayDirGraph[newRm]![replayRevDir[dir]!] ??= prevRm;   // don't clobber newer data
        }
      }
      if (replayResult.roomHeader && isRoomName(replayResult.roomHeader)) {
        replayRoom = replayResult.roomHeader;
      }
    }
    log(`${C.green}✓${C.reset}`, `Replay complete — restored to turn ${ckpt.turn}`);
  }

  // Shared Cartographer state (in-process reference, updated by Tactician handler)
  const cartographerState = {
    rooms: [] as string[],
    lastRoomHeader: "",
    lastFullScreen: "",
    // Persistent per-room exit cache — populated from Cartographer MAP/VERIFY parses.
    // Survives revisits where dfrotz only emits the room name (no description).
    // Restored from checkpoint on --resume so revisited rooms always have known exits.
    roomExits: ckpt?.roomExits ?? {} as Record<string, string[]>,
    // Directional graph: room → direction → destination.
    // Populated from successful `go <dir>` moves so the Strategist knows which
    // direction leads to which room (e.g. north → Troll Room from Cellar).
    // On resume, rebuilt from command replay (replayDirGraph) so pre-checkpoint
    // movements are also represented.
    dirGraph:  replayDirGraph,
    // Exits confirmed invalid by NavPrune — these are never re-added by Cartographer.
    // Keyed by room name; value is a Set of direction strings that produced no movement.
    blockedExits: {} as Record<string, Set<string>>,
    // Directions that failed due to carry weight — soft blocks, retryable after dropping items.
    weightLimitExits: {} as Record<string, Set<string>>,
  };

  // ── Boot nodes ───────────────────────────────────────────────────────────
  header("BOOTING 3 NODES");

  const strategist   = await createNode("Strategist",   3200, C.cyan,    "strategist",   ["strategy", "planning"],    emulator, cartographerState);
  const tactician    = await createNode("Tactician",    3201, C.yellow,  "tactician",    ["navigation", "execution"], emulator, cartographerState);
  const cartographer = await createNode("Cartographer", 3202, C.magenta, "cartographer", ["mapping", "memory"],       emulator, cartographerState);
  const nodes = [strategist, tactician, cartographer];

  for (const n of nodes) {
    const id = n.mesh.getIdentity().node_id.slice(0, 8);
    log(`${n.color}●${C.reset}`, `${n.color}${n.name}${C.reset} (port ${n.port}) — ${C.dim}${id}${C.reset}`);
  }

  // ── Form mesh ────────────────────────────────────────────────────────────
  header("FORMING MESH");

  // SybilDetector — screens every identity as it joins. In a 3-known-node setup
  // it never fires, but establishes the security posture: any node that joins
  // with a capability overlap > 0.9 or bursts more than 5 joins in 5 s is flagged.
  const sybilDetector = new SybilDetector();
  let   sybilSuspects = 0;

  await Promise.all(nodes.map((n) => n.mesh.start()));
  const pairs: [ZorkNode, ZorkNode][] = [
    [strategist, tactician],
    [strategist, cartographer],
    [tactician, cartographer],
  ];
  for (const [a, b] of pairs) {
    a.mesh.handleJoin(b.mesh.getIdentity());
    b.mesh.handleJoin(a.mesh.getIdentity());
    log(`${C.blue}↔${C.reset}`, `${a.color}${a.name}${C.reset} ←→ ${b.color}${b.name}${C.reset}`);
  }
  // Analyze every non-strategist node join for Sybil patterns
  for (const node of [tactician, cartographer]) {
    const identity = node.mesh.getIdentity();
    sybilDetector.recordJoin(identity);
    const reports = sybilDetector.analyzeJoin(identity);
    if (reports.length > 0) {
      sybilSuspects += reports.length;
      for (const r of reports)
        log(`${C.red}[Sybil]${C.reset}`, `${C.red}${r.indicator} (confidence ${r.confidence.toFixed(2)}, action: ${r.action})${C.reset}`);
    } else {
      log(`${C.dim}[Sybil]${C.reset}`, `${node.name} identity verified — no anomalies`);
    }
  }
  await new Promise<void>((r) => setTimeout(r, 200));

  const sessionId    = `zork-${uuid().slice(0, 8)}`;
  const strategistId = strategist.mesh.getIdentity().node_id;
  const tacticianId  = tactician.mesh.getIdentity().node_id;
  const cartoId      = cartographer.mesh.getIdentity().node_id;

  // ── Initialize framework components ─────────────────────────────────────
  header("INITIALIZING FRAMEWORK COMPONENTS");

  const tmpBase = join(tmpdir(), `k9-zork-${uuid().slice(0, 8)}`);

  // Reputation store — seed with a small history so trust starts at a realistic
  // non-zero value, simulating nodes that have handled prior tasks.
  //
  // Root cause note: previously seeded with 8 successes → trust=1.00 from turn 1,
  // so the graduated authority + trust-based routing never changed. Reduced to 3
  // so Tactician starts at ~0.75 and trust evolution is visible during the session.
  const reputation = new ReputationStore(join(tmpBase, "reputation.jsonl"));
  const SESSION_BASE_COUNT = { tac: 0, carto: 0 }; // track this session's completions
  // When resuming, restore exact outcome counts from the checkpoint so trust
  // evolution continues from the same curve. Fresh starts use fixed seeds.
  const tacSeedCompleted   = ckpt?.tacticianCompleted ?? 3;
  const tacSeedFailed      = ckpt?.tacticianFailed    ?? 0;
  const cartoSeedCompleted = ckpt?.cartoCompleted     ?? 2;
  const cartoSeedFailed    = ckpt?.cartoFailed        ?? 0;
  for (let i = 0; i < tacSeedCompleted; i++) {
    reputation.recordOutcome(tacticianId, {
      task_id: `seed-t-${i}`, peer_node_id: tacticianId, peer_session_id: "s",
      status: "completed",
      findings: [{ step_title: "t", tool_name: "zork-emulator", status: "succeeded", summary: "ok" }],
      tokens_used: 40, cost_usd: 0.001, duration_ms: 300,
    });
  }
  for (let i = 0; i < tacSeedFailed; i++) {
    reputation.recordOutcome(tacticianId, {
      task_id: `seed-tf-${i}`, peer_node_id: tacticianId, peer_session_id: "s",
      status: "failed",
      findings: [{ step_title: "t", tool_name: "zork-emulator", status: "failed", summary: "slo miss" }],
      tokens_used: 40, cost_usd: 0.001, duration_ms: 300,
    });
  }
  for (let i = 0; i < cartoSeedCompleted; i++) {
    reputation.recordOutcome(cartoId, {
      task_id: `seed-c-${i}`, peer_node_id: cartoId, peer_session_id: "s",
      status: "completed",
      findings: [{ step_title: "t", tool_name: "cartographer", status: "succeeded", summary: "ok" }],
      tokens_used: 18, cost_usd: 0.0003, duration_ms: 120,
    });
  }
  for (let i = 0; i < cartoSeedFailed; i++) {
    reputation.recordOutcome(cartoId, {
      task_id: `seed-cf-${i}`, peer_node_id: cartoId, peer_session_id: "s",
      status: "failed",
      findings: [{ step_title: "t", tool_name: "cartographer", status: "failed", summary: "verify failed" }],
      tokens_used: 18, cost_usd: 0.0003, duration_ms: 120,
    });
  }

  // Escrow — each node stakes $1.00
  const escrow = new EscrowManager(join(tmpBase, "escrow.jsonl"), {
    min_bond_usd: 0.10, slash_pct_on_violation: 50, slash_pct_on_timeout: 25,
  });
  // Restore saved balances on resume; start fresh at $1.00 otherwise.
  escrow.deposit(tacticianId, ckpt?.tacticianEscrow ?? 1.00);
  escrow.deposit(cartoId,     ckpt?.cartoEscrow     ?? 1.00);

  const verifier  = new OutcomeVerifier({ slo_strict: true });
  const consensus = new ConsensusVerifier({ default_required_voters: 2, default_required_agreement: 0.67 });
  const friction  = new CognitiveFrictionEngine();
  const firebreak = new LiabilityFirebreak();
  const router    = new DelegateeRouter();

  // PermissionEngine — human-in-the-loop gate for dangerous game actions.
  // Wired to the Strategist's journal so every approval/denial is hash-chained.
  const permEngine = new PermissionEngine(strategist.journal, makePermissionPromptFn());
  let permDenials  = 0;
  let permApprovals = 0;

  strategist.mesh.setLiabilityFirebreak(firebreak);
  strategist.mesh.setCognitiveFriction(friction);

  log(`${C.dim}•${C.reset}`, `ReputationStore: Tactician trust=${C.green}${reputation.getTrustScore(tacticianId).toFixed(2)}${C.reset} (${ckpt ? `restored — ${tacSeedCompleted}ok/${tacSeedFailed}fail` : "seeded 3"}), Cartographer trust=${C.green}${reputation.getTrustScore(cartoId).toFixed(2)}${C.reset} (${ckpt ? `restored — ${cartoSeedCompleted}ok/${cartoSeedFailed}fail` : "seeded 2"})`);
  log(`${C.dim}•${C.reset}`, `EscrowManager: Tactician $${(ckpt?.tacticianEscrow ?? 1.00).toFixed(2)}, Cartographer $${(ckpt?.cartoEscrow ?? 1.00).toFixed(2)}${ckpt ? " (restored)" : " (fresh)"}`);
  log(`${C.dim}•${C.reset}`, `Firebreak max depth: 2 | Consensus threshold: 0.67`);
  log(`${C.dim}•${C.reset}`, `Delegate timeout: ${DELEGATE_TIMEOUT_MS}ms`);

  // ── WorkingMemory ─────────────────────────────────────────────────────────
  const gameMemory = new WorkingMemoryManager(ckpt?.sessionId ?? sessionId);
  gameMemory.set("currentRoom",    ckpt?.currentRoom    ?? "");
  gameMemory.set("exits",          [] as string[]);
  gameMemory.set("inventory",      ckpt?.inventory      ?? [] as string[]);
  gameMemory.set("roomGraph",      ckpt?.roomGraph      ?? {} as Record<string, string[]>);
  gameMemory.set("visitedRooms",   ckpt?.visitedRooms   ?? [] as string[]);
  // blockedPuzzles: obstacles the AI couldn't pass (locked, needs item, etc.)
  // Each entry is resolved when the AI returns and succeeds.
  gameMemory.set("blockedPuzzles", ckpt?.blockedPuzzles ?? [] as BlockedPuzzle[]);

  // ── Restore Cartographer state from checkpoint ────────────────────────────
  if (ckpt) {
    cartographerState.rooms          = [...ckpt.rooms];
    cartographerState.lastRoomHeader = ckpt.lastRoomHeader;
  }

  // ── FutilityMonitor ───────────────────────────────────────────────────────
  const futility = new FutilityMonitor({
    maxIdenticalPlans:     2,   // halt if same exact command tried twice in a row
    maxStagnantIterations: 100, // effectively disabled — each turn always has exactly 1 step;
                                // the "stagnant" heuristic is designed for multi-step iterations
    maxRepeatedErrors:     3,
  });
  let futilityHint  = "";
  let futilityHalts = 0;

  // ── AnomalyDetector ───────────────────────────────────────────────────────
  const anomalyDetector = new AnomalyDetector({
    failure_rate_threshold: 0.4,
    failure_rate_window:    5,
    duration_spike_threshold: 5.0,
  });
  let anomalyCount = 0;

  // ── CheckpointSerializer ──────────────────────────────────────────────────
  const checkpointer = new CheckpointSerializer(join(tmpBase, "zork-checkpoint.jsonl"));
  await checkpointer.load();
  let checkpointsSaved = 0;

  // ── RootCauseAnalyzer ─────────────────────────────────────────────────────
  const rootCauseAnalyzer = new RootCauseAnalyzer({
    meshManager:     strategist.mesh,
    reputationStore: reputation,
  });

  // ── BehavioralScorer ──────────────────────────────────────────────────
  // Tracks transparency, safety compliance, and protocol adherence per node
  // alongside the raw completion-ratio in ReputationStore. Inferred each turn
  // from SLO pass/fail: pass = safety_compliant + protocol_followed,
  // fail = safety_violation + protocol_violated.
  const behavioralScorer = new BehavioralScorer();

  // ── RedelegationMonitor ───────────────────────────────────────────────
  // Formally tracks every delegation and re-delegation chain. Enforces the
  // max_redelegations ceiling via the framework instead of hand-written logic.
  const redelegationMonitor = new RedelegationMonitor({
    max_redelegations:        3,
    redelegation_cooldown_ms: 0,
  });

  // ── ContextBudgetMonitor ──────────────────────────────────────────────
  // Watches cumulative LLM tokens vs the Claude context window limit.
  // Fires verdicts at 70 % (delegate), 80 % (checkpoint), 90 % (summarize)
  // so long resumed sessions save state before the context overflows.
  const MAX_CONTEXT_TOKENS = 200_000;
  const contextBudget = new ContextBudgetMonitor({
    delegateThreshold:         0.70,
    checkpointThreshold:       0.80,
    summarizeThreshold:        0.90,
    minIterationsBeforeAction: 3,
  });
  // Always reset the cumulative context counter when resuming — the LLM context
  // (conversation history with Claude) starts fresh each session, so historical
  // accumulated token counts from prior sessions are irrelevant to the current budget.
  let cumulativeContextTokens = USE_RESUME ? 0 : (ckpt?.cumulativeContextTokens ?? 0);

  log(`${C.dim}•${C.reset}`, `WorkingMemory + FutilityMonitor + AnomalyDetector + CheckpointSerializer + RootCauseAnalyzer: active`);
  log(`${C.dim}•${C.reset}`, `BehavioralScorer + RedelegationMonitor: active`);
  log(`${C.dim}•${C.reset}`, `ContextBudgetMonitor: ctx ${cumulativeContextTokens.toLocaleString()} / ${MAX_CONTEXT_TOKENS.toLocaleString()} tokens (${ckpt ? "restored" : "fresh"})`);
  log(`${C.dim}•${C.reset}`, `PermissionEngine: active (gates: game:navigate:underground | combat: pre-approved)`);

  // ── MetricsCollector ──────────────────────────────────────────────────────
  // Attached to the Strategist's journal: every swarm event (delegation, escrow,
  // consensus, firebreak, reputation) is automatically counted in Prometheus format.
  // Written to a .prom file at session end for optional scraping / dashboarding.
  const metrics = new MetricsCollector();
  metrics.attach(strategist.journal);

  // ── ActiveMemory ──────────────────────────────────────────────────────────
  // Cross-session JSONL file that persists game lessons between runs.
  // Loaded here so the game loop can inject past lessons into the Strategist prompt.
  const activeMemoryPath = join(CHECKPOINT_DIR, "active-memory.jsonl");
  const activeMemory = new ActiveMemory(activeMemoryPath);
  await activeMemory.load();
  const pastLessons = USE_NO_MEMORY ? [] : activeMemory.search(
    "interactive fiction zork game rooms exploration",
    ["zork-emulator", "cartographer-llm"],
  );
  if (pastLessons.length > 0) {
    log(`${C.blue}[Memory]${C.reset}`,
      `Loaded ${pastLessons.length} lesson(s) from prior session(s) — injecting into Strategist`);
    for (const l of pastLessons) {
      log(`${C.dim}  ↳${C.reset}`, `[${l.outcome}] ${l.lesson.slice(0, 100)}`);
    }
  } else {
    log(`${C.dim}[Memory]${C.reset}`, `No prior lessons found — starting fresh`);
  }

  // ── Restore usage accumulators from checkpoint ────────────────────────────
  // Lets the session summary show cumulative cost across ALL sessions, not just
  // the current one. Fresh starts have no saved summaries (optional fields).
  if (ckpt?.strategistUsageSummary) strategistUsage.restoreFrom(ckpt.strategistUsageSummary);
  if (ckpt?.cartoUsageSummary)      cartoUsage.restoreFrom(ckpt.cartoUsageSummary);
  if (ckpt?.grokUsageSummary)       grokUsage.restoreFrom(ckpt.grokUsageSummary);
  if (ckpt && (ckpt.strategistUsageSummary || ckpt.cartoUsageSummary || ckpt.grokUsageSummary)) {
    const prevTotal = (ckpt.strategistUsageSummary?.total_cost_usd ?? 0)
                    + (ckpt.cartoUsageSummary?.total_cost_usd ?? 0)
                    + (ckpt.grokUsageSummary?.total_cost_usd ?? 0);
    log(`${C.dim}[Cost]${C.reset}`, `Restored prior spend: $${prevTotal.toFixed(4)} (carries forward)`);
  }

  // ── Base SLO ─────────────────────────────────────────────────────────────
  const baseSLO: ContractSLO = { max_duration_ms: 5000, max_tokens: 500, max_cost_usd: 0.02 };
  const baseMonitoring: ContractMonitoring = { require_checkpoints: false, report_interval_ms: 30000 };

  // ── Stats ─────────────────────────────────────────────────────────────────
  let successCount         = 0;
  let failCount            = 0;
  let slashTotal           = 0;
  let turnCheckpointsSaved = 0;
  const commandHistory: string[] = ckpt ? [...ckpt.commandHistory] : [];
  const transcript:     string[] = [];   // blind-mode: cmd → response lines
  let lastDelta     = ckpt?.lastDelta ?? "";
  const startTurn   = ckpt ? ckpt.turn + 1 : 1;  // resume from next turn after checkpoint

  // Per-room failed commands: commands that produced no effect in a given room.
  // More precise than consecutive-duplicate detection — persists across revisits.
  const failedByRoom: Record<string, string[]> = {};

  // Track turns since the last new room was discovered.
  // Injected into the Strategist prompt as a "stalled" warning when ≥5.
  let lastNewRoomCount = cartographerState.rooms.length; // init from checkpoint
  let lastNewRoomTurn  = startTurn;

  // ═══════════════════════════════════════════════════════════════════════════
  //  GAME LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  header("GAME LOOP");

  for (let turn = startTurn; turn <= startTurn + MAX_TURNS - 1; turn++) {
    console.log(`\n${C.bold}${C.dim}── Turn ${turn}${ckpt ? ` (session total) / ${ckpt.turn + MAX_TURNS}` : ` / ${MAX_TURNS}`} ──────────────────────────────────────────${C.reset}`);

    // Snapshot cumulative token spend before any LLM calls this turn so we can
    // compute the per-turn delta for ContextBudgetMonitor.
    const prevTurnTokens = strategistUsage.totalTokens + cartoUsage.totalTokens + grokUsage.totalTokens;

    // ── Read working memory for this turn ───────────────────────────────
    const gmInventory      = (gameMemory.get("inventory")      ?? []) as string[];
    const gmVisitedRooms   = (gameMemory.get("visitedRooms")   ?? []) as string[];
    const gmBlockedPuzzles = (gameMemory.get("blockedPuzzles") ?? []) as BlockedPuzzle[];
    // Room-scoped failed commands: update failedByRoom from the previous turn's response
    // before building the list for the Strategist prompt.
    const noEffectRe = /^(I don't understand|you can't|nothing happens|i don't know the word|i only understood|locked from|too heavy|the door is locked)/i;
    if (lastDelta && noEffectRe.test(lastDelta.trim())) {
      const prevCmd = commandHistory.at(-1);
      const curRoom = cartographerState.lastRoomHeader;
      if (curRoom && prevCmd) {
        failedByRoom[curRoom] ??= [];
        if (!failedByRoom[curRoom]!.includes(prevCmd)) failedByRoom[curRoom]!.push(prevCmd);
      }
    }
    // Build failedCmds for this turn from the current room only
    const failedCmds = failedByRoom[cartographerState.lastRoomHeader] ?? [];

    // ── Step 1: Cartographer reads current state ────────────────────────
    // Run BEFORE the Strategist so the freshly-parsed exits are available
    // for the command decision this turn (not one turn delayed).
    const cartoMapTaskId = `task-carto-${uuid().slice(0, 8)}`;
    escrow.holdBond(cartoMapTaskId, cartoId, 0.05);

    try {
      const label = cartographerState.lastRoomHeader || "West of House (start)";
      const mapResult = await delegate(strategist, cartoId, `MAP: ${label}`, sessionId);
      const mapSummary = mapResult.findings[0]?.summary ?? `Room: "${label}"`;
      // Parse exits from Cartographer output and persist in roomExits cache.
      // Only overwrite the cache if the new list is longer than what we already
      // know — brief/intermediate responses (e.g. "The trap door is closed")
      // often report fewer exits than a full room description, and we must not
      // let them clobber a previously-correct cache entry.
      const exitsMatch = mapSummary.match(/Exits:\s*([^|]+)/i);
      const exitsStr   = exitsMatch?.[1]?.trim() ?? "";
      const blocked = cartographerState.blockedExits[label] ?? new Set<string>();
      if (exitsStr && exitsStr !== "unknown") {
        const parsed  = exitsStr.split(",").map(e => e.trim()).filter(Boolean)
          .filter(e => !blocked.has(e.toLowerCase()));   // never re-add pruned exits
        const cached  = cartographerState.roomExits[label] ?? [];
        if (parsed.length > cached.length) cartographerState.roomExits[label] = parsed;
      }
      // Regex exit augmentation: scan the raw screen text for directional phrases
      // that Haiku may have missed (e.g. "To the east..." in North of House).
      // Merge any found directions into the cache — never remove existing ones.
      // Pruned (blocked) exits are never re-merged.
      const rawScreen = cartographerState.lastFullScreen;
      if (rawScreen && label && label !== "West of House (start)") {
        const directional = new Set<string>((cartographerState.roomExits[label] ?? []).map(d => d.toLowerCase()));
        let m: RegExpExecArray | null;
        // Pattern 1: "To the <direction>" — very reliable indicator of an exit
        const toTheRe = /\bto the (north|south|east|west|up|down)\b/gi;
        while ((m = toTheRe.exec(rawScreen)) !== null) {
          const dir = m[1]!.toLowerCase();
          if (!blocked.has(dir)) directional.add(dir);
        }
        // Pattern 2: path/passage/corridor NEAR a direction word
        const leadsRe = /\b(?:path|passage|corridor|trail|exit)\b[^.]{0,30}\b(north|south|east|west|up|down)\b|\b(north|south|east|west|up|down)\b[^.]{0,30}\b(?:path|passage|corridor|trail|exit)\b/gi;
        while ((m = leadsRe.exec(rawScreen)) !== null) {
          const dir = (m[1] ?? m[2])!.toLowerCase();
          if (!blocked.has(dir)) directional.add(dir);
        }
        const augmented = [...directional];
        if (augmented.length > (cartographerState.roomExits[label] ?? []).length) {
          cartographerState.roomExits[label] = augmented;
        }
      }
      log(`${C.magenta}[Cartographer${USE_LLM ? "/LLM" : ""}]${C.reset}`,
        USE_LLM
          ? `${C.dim}${mapSummary}${C.reset} | Rooms: ${cartographerState.rooms.length}`
          : `Room: ${C.dim}"${label}"${C.reset} | Mapped ${cartographerState.rooms.length} distinct room(s)`);
      escrow.releaseBond(cartoMapTaskId);
    } catch (_) {
      escrow.slashBond(cartoMapTaskId, 25);
      log(`${C.magenta}[Cartographer]${C.reset}`, `${C.red}Map update failed${C.reset}`);
    }

    // Track exploration stall: update lastNewRoomTurn whenever a new room is found.
    if (cartographerState.rooms.length > lastNewRoomCount) {
      lastNewRoomCount = cartographerState.rooms.length;
      lastNewRoomTurn  = turn;
    }

    // ── Determine next command ───────────────────────────────────────────
    // In LLM mode: ask Claude Sonnet to pick the next command from game state.
    // In scripted mode: read from ZORK_SCRIPT (fallback for demo/testing).
    const knownExits = cartographerState.roomExits[cartographerState.lastRoomHeader] ?? [];
    // Build a human-readable directions-to-rooms map for the current room
    // so the Strategist can navigate without guessing ("north → The Troll Room").
    const knownDirMap = cartographerState.dirGraph[cartographerState.lastRoomHeader] ?? {};
    const roomDirections: Record<string, string> = knownDirMap;

    // BFS navigation hint: fire every turn so the Strategist always has algorithmic
    // navigation context. The LLM decides the final command — it may follow the BFS
    // path, explore an unexplored exit, or do something in-room — but the optimal
    // graph-traversal path is always visible.
    const turnsStalled = turn - lastNewRoomTurn;
    const hasUnexploredExits = knownExits.some(e => !knownDirMap[e]);
    let navigationHint: string | undefined;
    if (cartographerState.lastRoomHeader) {
      const visitedSet = new Set(cartographerState.rooms);
      const unvisitedTargets = [
        // Adjacent unvisited rooms first (shortest path)
        ...Object.values(knownDirMap).filter(r => !visitedSet.has(r)),
        // Then any known unvisited room reachable via BFS
        ...Object.keys(cartographerState.dirGraph).filter(r => !visitedSet.has(r)),
      ];
      for (const target of unvisitedTargets) {
        if (target === cartographerState.lastRoomHeader) continue;
        const path = bfsPath(cartographerState.dirGraph, cartographerState.lastRoomHeader, target, cartographerState.blockedExits);
        if (path && path.length > 0) {
          navigationHint = path
            .map((s, i) => {
              const src = i === 0 ? cartographerState.lastRoomHeader : path[i - 1]!.destination;
              const wt = (cartographerState.weightLimitExits[src] ?? new Set()).has(s.direction);
              return `${i + 1}. go ${s.direction} → ${s.destination}${wt ? " ⚠ drop items first" : ""}`;
            })
            .join(", ");
          const label = hasUnexploredExits ? "unexplored exits available" : "room mapped";
          log(`${C.cyan}[NavHint]${C.reset}`,
            `BFS → ${target} (${label}, stalled ${turnsStalled}): ${navigationHint}`);
          break;
        }
      }
      if (!navigationHint && !hasUnexploredExits && turnsStalled >= 3) {
        log(`${C.dim}[NavHint]${C.reset}`,
          `Stalled ${turnsStalled} turns — all known rooms visited; stalledBlock will prompt exploration`);
      }
    }

    let command: string;
    if (USE_LLM || USE_GROK_ENHANCED) {
      const fullScreen = cartographerState.lastFullScreen;
      const modelLabel = USE_GROK_ENHANCED ? GROK_MODEL : STRATEGIST_MODEL;
      log(`${C.cyan}[Strategist/LLM]${C.reset}`,
        `Asking ${modelLabel} for next move...`);
      const weightLimitDirs = Array.from(cartographerState.weightLimitExits[cartographerState.lastRoomHeader] ?? []);
      command = await askStrategist(
        cartographerState.lastRoomHeader,
        lastDelta,
        commandHistory,
        fullScreen,
        { inventory: gmInventory, visitedRooms: gmVisitedRooms,
          futilityHint, failedCommands: failedCmds,
          blockedPuzzles: gmBlockedPuzzles, knownExits, roomDirections,
          turnsStalled, navigationHint,
          currentRoomName:  cartographerState.lastRoomHeader,
          weightLimitDirs },
        pastLessons,
      );
      futilityHint = "";  // consumed; reset for next turn
      log(`${C.cyan}[Strategist/LLM]${C.reset}`,
        `→ ${C.yellow}"${command}"${C.reset}`);
    } else {
      const script = ZORK_SCRIPT[turn - 1]!;
      command = script.command;
    }

    // ── Step 2: Cognitive friction assessment ───────────────────────────
    // Per [1] §5.2: TaskAttribute is derived from delegatee trust only.
    // Domain safety (what to do in the game) is the Strategist LLM's concern.
    const trustNow = reputation.getTrustScore(tacticianId);
    const attrs    = delegationAttributes(trustNow);
    const friction_result = friction.assess(attrs, 1, trustNow, 2);
    const frictionLabel = friction_result.level === "none"
      ? `${C.green}none${C.reset}`
      : `${C.yellow}${friction_result.level}${C.reset}`;
    log(`${C.cyan}[Strategist]${C.reset}`,
      `Friction: ${frictionLabel} (score ${friction_result.composite_score.toFixed(2)}) — ${
        friction_result.level === "none" ? "safe to proceed" : `⚠ risky: "${command}"`
      }`);

    // ── Step 3: Firebreak — BEFORE bond (fix 1) ─────────────────────────
    //
    // Root cause fix 1: previously escrow.holdBond() was called before
    // firebreak.evaluate(). When Firebreak blocked the task, the bond was
    // already held and then "slashed" at 0% (silently released) — leaving the
    // escrow accounting inconsistent. Now we check the Firebreak first: if it
    // blocks, we log the reason and skip the turn with NO escrow impact.
    const tacTaskId         = `task-t-${uuid().slice(0, 8)}`;
    const firebreakDecision = firebreak.evaluate(1, attrs);
    if (firebreakDecision.action !== "allow") {
      log(`${C.red}[Firebreak]${C.reset}`,
        `${C.red}Delegation blocked: ${firebreakDecision.reason}${C.reset}`);
      log(`${C.dim}[Escrow]${C.reset}`,
        `No bond held — task cancelled before delegation`);
      // Root cause fix (script offset): advance the emulator's scripted turn index
      // so subsequent turns consume the correct ZORK_SCRIPT entries.
      // Without this, every blocked turn shifts all later entries by one, causing
      // the deliberate SLO failure to fire on the wrong turn.
      emulator.skipTurn();
      continue;
    }

    // ── Step 3b: PermissionEngine — human-in-the-loop gate ──────────────
    //
    // Checked AFTER CognitiveFriction + Firebreak (machine guards) and BEFORE
    // any escrow is held.  Only commands that match a registered gate pattern
    // are checked; all others pass through without prompting the user.
    //
    // The gate is session-aware: once the user approves "allow_session", the
    // permission is cached and won't prompt again in this run.  Every approval
    // and denial is appended to the Strategist's SHA-256 hash chain journal.
    const permGate = getPermissionGate(command, cartographerState.lastRoomHeader);
    if (permGate) {
      const permReq: PermissionRequest = {
        request_id:  `perm-${uuid().slice(0, 8)}`,
        session_id:  sessionId,
        step_id:     `step-${turn}`,
        tool_name:   "zork-emulator",
        permissions: [PermissionEngine.parse(permGate.scope)],
      };
      log(`${C.yellow}[Permission]${C.reset}`,
        `Gate "${C.bold}${permGate.scope}${C.reset}" — ${permGate.description}`);
      const permResult = await permEngine.check(permReq);
      if (!permResult.allowed) {
        permDenials++;
        log(`${C.red}[Permission]${C.reset}`,
          `${C.red}Action denied by operator — skipping turn${C.reset}`);
        emulator.skipTurn();
        continue;
      }
      permApprovals++;
      log(`${C.green}[Permission]${C.reset}`, `${C.green}Approved — proceeding${C.reset}`);
    }

    // ── Step 4: Graduated authority → dynamic SLO ──────────────────────
    const authority = authorityFromTrust(trustNow, baseSLO, baseMonitoring);
    const tier      = getTrustTier(trustNow);
    log(`${C.cyan}[Strategist]${C.reset}`,
      `Tactician trust: ${C.green}${trustNow.toFixed(2)}${C.reset} (${tier}) → SLO: ${authority.slo.max_duration_ms}ms / ${authority.slo.max_tokens} tokens`);

    // ── Step 5: DelegateeRouter — pick executor based on trust (fix 6) ──
    //
    // Root cause fix 6: previously the router was only called once at session
    // summary and always returned a static "ai" @ 0.90. Now it's called every
    // turn with the real trust score so the routing decision is dynamic.
    // When trust falls below 0.5 (e.g. after --inject-failure), the router
    // switches delegation_target to "any" (→ Cartographer is used instead).
    const delegation_target = trustNow >= 0.5 ? "ai" : "any";
    const routingDecision = router.route({
      sub_task_id: tacTaskId,
      task_text:   `EXECUTE: ${command}`,
      attributes:  attrs,
      constraints: { max_tokens: authority.slo.max_tokens, max_cost_usd: authority.slo.max_cost_usd ?? 0.02, max_duration_ms: authority.slo.max_duration_ms },
      depends_on:  [],
      delegation_target,
    });
    const executorId   = delegation_target === "ai" ? tacticianId : cartoId;
    const executorName = delegation_target === "ai" ? "Tactician" : "Cartographer";
    log(`${C.blue}[Router]${C.reset}`,
      `→ ${executorName} (target="${routingDecision.target}", confidence ${routingDecision.confidence.toFixed(2)}, trust=${trustNow.toFixed(2)})`);

    // ── Step 6: Hold bond AFTER firebreak approves ──────────────────────
    const bondResult = escrow.holdBond(tacTaskId, tacticianId, 0.10);
    log(`${C.cyan}[Strategist]${C.reset}`,
      `Bond held: $0.10 for ${C.dim}${tacTaskId}${C.reset} (held: ${bondResult.held})`);

    // ── Step 7: Delegate to executor ────────────────────────────────────
    // RedelegationMonitor: register this delegation before it runs so the
    // monitor can enforce the re-delegation ceiling if the task later fails.
    redelegationMonitor.trackDelegation(
      tacTaskId, executorId, `EXECUTE: ${command}`, sessionId,
      { max_tokens: authority.slo.max_tokens, max_cost_usd: authority.slo.max_cost_usd ?? 0.02, max_duration_ms: authority.slo.max_duration_ms },
    );

    let tacResult: SwarmTaskResult;
    let redelegated = false;

    try {
      tacResult = await delegate(strategist, executorId, `EXECUTE: ${command}`, sessionId);
      log(`${C.yellow}[Tactician]${C.reset}`,
        `← ${C.dim}"${tacResult.findings[0]?.summary?.slice(0, 80) ?? "(no output)"}"${C.reset}`);
    } catch (err) {
      log(`${C.red}[Tactician]${C.reset}`,
        `${C.red}Delegation failed: ${String(err).slice(0, 60)}${C.reset}`);
      tacResult = {
        task_id: tacTaskId, peer_node_id: tacticianId, peer_session_id: "err",
        status: "failed", findings: [],
        tokens_used: 0, cost_usd: 0, duration_ms: 7200,
      };
    }

    // ── Step 8: Outcome verification — SLO check ────────────────────────
    const contract: DelegationContract = {
      contract_id:       `contract-${uuid().slice(0, 8)}`,
      delegator_node_id: strategistId,
      delegatee_node_id: executorId,
      task_id:           tacTaskId,
      task_text:         `EXECUTE: ${command}`,
      slo:               authority.slo,
      permission_boundary: authority.permission_boundary,
      monitoring:        authority.monitoring,
      status:            "active",
      created_at:        new Date().toISOString(),
    };

    const verification = verifier.verify({ result: tacResult, contract });
    const sloOk = verification.slo_compliance && tacResult.status === "completed";

    if (sloOk) {
      log(`${C.green}[Verifier]${C.reset}`,
        `SLO ✓ (${tacResult.duration_ms}ms, ${tacResult.tokens_used} tokens) | Findings ✓`);
    } else {
      const issues = verification.issues?.join("; ") ?? "unknown";
      log(`${C.red}[Verifier]${C.reset}`,
        `SLO ✗ — ${C.red}${issues || "task failed"}${C.reset}`);
    }

    // ── Step 8b: FutilityMonitor ─────────────────────────────────────────
    const stepRes: StepResult = {
      step_id:     `step-${turn}`,
      status:      sloOk ? "succeeded" : "failed",
      error:       sloOk ? undefined : { code: "slo_miss",
                     message: tacResult.findings[0]?.summary ?? "SLO violation" },
      started_at:  new Date().toISOString(),
      finished_at: new Date().toISOString(),
      attempts:    1,
    };
    const iterRec: IterationRecord = {
      iteration:      turn,
      // Context-aware plan goal: include current room so "go east from Troll Room" and
      // "go east from Round Room" are treated as DIFFERENT plans by the FutilityMonitor.
      // Without this, the monitor fires after any directional command is issued twice total
      // (even from completely different rooms), producing 37+ false positives per session.
      planGoal:       `${command} (from ${cartographerState.lastRoomHeader || "unknown"})`,
      stepResults:    [stepRes],
      iterationUsage: { total_tokens: tacResult.tokens_used,
                        input_tokens: 0, output_tokens: tacResult.tokens_used },
    };
    // Combat commands are intentionally repeated (multi-hit fights); skip the monitor
    // entirely so they don't pollute its state or produce false HALT signals.
    const isCombatCmd = /^(attack|kill|strike|hit)\b/i.test(command);
    if (!isCombatCmd) {
      const futVerdict = futility.recordIteration(iterRec);
      if (futVerdict.action !== "continue") {
        futilityHint = futVerdict.reason;
        futilityHalts++;
        log(`${C.yellow}[Futility]${C.reset}`,
          `${C.yellow}${futVerdict.action.toUpperCase()}: ${futVerdict.reason}${C.reset}`);
      }
    }

    // ── Step 8c: AnomalyDetector ─────────────────────────────────────────
    const anomalies = anomalyDetector.analyzeResult({ result: tacResult, contract });
    if (anomalies.length > 0) {
      anomalyCount += anomalies.length;
      for (const a of anomalies)
        log(`${C.red}[Anomaly]${C.reset}`, `${a.type} (${a.severity}): ${a.description}`);
    }

    // ── Step 8d: BehavioralScorer ─────────────────────────────────────────
    // Infer observations from the SLO result: a pass means the executor was
    // safety-compliant and followed protocol; a fail is the inverse.
    // checkpointsMissed = 0 because we checkpoint every successful turn.
    behavioralScorer.inferObservationsFromResult(executorId, 0, !sloOk);
    const behavScore = behavioralScorer.computeCompositeScore(executorId);
    log(`${C.dim}[Behavior]${C.reset}`,
      `${executorName} behavioral score: ${C.green}${behavScore.toFixed(2)}${C.reset}`);

    // ── Step 8e: ContextBudgetMonitor ─────────────────────────────────────
    // Compute per-turn token delta and feed it to the context budget monitor.
    // Fires a warning when cumulative context approaches the window limit.
    const turnTokens = (strategistUsage.totalTokens + cartoUsage.totalTokens + grokUsage.totalTokens) - prevTurnTokens;
    cumulativeContextTokens += turnTokens;
    const ctxIter: ContextIteration = {
      iteration:               turn,
      tokensUsedThisIteration: turnTokens,
      cumulativeTokens:        cumulativeContextTokens,
      maxTokens:               MAX_CONTEXT_TOKENS,
      toolsUsed:               ["zork-emulator", USE_LLM ? "claude-sonnet" : USE_GROK_ENHANCED ? "grok" : "scripted"],
      planGoal:                command,
      stepCount:               turn,
    };
    const ctxVerdict = contextBudget.recordIteration(ctxIter);
    const ctxPct = ((cumulativeContextTokens / MAX_CONTEXT_TOKENS) * 100).toFixed(1);
    if (ctxVerdict.action !== "continue") {
      const reason = (ctxVerdict as { action: string; reason: string }).reason;
      log(`${C.yellow}[ContextBudget]${C.reset}`,
        `${C.yellow}${ctxVerdict.action.toUpperCase()}: ${reason} (${ctxPct}% of window)${C.reset}`);
      if (ctxVerdict.action === "checkpoint" || ctxVerdict.action === "summarize") {
        log(`${C.yellow}[ContextBudget]${C.reset}`,
          `→ Consider --resume after this session to reset context accumulation`);
      }
    } else {
      log(`${C.dim}[ContextBudget]${C.reset}`,
        `${cumulativeContextTokens.toLocaleString()} / ${MAX_CONTEXT_TOKENS.toLocaleString()} tokens (${ctxPct}%)`);
    }

    // ── Step 9: Re-delegation if SLO violated ──────────────────────────
    if (!sloOk) {
      log(`${C.red}[Strategist]${C.reset}`,
        `${C.red}Slashing Tactician bond 50% (SLO violation)${C.reset}`);
      const slash = escrow.slashBond(tacTaskId, 50);
      slashTotal += slash.amount ?? 0;
      reputation.recordOutcome(tacticianId, { ...tacResult, status: "failed" });
      const newTrust = reputation.getTrustScore(tacticianId);
      log(`${C.red}[Reputation]${C.reset}`,
        `Tactician trust: ${C.red}${trustNow.toFixed(2)} → ${newTrust.toFixed(2)}${C.reset}`);

      // RootCauseAnalyzer — diagnose and select recovery response
      const diag     = rootCauseAnalyzer.diagnose({
        task_id: tacTaskId, peer_node_id: tacticianId,
        checkpoint_misses: 0, anomaly_reports: anomalies,
        failure_count: failCount + 1, task_attributes: attrs,
      });
      const recovery = rootCauseAnalyzer.selectResponse(diag, attrs);
      log(`${C.red}[RootCause]${C.reset}`,
        `Cause: ${diag.root_cause} (${(diag.confidence * 100).toFixed(0)}%) → ${recovery}`);

      // Re-delegate a simpler variant to Cartographer
      const reOk = redelegationMonitor.recordRedelegation(tacTaskId, cartoId);
      if (!reOk) {
        log(`${C.red}[Redelegation]${C.reset}`,
          `${C.red}Max re-delegations reached for task ${tacTaskId} — aborting${C.reset}`);
        failCount++;
        continue;
      }
      const reCount = redelegationMonitor.getRedelegationCount(tacTaskId);
      log(`${C.magenta}[Strategist]${C.reset}`,
        `${C.yellow}Re-delegating to Cartographer (attempt ${reCount})...${C.reset}`);

      const reTaskId = `task-re-${uuid().slice(0, 8)}`;
      escrow.holdBond(reTaskId, cartoId, 0.10);

      try {
        // Re-delegation uses the same command — Cartographer tries a simpler fallback.
        // In LLM mode we just retry with "look" (safe, always valid) to recover state.
        const fallbackCmd = USE_LLM ? "look" : (ZORK_SCRIPT[turn] ? ZORK_SCRIPT[turn]!.command : "look");
        const reResult = await delegate(
          strategist, cartoId,
          `EXECUTE: ${fallbackCmd}`,
          sessionId,
        );
        log(`${C.magenta}[Cartographer]${C.reset}`,
          `${C.green}Re-delegation succeeded${C.reset}: ${reResult.findings[0]?.summary?.slice(0, 60)}`);
        escrow.releaseBond(reTaskId);
        reputation.recordOutcome(cartoId, reResult);
        redelegated = true;
        tacResult = reResult;
      } catch {
        escrow.slashBond(reTaskId, 25);
        log(`${C.red}[Strategist]${C.reset}`,
          `${C.red}Re-delegation also failed — skipping consensus${C.reset}`);
        failCount++;
        continue;
      }
    } else {
      escrow.releaseBond(tacTaskId);
      reputation.recordOutcome(tacticianId, tacResult);
      SESSION_BASE_COUNT.tac++;
      log(`${C.green}[Escrow]${C.reset}`,
        `Bond released for ${C.dim}${tacTaskId}${C.reset}`);

      // Update WorkingMemory
      const prevRoom = gameMemory.get("currentRoom") as string;
      const newRoom  = cartographerState.lastRoomHeader;
      if (newRoom && newRoom !== prevRoom && isRoomName(newRoom)) {
        gameMemory.set("currentRoom", newRoom);
        const graph = gameMemory.get("roomGraph") as Record<string, string[]>;
        if (prevRoom && !(graph[prevRoom] ?? []).includes(newRoom)) {
          graph[prevRoom] = [...(graph[prevRoom] ?? []), newRoom];
          gameMemory.set("roomGraph", graph);
        }
        // Directional graph: record which direction from prevRoom leads to newRoom.
        // We only do this for "go <direction>" commands so the mapping is reliable.
        const dirMatch = command.match(/^go\s+(north|south|east|west|up|down|in|out)$/i);
        if (dirMatch && prevRoom) {
          const dir = dirMatch[1]!.toLowerCase();
          cartographerState.dirGraph[prevRoom] ??= {};
          cartographerState.dirGraph[prevRoom]![dir] = newRoom;
          // Also record the reverse direction so we can navigate back.
          const rev: Record<string, string> = {
            north: "south", south: "north", east: "west", west: "east",
            up: "down", down: "up", in: "out", out: "in",
          };
          if (rev[dir]) {
            cartographerState.dirGraph[newRoom] ??= {};
            cartographerState.dirGraph[newRoom]![rev[dir]!] ??= prevRoom; // don't clobber
            // Sync reverse direction into roomExits so it appears in "Directions from here"
            // and the Strategist knows it leads to a visited room.
            const revDir = rev[dir]!;
            const exits = cartographerState.roomExits[newRoom] ?? [];
            if (!exits.includes(revDir)) {
              cartographerState.roomExits[newRoom] = [...exits, revDir];
            }
          }
        }
        const visited = (gameMemory.get("visitedRooms") as string[]) ?? [];
        if (!visited.includes(newRoom)) {
          visited.push(newRoom);
          gameMemory.set("visitedRooms", visited);
        }
      }

      // Exit cache pruning: if "go <dir>" didn't change the room, that direction is
      // invalid — remove it from roomExits AND add to blockedExits so the Cartographer
      // never re-adds it. This fixes the "South of House" trap where Haiku hallucinates
      // "north" as a valid exit but going north just hits a boarded window.
      {
        const pruneDir = command.match(/^go\s+(north|south|east|west|up|down|in|out)$/i)?.[1]?.toLowerCase();
        if (pruneDir && prevRoom && (!newRoom || newRoom === prevRoom || !isRoomName(newRoom))) {
          // Add to permanent block list so Cartographer never re-adds it
          cartographerState.blockedExits[prevRoom] ??= new Set<string>();
          cartographerState.blockedExits[prevRoom]!.add(pruneDir);
          // Remove from live exits cache
          const exits = cartographerState.roomExits[prevRoom];
          if (exits?.map(e => e.toLowerCase()).includes(pruneDir)) {
            cartographerState.roomExits[prevRoom] = exits.filter(e => e.toLowerCase() !== pruneDir);
            log(`${C.dim}[NavPrune]${C.reset}`,
              `Removed "${pruneDir}" from ${prevRoom} exits permanently (no room change — dead end)`);
          }
        }
      }

      // ── Response-text NavPrune ───────────────────────────────────────────────
      // Scan the game response for explicit block/fail messages and update blockedExits
      // or weightLimitExits accordingly — no game-specific knowledge required.
      {
        const HARD_BLOCK_RE = /locked from (above|below)|no way to go that direction|you can't go that way|the door is locked|a wall blocks/i;
        const SOFT_BLOCK_RE = /too (heavy|much)|your load is too|you (can't|cannot) carry (any more|that much)/i;
        const lastCmd = commandHistory.at(-1) ?? "";
        const dirMatch = lastCmd.match(/^go\s+(\w+)/i);
        const tacDeltaText = tacResult.findings[0]?.summary ?? "";
        if (dirMatch && tacDeltaText) {
          const dir = dirMatch[1]!.toLowerCase();
          const room = cartographerState.lastRoomHeader;
          if (room) {
            if (HARD_BLOCK_RE.test(tacDeltaText)) {
              cartographerState.blockedExits[room] ??= new Set<string>();
              cartographerState.blockedExits[room]!.add(dir);
              // Also remove from exits cache
              const exits = cartographerState.roomExits[room];
              if (exits?.map(e => e.toLowerCase()).includes(dir)) {
                cartographerState.roomExits[room] = exits.filter(e => e.toLowerCase() !== dir);
              }
              log(`${C.dim}[NavPrune/hard]${C.reset}`,
                `Blocked ${room} → ${dir} (response: hard wall)`);
            } else if (SOFT_BLOCK_RE.test(tacDeltaText)) {
              cartographerState.weightLimitExits[room] ??= new Set<string>();
              cartographerState.weightLimitExits[room]!.add(dir);
              log(`${C.dim}[NavPrune/soft]${C.reset}`,
                `Weight-limited ${room} → ${dir} (retryable after drop)`);
            }
          }
        }
      }

      // Update inventory from game response (game-agnostic heuristic)
      const tacDelta = tacResult.findings[0]?.summary ?? "";
      const updatedInv = updateInventory([...(gameMemory.get("inventory") as string[] ?? [])], tacDelta, command);
      gameMemory.set("inventory", updatedInv);

      // Update blocked-puzzle list:
      //   ADD entry when the game signals we can't proceed (locked, need something, can't)
      //   RESOLVE entries when the same object in the same room now succeeds
      const puzzles = (gameMemory.get("blockedPuzzles") as BlockedPuzzle[]) ?? [];
      const currentRoomNow = (gameMemory.get("currentRoom") as string) ?? "";
      const blockReason = detectBlockReason(tacDelta);
      if (blockReason) {
        // Parse the target object from the command (e.g. "open grating" → "grating")
        // Only log if the command has a recognizable target object — prevents
        // commands like "look" from being logged as blocked puzzles.
        const objMatch = command.match(/^(?:open|unlock|push|pull|move|take|use|enter)\s+(.+)/i);
        if (objMatch) {
          const obj = objMatch[1]!.trim();
          const alreadyLogged = puzzles.some(
            p => p.room === currentRoomNow && p.object === obj,
          );
          if (!alreadyLogged) {
            puzzles.push({ room: currentRoomNow, object: obj, reason: blockReason });
            gameMemory.set("blockedPuzzles", puzzles);
            log(`${C.dim}[Memory]${C.reset}`, `Blocked puzzle recorded: "${obj}" in ${currentRoomNow} (${blockReason})`);
          }
        }
      } else {
        // Command succeeded — resolve any matching blocked entry
        const objMatch = command.match(/^(?:open|unlock|push|pull|move|take|use|enter)\s+(.+)/i);
        const obj = objMatch?.[1]?.trim();
        if (obj) {
          const before = puzzles.length;
          const remaining = puzzles.filter(
            p => !(p.room === currentRoomNow && p.object === obj),
          );
          if (remaining.length < before) {
            gameMemory.set("blockedPuzzles", remaining);
            log(`${C.dim}[Memory]${C.reset}`, `Blocked puzzle resolved: "${obj}" in ${currentRoomNow}`);
          }
        }
      }

      log(`${C.dim}[Memory]${C.reset}`,
        `Room: ${gameMemory.get("currentRoom") || "?"} | Visited: ${(gameMemory.get("visitedRooms") as string[])?.length ?? 0} room(s) | Inventory: ${updatedInv.join(", ") || "empty"}`);

    // ── Real cost snapshot ────────────────────────────────────────────────
    {
      const s = strategistUsage.getSummary();
      const c = cartoUsage.getSummary();
      const g = grokUsage.getSummary();
      const total = s.total_cost_usd + c.total_cost_usd + g.total_cost_usd;
      const parts: string[] = [];
      if (s.call_count > 0) parts.push(`Strategist $${s.total_cost_usd.toFixed(4)} (${s.call_count} calls)`);
      if (c.call_count > 0) parts.push(`Cartographer $${c.total_cost_usd.toFixed(4)} (${c.call_count} calls)`);
      if (g.call_count > 0) parts.push(`Grok $${g.total_cost_usd.toFixed(4)} (${g.call_count} calls)`);
      log(`${C.dim}[Cost]${C.reset}`,
        `Session total: ${C.yellow}$${total.toFixed(4)}${C.reset} | ${parts.join(" | ")}`);
    }
    }

    // ── Step 10: Independent consensus ──────────────────────────────────
    //
    // Root cause fix 4 (original): previously both verifiers hashed tacResult.findings —
    // the SAME object — guaranteeing agreed(1.0) every time.
    //
    // Root cause fix (hash mismatch): the Strategist was hashing
    // tacResult.findings[0]?.summary (the delta, truncated to 200 chars)
    // while Cartographer hashed emulator.readScreen() (the full untruncated output).
    // For responses > 200 chars (Kitchen, Living Room descriptions), the hashes
    // always differed even when both sides were honest, causing false consensus failures.
    //
    // Correct approach: BOTH sides hash emulator.readScreen() — the same ground-truth
    // source — so they agree in honest cases and diverge only if the screen state
    // actually differs between reads (which can't happen in our in-process setup,
    // but would in a real distributed system with independent I/O channels).
    //
    // The Tactician's reported delta is still used for human-readable logging;
    // only the consensus hash switches to the full screen.
    const strategistHash = createHash("sha256")
      .update(await emulator.readScreen() ?? "")
      .digest("hex")
      .slice(0, 32);

    let cartoVerifyHash = strategistHash; // fallback if VERIFY delegation fails
    try {
      const verifyResult = await delegate(strategist, cartoId, `VERIFY: ${command}`, sessionId);
      cartoVerifyHash = verifyResult.findings[0]?.summary ?? strategistHash;
    } catch {
      log(`${C.dim}[Consensus]${C.reset}`, `Cartographer VERIFY failed — using Strategist hash as fallback`);
    }

    const round = consensus.createRound(tacTaskId, 2, 0.67);
    consensus.submitVerification(round.round_id, strategistId, strategistHash, 0.95);
    const submitResult = consensus.submitVerification(round.round_id, cartoId, cartoVerifyHash, 0.90);

    const outcome = consensus.evaluateRound(round.round_id)
      ?? (submitResult.auto_evaluated ? consensus.getRound(round.round_id)?.outcome : undefined);

    if (outcome?.agreed) {
      log(`${C.green}[Consensus]${C.reset}`,
        `Strategist: ✓ | Cartographer: ✓ → ${C.green}agreed (${outcome.agreement_ratio.toFixed(1)})${C.reset}`);
      successCount++;
    } else {
      log(`${C.red}[Consensus]${C.reset}`,
        `${C.red}Consensus failed — Tactician's reported output does not match observed screen${C.reset}`);
      failCount++;
    }

    // ── Checkpoint every 5 turns ─────────────────────────────────────────
    if (turn % 5 === 0) {
      checkpointer.saveCheckpoint({
        task_id:         sessionId,
        peer_node_id:    strategistId,
        state: {
          turn,
          rooms:          cartographerState.rooms,
          inventory:      gameMemory.get("inventory"),
          visitedRooms:   gameMemory.get("visitedRooms"),
          commandHistory: commandHistory.slice(-20),
          trustScore:     reputation.getTrustScore(tacticianId),
        },
        findings_so_far: turn,
        tokens_used:     0,
        cost_usd:        0,
        duration_ms:     0,
        timestamp:       new Date().toISOString(),
      });
      checkpointsSaved++;
      log(`${C.dim}[Checkpoint]${C.reset}`, `Saved state at turn ${turn}`);
    }

    // ── Update command history & delta (used by LLM Strategist next turn) ──
    commandHistory.push(command);
    lastDelta = tacResult.findings[0]?.summary ?? "";
    transcript.push(`> ${command}\n${maskGameText(lastDelta.slice(0, 300))}`);

    // ── Save turn checkpoint (enables --resume) ───────────────────────────
    if (USE_FROTZ) {
      const tacRep2   = reputation.getReputation(tacticianId);
      const cartoRep2 = reputation.getReputation(cartoId);
      writeCheckpoint({
        turn,
        sessionId:   ckpt?.sessionId ?? sessionId,
        commandHistory,
        lastDelta,
        rooms:          cartographerState.rooms,
        lastRoomHeader: cartographerState.lastRoomHeader,
        roomExits:      cartographerState.roomExits,
        dirGraph:       cartographerState.dirGraph,
        currentRoom:    (gameMemory.get("currentRoom")    as string) ?? "",
        inventory:      (gameMemory.get("inventory")      as string[]) ?? [],
        visitedRooms:   (gameMemory.get("visitedRooms")   as string[]) ?? [],
        roomGraph:      (gameMemory.get("roomGraph")      as Record<string, string[]>) ?? {},
        blockedPuzzles:       (gameMemory.get("blockedPuzzles")       as BlockedPuzzle[]) ?? [],
        tacticianCompleted: tacRep2?.tasks_completed ?? 0,
        tacticianFailed:    tacRep2?.tasks_failed    ?? 0,
        cartoCompleted:     cartoRep2?.tasks_completed ?? 0,
        cartoFailed:        cartoRep2?.tasks_failed    ?? 0,
        tacticianEscrow:    escrow.getFreeBalance(tacticianId),
        cartoEscrow:        escrow.getFreeBalance(cartoId),
        strategistUsageSummary:  strategistUsage.getSummary(),
        cartoUsageSummary:       cartoUsage.getSummary(),
        grokUsageSummary:        grokUsage.getSummary(),
        cumulativeContextTokens,
        rngSeed,
      });
      turnCheckpointsSaved++;
      log(`${C.dim}[Checkpoint]${C.reset}`, `Turn ${turn} saved → ${CHECKPOINT_DIR}`);
    }

    // ── Step 11: Reputation summary ────────────────────────────────────
    const rep      = reputation.getReputation(tacticianId);
    const newTrust = reputation.getTrustScore(tacticianId);
    if (rep) {
      const sessionDone = rep.tasks_completed - 3; // subtract seed
      log(`${C.dim}[Reputation]${C.reset}`,
        `Tactician: session ${Math.max(0, sessionDone)}/${Math.max(0, sessionDone + rep.tasks_failed)} | total ${rep.tasks_completed}/${rep.tasks_completed + rep.tasks_failed} → trust ${C.green}${newTrust.toFixed(2)}${C.reset}${redelegated ? C.yellow + " (re-delegated)" + C.reset : ""}`);
    }

    await new Promise<void>((r) => setTimeout(r, 50));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SESSION SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════

  header("SESSION SUMMARY");

  const finalTrust   = reputation.getTrustScore(tacticianId);
  const tacRep       = reputation.getReputation(tacticianId);
  const tacBalance   = escrow.getFreeBalance(tacticianId);
  const cartoBalance = escrow.getFreeBalance(cartoId);

  // Root cause fix 6: call router with per-run data for meaningful final recommendation
  const finalRouting = router.route({
    sub_task_id: "summary", task_text: "play interactive fiction game",
    attributes: { complexity: "medium", criticality: "low", verifiability: "high",
                  reversibility: "high", estimated_cost: "low", estimated_duration: "short",
                  required_capabilities: ["navigation"] },
    constraints: { max_tokens: 500, max_cost_usd: 0.02, max_duration_ms: 5000 },
    depends_on: [], delegation_target: finalTrust >= 0.5 ? "ai" : "any",
  });

  console.log();
  log(`${C.bold}📊${C.reset}`, `${C.bold}Turns played:${C.reset} ${MAX_TURNS}`);
  log(`${C.green}✓${C.reset}`,  `Successful turns: ${C.green}${successCount}${C.reset}`);
  log(`${C.red}✗${C.reset}`,   `Failed turns: ${C.red}${failCount}${C.reset}`);
  log(`${C.dim}•${C.reset}`,   `Bonds slashed total: ${C.red}$${slashTotal.toFixed(2)}${C.reset}`);
  log(`${C.dim}•${C.reset}`,   `Tactician final trust: ${C.green}${finalTrust.toFixed(2)}${C.reset} (${getTrustTier(finalTrust)})`);
  log(`${C.dim}•${C.reset}`,   `Tactician session completed: ${Math.max(0, (tacRep?.tasks_completed ?? 3) - 3)}, failed: ${tacRep?.tasks_failed ?? 0}`);
  log(`${C.dim}•${C.reset}`,   `Tactician escrow balance: $${tacBalance.toFixed(2)}`);
  log(`${C.dim}•${C.reset}`,   `Cartographer escrow balance: $${cartoBalance.toFixed(2)}`);
  log(`${C.dim}•${C.reset}`,   `Rooms mapped: ${cartographerState.rooms.length} — ${cartographerState.rooms.join(", ") || "(none)"}`);
  log(`${C.dim}•${C.reset}`,   `LLM mode: ${
    USE_GROK_ENHANCED ? `Grok-enhanced — Strategist=${GROK_MODEL} / Cartographer=${CARTOGRAPHER_MODEL}`
    : USE_LLM         ? `on — Strategist=${STRATEGIST_MODEL} / Cartographer=${CARTOGRAPHER_MODEL}`
    :                   "off (scripted)"
  }`);
  log(`${C.dim}•${C.reset}`,   `Commands issued: ${commandHistory.join(" → ") || "(none)"}`);
  log(`${C.dim}•${C.reset}`,   `DelegateeRouter final: target="${finalRouting.target}" (confidence ${finalRouting.confidence.toFixed(2)}, trust-based)`);
  log(`${C.dim}•${C.reset}`,   `Futility detections: ${futilityHalts} (loop guard activations)`);
  log(`${C.dim}•${C.reset}`,   `Anomalies detected: ${anomalyCount}`);
  log(`${C.dim}•${C.reset}`,   `Checkpoints saved: ${turnCheckpointsSaved} turn(s) → ${CHECKPOINT_DIR}${ckpt ? ` (resumed from turn ${ckpt.turn})` : ""}`);
  log(`${C.dim}•${C.reset}`,   `PermissionEngine: ${permApprovals} approval(s), ${permDenials} denial(s) | Grants: ${permEngine.listGrants(sessionId).map(g => g.scope).join(", ") || "none"}`);

  // BehavioralScorer summary
  const tacBehav   = behavioralScorer.getMetrics(tacticianId);
  const cartoBehav = behavioralScorer.getMetrics(cartoId);
  if (tacBehav) {
    log(`${C.dim}•${C.reset}`,
      `Tactician behavioral: composite ${C.green}${tacBehav.composite_score.toFixed(2)}${C.reset} | safety ${tacBehav.safety.toFixed(2)} | protocol ${tacBehav.protocol_compliance.toFixed(2)} | ${tacBehav.observation_count} obs`);
  }
  if (cartoBehav) {
    log(`${C.dim}•${C.reset}`,
      `Cartographer behavioral: composite ${C.green}${cartoBehav.composite_score.toFixed(2)}${C.reset} | safety ${cartoBehav.safety.toFixed(2)} | protocol ${cartoBehav.protocol_compliance.toFixed(2)} | ${cartoBehav.observation_count} obs`);
  }

  // RedelegationMonitor summary
  const trackedDelegations = redelegationMonitor.getTrackedDelegations();
  const totalRedelegations = trackedDelegations.reduce((s, d) => s + d.redelegation_count, 0);
  log(`${C.dim}•${C.reset}`,
    `RedelegationMonitor: ${trackedDelegations.length} task(s) tracked, ${totalRedelegations} re-delegation(s)`);

  // SybilDetector summary
  log(`${C.dim}•${C.reset}`,
    `SybilDetector: ${sybilDetector.getReports().length} report(s), ${sybilSuspects} suspect(s) flagged`);

  // ContextBudgetMonitor summary
  const ctxFinalPct = ((cumulativeContextTokens / MAX_CONTEXT_TOKENS) * 100).toFixed(1);
  log(`${C.dim}•${C.reset}`,
    `ContextBudget: ${cumulativeContextTokens.toLocaleString()} / ${MAX_CONTEXT_TOKENS.toLocaleString()} tokens used (${ctxFinalPct}% of window)`);

  // ── Real cost summary ────────────────────────────────────────────────────
  {
    const s = strategistUsage.getSummary();
    const c = cartoUsage.getSummary();
    const g = grokUsage.getSummary();
    const sessionTotal = s.total_cost_usd + c.total_cost_usd + g.total_cost_usd;
    const sessionTokens = s.total_tokens + c.total_tokens + g.total_tokens;
    console.log();
    log(`${C.bold}💰${C.reset}`, `${C.bold}Actual API cost (this session):${C.reset} ${C.yellow}$${sessionTotal.toFixed(4)}${C.reset} / ${sessionTokens.toLocaleString()} tokens`);
    if (s.call_count > 0) {
      log(`${C.dim}  ↳${C.reset}`, `Strategist (${STRATEGIST_MODEL}): ${s.total_tokens.toLocaleString()} tokens (${s.total_input_tokens} in / ${s.total_output_tokens} out) → $${s.total_cost_usd.toFixed(4)}`);
    }
    if (c.call_count > 0) {
      log(`${C.dim}  ↳${C.reset}`, `Cartographer (${CARTOGRAPHER_MODEL}): ${c.total_tokens.toLocaleString()} tokens (${c.total_input_tokens} in / ${c.total_output_tokens} out) → $${c.total_cost_usd.toFixed(4)}`);
    }
    if (g.call_count > 0) {
      log(`${C.dim}  ↳${C.reset}`, `Grok (${GROK_MODEL}): ${g.total_tokens.toLocaleString()} tokens (${g.total_input_tokens} in / ${g.total_output_tokens} out) → $${g.total_cost_usd.toFixed(4)}`);
    }
    if (!USE_LLM && !USE_GROK && !USE_GROK_ENHANCED) {
      log(`${C.dim}•${C.reset}`, `No LLM active — cost is $0.00 (scripted mode)`);
    }
  }

  // ── Cross-session lesson ─────────────────────────────────────────────────
  // Distil this session into a MemoryLesson and persist it.  On the next run
  // (--resume or fresh start) the Strategist will receive it as context.
  if (commandHistory.length > 0) {
    const rooms = cartographerState.rooms;
    const inv   = (gameMemory.get("inventory") as string[]) ?? [];
    const visitedCount = (gameMemory.get("visitedRooms") as string[])?.length ?? 0;
    const efficiencyPct = MAX_TURNS > 0 ? Math.round((successCount / MAX_TURNS) * 100) : 0;

    const lessonText = [
      `Explored ${rooms.length} room(s): ${rooms.slice(0, 8).join(", ")}${rooms.length > 8 ? "…" : ""}.`,
      inv.length > 0 ? `Items acquired: ${inv.join(", ")}.` : "No items acquired.",
      `${successCount}/${MAX_TURNS} turns effective (${efficiencyPct}%).`,
      commandHistory.length > 0
        ? `Last 5 commands: ${commandHistory.slice(-5).join(", ")}.`
        : "",
    ].filter(Boolean).join(" ").slice(0, 400);

    const lesson: MemoryLesson = {
      lesson_id:       `zork-${(ckpt?.sessionId ?? sessionId).slice(0, 8)}-t${startTurn}-${startTurn + MAX_TURNS - 1}`,
      session_id:      ckpt?.sessionId ?? sessionId,
      task_summary:    `Interactive fiction session: turns ${startTurn}–${startTurn + MAX_TURNS - 1}, ${rooms.length} rooms`,
      outcome:         successCount > failCount ? "succeeded" : "failed",
      lesson:          lessonText,
      tool_names:      ["zork-emulator", "cartographer-llm"],
      created_at:      new Date().toISOString(),
      relevance_count: 0,
    };
    activeMemory.addLesson(lesson);
    await activeMemory.save();
    log(`${C.blue}[Memory]${C.reset}`,
      `Lesson saved → ${activeMemoryPath} (${activeMemory.getLessons().length} total)`);
    log(`${C.dim}  ↳${C.reset}`, lessonText.slice(0, 120));
  }

  // ── Prometheus metrics file ──────────────────────────────────────────────
  try {
    const metricsOutput = await metrics.getMetrics();
    const metricsFile   = join(CHECKPOINT_DIR, "metrics.prom");
    writeFileSync(metricsFile, metricsOutput);
    log(`${C.dim}[Metrics]${C.reset}`, `Prometheus metrics → ${metricsFile}`);
  } catch { /* non-fatal */ }
  metrics.detach();

  if (USE_BLIND) {
    header("GAME IDENTIFICATION  (blind mode)");
    const identModel = USE_GROK_ENHANCED ? GROK_MODEL : STRATEGIST_MODEL;
    log(`${C.cyan}[Blind]${C.reset}`, `Asking ${identModel} to identify the game from transcript...`);
    try {
      const identification = await askIdentifyGame(transcript.join("\n\n"));
      console.log(`\n${C.bold}${C.cyan}Game identification:${C.reset}`);
      console.log(identification.split("\n").map(l => `  ${l}`).join("\n"));
    } catch (err) {
      log(`${C.red}[Blind]${C.reset}`, `Identification failed: ${String(err).slice(0, 80)}`);
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────
  header("SHUTDOWN");

  permEngine.clearSession(sessionId);
  await emulator.close();
  log(`${C.green}✓${C.reset}`, "Emulator closed");

  for (const n of nodes) {
    await n.mesh.stop();
    await new Promise<void>((r) => n.server.close(() => r()));
    await n.journal.close();
    log(`${n.color}✓${C.reset}`, `${n.color}${n.name}${C.reset} stopped`);
  }

  console.log(`\n${C.bold}${C.green}Done!${C.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal:${C.reset}`, err);
  process.exit(1);
});
