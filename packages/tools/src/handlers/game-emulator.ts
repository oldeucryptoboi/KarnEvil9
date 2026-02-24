import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@karnevil9/schemas";

// ─── EmulatorLike ─────────────────────────────────────────────────────────────
// Minimal interface that both the Apple II Playwright emulator and dfrotz satisfy.

export interface EmulatorLike {
  sendCommand(cmd: string): Promise<{
    output: string;
    delta: string;
    roomHeader: string;
    success: boolean;
    durationMs: number;
  }>;
  readScreen(): Promise<string | null>;
  skipTurn(): void;
}

// ─── Cartographer callback ────────────────────────────────────────────────────
// The parse-game-screen tool delegates to an external function (typically an LLM call)
// for structured screen parsing.  Set via setCartographerFn() at startup.

export type CartographerFn = (screenText: string) => Promise<string>;

// ─── Module-level refs ────────────────────────────────────────────────────────

let emulatorRef: EmulatorLike | null = null;
let cartographerFn: CartographerFn | null = null;

export function setEmulator(emulator: EmulatorLike): void {
  emulatorRef = emulator;
}

export function setCartographerFn(fn: CartographerFn): void {
  cartographerFn = fn;
}

// ─── execute-game-command ─────────────────────────────────────────────────────

export const executeGameCommandHandler: ToolHandler = async (
  input: Record<string, unknown>,
  mode: ExecutionMode,
  _policy: PolicyProfile,
): Promise<unknown> => {
  if (typeof input.command !== "string") {
    throw new Error("input.command must be a string");
  }
  const command = input.command;

  if (mode === "mock") {
    return {
      delta: "(mock) You are in a room.",
      room_header: "Mock Room",
      screen_text: ">mock\nYou are in a room.",
      success: true,
      duration_ms: 0,
    };
  }

  if (mode === "dry_run") {
    return {
      delta: `[dry_run] Would execute: ${command}`,
      room_header: "(dry_run)",
      screen_text: `[dry_run] Would execute: ${command}`,
      success: true,
      duration_ms: 0,
    };
  }

  if (!emulatorRef) {
    throw new Error("No emulator configured — call setEmulator() before using execute-game-command");
  }

  const result = await emulatorRef.sendCommand(command);
  return {
    delta: result.delta,
    room_header: result.roomHeader,
    screen_text: result.output,
    success: result.success,
    duration_ms: result.durationMs,
  };
};

// ─── parse-game-screen ────────────────────────────────────────────────────────

export const parseGameScreenHandler: ToolHandler = async (
  input: Record<string, unknown>,
  mode: ExecutionMode,
  _policy: PolicyProfile,
): Promise<unknown> => {
  if (typeof input.screen_text !== "string") {
    throw new Error("input.screen_text must be a string");
  }
  const screenText = input.screen_text;

  if (mode === "mock") {
    return {
      screen_text: screenText,
      room_name: "Mock Room",
      exits: ["north", "south"],
      items: [],
      description: "A mock room for testing.",
    };
  }

  if (mode === "dry_run") {
    return {
      screen_text: screenText,
      room_name: "(dry_run)",
      exits: [],
      items: [],
      description: "[dry_run] Would parse screen text",
    };
  }

  // LLM mode: delegate to cartographer function if available
  if (cartographerFn) {
    const raw = await cartographerFn(screenText);
    // Parse "Room: X | Exits: a,b | Items: c,d | Desc: ..." format
    const parsed = parseCartographerResponse(raw);
    return {
      screen_text: screenText,
      ...parsed,
    };
  }

  // Scripted mode: return raw screen text with no parsing
  return {
    screen_text: screenText,
    room_name: "Unknown",
    exits: [],
    items: [],
    description: screenText.slice(0, 200),
  };
};

// ─── game-combat ─────────────────────────────────────────────────────────────

const COMBAT_END_VICTORY = /defeated|killed|dispatched|collapses|dies|staggers.*fall/i;
const COMBAT_END_DEATH   = /you have died|you are dead|\*\*\*\*.*you.*died/i;
const COMBAT_END_FLED    = /flees|retreats|runs away/i;
const COMBAT_END_WEAPON  = /breaks|shattered|disarmed/i;
const COMBAT_MAX_ROUNDS  = 10;

export const gameCombatHandler: ToolHandler = async (
  input: Record<string, unknown>,
  mode: ExecutionMode,
  _policy: PolicyProfile,
): Promise<unknown> => {
  const target = input.target as string;
  const weapon = input.weapon as string;
  if (typeof target !== "string" || typeof weapon !== "string") {
    throw new Error("input.target and input.weapon must be strings");
  }

  const attackCmd = `attack ${target} with ${weapon}`;

  if (mode === "mock") {
    return {
      outcome: "victory", rounds: 1, final_screen: ">mock\nThe enemy is defeated.",
      delta: "The enemy is defeated.", screen_text: ">mock\nThe enemy is defeated.",
    };
  }
  if (mode === "dry_run") {
    return {
      outcome: "victory", rounds: 0, final_screen: `[dry_run] Would loop: ${attackCmd}`,
      delta: `[dry_run] Would loop: ${attackCmd}`, screen_text: `[dry_run] Would loop: ${attackCmd}`,
    };
  }
  if (!emulatorRef) {
    throw new Error("No emulator configured — call setEmulator() before using game-combat");
  }

  const allDeltas: string[] = [];
  let rounds = 0;
  let outcome: "victory" | "death" | "fled" | "weapon_lost" | "max_rounds" = "max_rounds";
  let finalScreen = "";

  while (rounds < COMBAT_MAX_ROUNDS) {
    rounds++;
    const result = await emulatorRef.sendCommand(attackCmd);
    allDeltas.push(result.delta);
    finalScreen = result.output;

    if (COMBAT_END_DEATH.test(result.delta)) { outcome = "death"; break; }
    if (COMBAT_END_VICTORY.test(result.delta)) { outcome = "victory"; break; }
    if (COMBAT_END_FLED.test(result.delta)) { outcome = "fled"; break; }
    if (COMBAT_END_WEAPON.test(result.delta)) { outcome = "weapon_lost"; break; }
  }

  return {
    outcome,
    rounds,
    final_screen: finalScreen,
    delta: allDeltas.join("\n---\n"),
    screen_text: finalScreen,
  };
};

// ─── game-take-all ───────────────────────────────────────────────────────────

export const gameTakeAllHandler: ToolHandler = async (
  input: Record<string, unknown>,
  mode: ExecutionMode,
  _policy: PolicyProfile,
): Promise<unknown> => {
  const items = input.items as string[];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("input.items must be a non-empty string array");
  }

  if (mode === "mock") {
    return {
      taken: items, failed: [], final_screen: ">mock\nTaken.",
      screen_text: ">mock\nTaken.",
    };
  }
  if (mode === "dry_run") {
    return {
      taken: [], failed: [], final_screen: `[dry_run] Would take: ${items.join(", ")}`,
      screen_text: `[dry_run] Would take: ${items.join(", ")}`,
    };
  }
  if (!emulatorRef) {
    throw new Error("No emulator configured — call setEmulator() before using game-take-all");
  }

  const taken: string[] = [];
  const failed: string[] = [];
  let finalScreen = "";

  for (const item of items) {
    const result = await emulatorRef.sendCommand(`take ${item}`);
    finalScreen = result.output;
    if (/^taken\.?(\s|$)/im.test(result.delta)) {
      taken.push(item);
    } else {
      failed.push(item);
      break; // stop on first failure (inventory full, item gone, etc.)
    }
  }

  return {
    taken,
    failed,
    final_screen: finalScreen,
    screen_text: finalScreen,
  };
};

// ─── game-navigate ───────────────────────────────────────────────────────────

export const gameNavigateHandler: ToolHandler = async (
  input: Record<string, unknown>,
  mode: ExecutionMode,
  _policy: PolicyProfile,
): Promise<unknown> => {
  const steps = input.steps as Array<{ direction: string; destination: string }>;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("input.steps must be a non-empty array of {direction, destination}");
  }

  if (mode === "mock") {
    return {
      completed: steps.length, final_room: steps.at(-1)?.destination ?? "Mock Room",
      final_screen: ">mock\nYou are in a room.", screen_text: ">mock\nYou are in a room.",
      steps_taken: steps.map(s => ({ direction: s.direction, destination: s.destination, actual_room: s.destination })),
    };
  }
  if (mode === "dry_run") {
    return {
      completed: 0, final_room: "(dry_run)",
      final_screen: `[dry_run] Would navigate: ${steps.map(s => s.direction).join(" → ")}`,
      screen_text: `[dry_run] Would navigate: ${steps.map(s => s.direction).join(" → ")}`,
      steps_taken: [],
    };
  }
  if (!emulatorRef) {
    throw new Error("No emulator configured — call setEmulator() before using game-navigate");
  }

  const stepsTaken: Array<{ direction: string; destination: string; actual_room: string }> = [];
  let completed = 0;
  let finalScreen = "";
  let finalRoom = "";

  for (const step of steps) {
    const result = await emulatorRef.sendCommand(`go ${step.direction}`);
    finalScreen = result.output;
    const actual = result.roomHeader;

    stepsTaken.push({ direction: step.direction, destination: step.destination, actual_room: actual });
    completed++;
    finalRoom = actual;

    // Stop if we didn't arrive at expected destination (blocked, unexpected room)
    if (actual && step.destination && actual.toLowerCase() !== step.destination.toLowerCase()) {
      break;
    }
  }

  return {
    completed,
    final_room: finalRoom,
    final_screen: finalScreen,
    screen_text: finalScreen,
    steps_taken: stepsTaken,
  };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCartographerResponse(raw: string): {
  room_name: string;
  exits: string[];
  items: string[];
  description: string;
} {
  const roomMatch = raw.match(/Room:\s*([^|]+)/i);
  const exitsMatch = raw.match(/Exits:\s*([^|]+)/i);
  const itemsMatch = raw.match(/Items:\s*([^|]+)/i);
  const descMatch = raw.match(/Desc:\s*(.+)/i);

  const room_name = roomMatch?.[1]?.trim() ?? "Unknown";
  const exitsStr = exitsMatch?.[1]?.trim() ?? "";
  const itemsStr = itemsMatch?.[1]?.trim() ?? "";

  const exits = exitsStr && exitsStr.toLowerCase() !== "none" && exitsStr.toLowerCase() !== "unknown"
    ? exitsStr.split(",").map(e => e.trim()).filter(Boolean)
    : [];
  const items = itemsStr && itemsStr.toLowerCase() !== "none" && itemsStr.toLowerCase() !== "unknown"
    ? itemsStr.split(",").map(i => i.trim()).filter(Boolean)
    : [];
  const description = descMatch?.[1]?.trim() ?? "";

  return { room_name, exits, items, description };
}
