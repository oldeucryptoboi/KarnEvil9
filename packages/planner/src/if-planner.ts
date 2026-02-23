/**
 * IFPlanner — Interactive Fiction Planner for the KarnEvil9 kernel.
 *
 * Replaces the inline `askStrategist()` function from the swarm script.
 * Each kernel iteration produces a 2-step plan:
 *   1. execute-game-command  — send a command to the emulator
 *   2. parse-game-screen     — parse the resulting screen via Cartographer
 *
 * Game state is injected into `stateSnapshot.context.game_state` by the
 * swarm-delegation plugin's `before_plan` hook.
 */

import { v4 as uuid } from "uuid";
import type {
  Task,
  Plan,
  PlanResult,
  Planner,
  ToolSchemaForPlanner,
  UsageMetrics,
} from "@karnevil9/schemas";
import { bfsPath } from "./bfs.js";
import type { BfsStep } from "./bfs.js";

// ─── Game state shape (injected by plugin via before_plan hook) ───────────────

export interface BlockedPuzzle {
  room: string;
  object: string;
  reason: string;
}

export interface IFGameState {
  currentRoom: string;
  lastDelta: string;
  fullScreen: string;
  commandHistory: string[];
  inventory: string[];
  visitedRooms: string[];
  futilityHint: string;
  failedCommands: string[];
  blockedPuzzles: BlockedPuzzle[];
  knownExits: string[];
  roomDirections: Record<string, string>;
  dirGraph: Record<string, Record<string, string>>;
  blockedExits: Record<string, Set<string>>;
  turnsStalled: number;
  navigationHint?: string;
  currentRoomName?: string;
  weightLimitDirs?: string[];
  pastLessons?: Array<{ outcome: string; lesson: string }>;
  gameOver?: boolean;
}

// ─── Model call interface ─────────────────────────────────────────────────────

export interface IFModelCallResult {
  text: string;
  usage?: UsageMetrics;
}

export type IFModelCallFn = (system: string, user: string) => Promise<IFModelCallResult>;

// ─── Configuration ────────────────────────────────────────────────────────────

export interface IFPlannerConfig {
  callModel: IFModelCallFn;
  bfsPathFinder?: typeof bfsPath;
  /** When true, mask game-identifying text in prompts */
  blind?: boolean;
  /** Verbose logging callback */
  onVerbose?: (label: string, text: string) => void;
}

// ─── IFPlanner ────────────────────────────────────────────────────────────────

export class IFPlanner implements Planner {
  private callModel: IFModelCallFn;
  private bfs: typeof bfsPath;
  private blind: boolean;
  private onVerbose?: (label: string, text: string) => void;

  constructor(config: IFPlannerConfig) {
    this.callModel = config.callModel;
    this.bfs = config.bfsPathFinder ?? bfsPath;
    this.blind = config.blind ?? false;
    this.onVerbose = config.onVerbose;
  }

  async generatePlan(
    _task: Task,
    _toolSchemas: ToolSchemaForPlanner[],
    stateSnapshot: Record<string, unknown>,
    _constraints: Record<string, unknown>,
  ): Promise<PlanResult> {
    const gameState = (stateSnapshot.context as Record<string, unknown> | undefined)
      ?.game_state as IFGameState | undefined;

    // No game state yet (first iteration) — issue a "look" command
    if (!gameState) {
      return this.buildPlan("look", "Initial room observation");
    }

    // Game over signal
    if (gameState.gameOver) {
      return {
        plan: {
          plan_id: uuid(),
          schema_version: "0.1",
          goal: "Game complete",
          assumptions: [],
          steps: [],
          created_at: new Date().toISOString(),
        },
      };
    }

    // Compute BFS navigation hint
    const navHint = this.computeNavHint(gameState);
    if (navHint) {
      gameState.navigationHint = navHint;
    }

    // Build strategist prompts
    const system = this.buildSystemPrompt(gameState);
    const user = this.buildUserPrompt(gameState);

    // Call LLM
    const { text: raw, usage } = await this.callModel(system, user);

    // Parse response
    const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    const recognitionLine = lines.find(l => /^Game:/i.test(l));
    if (recognitionLine) {
      this.onVerbose?.("[Recognition]", recognitionLine);
    }
    const reasoningLine = lines.find(l => /^Reasoning:/i.test(l));
    if (reasoningLine) {
      this.onVerbose?.("[Reasoning]", reasoningLine);
    }
    this.onVerbose?.("[Strategist/full]", raw);

    const commandLine = lines.find(l => !/^(Game:|Reasoning:)/i.test(l)) ?? "look";
    const command = commandLine.replace(/^["'`]|["'`]$/g, "").replace(/[.!?]$/, "").toLowerCase().trim();

    return this.buildPlan(command, `Execute: ${command}`, usage);
  }

  // ─── Plan construction ──────────────────────────────────────────────────

  private buildPlan(command: string, goal: string, usage?: UsageMetrics): PlanResult {
    const execStepId = uuid();
    const parseStepId = uuid();

    const plan: Plan = {
      plan_id: uuid(),
      schema_version: "0.1",
      goal,
      assumptions: ["Game emulator is running"],
      steps: [
        {
          step_id: execStepId,
          title: `Game command: ${command}`,
          tool_ref: { name: "execute-game-command" },
          input: { command },
          success_criteria: ["Command accepted by emulator"],
          failure_policy: "replan",
          timeout_ms: 60000,
          max_retries: 0,
        },
        {
          step_id: parseStepId,
          title: "Parse game screen",
          tool_ref: { name: "parse-game-screen" },
          input: { screen_text: "" },
          input_from: { screen_text: `${execStepId}.screen_text` },
          depends_on: [execStepId],
          success_criteria: ["Screen text parsed"],
          failure_policy: "continue",
          timeout_ms: 30000,
          max_retries: 0,
        },
      ],
      created_at: new Date().toISOString(),
    };

    return { plan, usage };
  }

  // ─── BFS navigation ────────────────────────────────────────────────────

  private computeNavHint(gameState: IFGameState): string | undefined {
    // Simple heuristic: find unresolved puzzles that we might now be able to reach
    if (gameState.blockedPuzzles.length === 0) return undefined;

    for (const puzzle of gameState.blockedPuzzles) {
      const path = this.bfs(
        gameState.dirGraph,
        gameState.currentRoom,
        puzzle.room,
        gameState.blockedExits as Record<string, Set<string>>,
      );
      if (path && path.length > 0) {
        return path.map((s: BfsStep) => `go ${s.direction} → ${s.destination}`).join(", then ");
      }
    }
    return undefined;
  }

  // ─── Prompt construction ────────────────────────────────────────────────

  private mask(text: string): string {
    if (!this.blind) return text;
    const blk = (m: string) => "\u2588".repeat(m.length);
    return text
      .replace(/\bZORK\s+I\b/gi, blk)
      .replace(/\bZORK\b/gi, blk)
      .replace(/\bThe Great Underground Empire\b/gi, blk)
      .replace(/\bIncocom\b/gi, blk)
      .replace(/\bInfocom\b/gi, blk)
      .replace(/^Copyright\b.*/gim, blk)
      .replace(/^Revision\s+\d+\s*\/\s*Serial number\s+\d+.*/gim, blk);
  }

  private buildSystemPrompt(gs: IFGameState): string {
    const blockedBlock = gs.blockedPuzzles.length
      ? `\nUNRESOLVED PUZZLES (left behind — return when you have the means):\n${
          gs.blockedPuzzles.map(p => `  \u2022 ${p.room}: "${p.object}" (${p.reason})`).join("\n")
        }\n`
      : "";

    const exitsBlock = gs.knownExits.length
      ? `  Cartographer exits: ${gs.knownExits.join(", ")}\n`
      : "";

    const dirEntries = Object.entries(gs.roomDirections ?? {});
    const dirBlock = dirEntries.length
      ? `  Directions from here: ${dirEntries.map(([d, r]) => `${d} \u2192 ${r}`).join(", ")}\n`
      : "";

    const navBlock = gs.navigationHint
      ? `\n\u2691 NAVIGATION PATH (execute in order, one command per turn):\n  ${gs.navigationHint}\n`
      : "";

    const stalledBlock = (gs.turnsStalled ?? 0) >= 5
      ? `\n\u26a0 STALLED: No new room discovered in the last ${gs.turnsStalled} turns.\n` +
        `  All accessible areas appear exhausted from rooms you have been visiting.\n` +
        `  You MUST take aggressive action: fight blocking enemies, use items on obstacles,\n` +
        `  or probe untried directions (up, down, in, out, and all compass directions).\n`
      : "";

    const softBlocked = [...(gs.weightLimitDirs ?? [])];
    const weightLimitBlock = softBlocked.length > 0
      ? `\n\u26a0 WEIGHT LIMIT: Direction(s) [${softBlocked.join(", ")}] failed due to carry weight from "${gs.currentRoomName ?? gs.currentRoom}".\n` +
        `  Consider dropping non-essential items from your inventory, then retry.\n` +
        `  Current inventory: ${gs.inventory.join(", ") || "unknown"}\n`
      : "";

    const memoryBlock = `
AGENT MEMORY:${navBlock}${weightLimitBlock}
  Inventory: ${gs.inventory.join(", ") || "empty"}
  Rooms visited: ${gs.visitedRooms.slice(-15).join(", ") || "none yet"}
${exitsBlock}${dirBlock}  Recently failed/no-effect commands for this room: ${gs.failedCommands.slice(-5).join(", ") || "none"}
${blockedBlock}${stalledBlock}${gs.futilityHint ? `\n\u26a0 LOOP DETECTED: ${gs.futilityHint}\n  \u2192 You MUST try a completely different approach.\n` : ""}`;

    const lessonBlock = gs.pastLessons && gs.pastLessons.length > 0 ? `
CROSS-SESSION MEMORY (from ${gs.pastLessons.length} prior session(s)):
${gs.pastLessons.map(l => `  \u2022 [${l.outcome}] ${l.lesson}`).join("\n")}
` : "";

    return `You are the Strategist agent in an autonomous multi-agent system playing an interactive text-based game.
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
  }

  private buildUserPrompt(gs: IFGameState): string {
    const historyText = gs.commandHistory.length > 0
      ? `\nCommand history (most recent last):\n${gs.commandHistory.slice(-10).map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
      : "\nNo commands issued yet.";

    return `Current location: ${this.mask(gs.currentRoom || "Unknown")}
${historyText}

Last response:
${this.mask(gs.lastDelta || "(no previous response)")}

Full screen:
${this.mask(gs.fullScreen || "(no screen data)")}

Answer on THREE lines:
Line 1: your command (the command only, nothing else)
Line 2: "Game: <name or unknown> | Confidence: <0-100%> | Reason: <one phrase>"
Line 3: "Reasoning: <one sentence — why you chose this command>"
`;
  }
}
