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
