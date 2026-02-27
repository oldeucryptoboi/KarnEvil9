import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PolicyProfile } from "@karnevil9/schemas";
import type { EmulatorLike } from "./game-emulator.js";
import {
  executeGameCommandHandler,
  parseGameScreenHandler,
  gameCombatHandler,
  gameTakeAllHandler,
  gameNavigateHandler,
  setEmulator,
  setCartographerFn,
} from "./game-emulator.js";

const openPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

function makeEmulator(overrides?: Partial<EmulatorLike>): EmulatorLike {
  return {
    sendCommand: vi.fn().mockResolvedValue({
      output: ">You are in a room.",
      delta: "You are in a room.",
      roomHeader: "Test Room",
      success: true,
      durationMs: 10,
    }),
    readScreen: vi.fn().mockResolvedValue(null),
    skipTurn: vi.fn(),
    ...overrides,
  };
}

describe("executeGameCommandHandler", () => {
  afterEach(() => {
    setEmulator(null as unknown as EmulatorLike);
  });

  it("returns mock output in mock mode", async () => {
    const result = await executeGameCommandHandler({ command: "look" }, "mock", openPolicy) as Record<string, unknown>;
    expect(result.delta).toBe("(mock) You are in a room.");
    expect(result.room_header).toBe("Mock Room");
    expect(result.success).toBe(true);
  });

  it("returns dry_run output in dry_run mode", async () => {
    const result = await executeGameCommandHandler({ command: "go north" }, "dry_run", openPolicy) as Record<string, unknown>;
    expect(result.delta).toBe("[dry_run] Would execute: go north");
    expect(result.room_header).toBe("(dry_run)");
    expect(result.success).toBe(true);
  });

  it("rejects non-string command", async () => {
    await expect(executeGameCommandHandler({ command: 123 }, "live", openPolicy)).rejects.toThrow("input.command must be a string");
  });

  it("rejects missing command", async () => {
    await expect(executeGameCommandHandler({}, "live", openPolicy)).rejects.toThrow("input.command must be a string");
  });

  it("throws when no emulator configured in real mode", async () => {
    await expect(executeGameCommandHandler({ command: "look" }, "live", openPolicy)).rejects.toThrow("No emulator configured");
  });

  it("delegates to emulator in real mode", async () => {
    const emu = makeEmulator();
    setEmulator(emu);
    const result = await executeGameCommandHandler({ command: "look" }, "live", openPolicy) as Record<string, unknown>;
    expect(emu.sendCommand).toHaveBeenCalledWith("look");
    expect(result.delta).toBe("You are in a room.");
    expect(result.room_header).toBe("Test Room");
    expect(result.success).toBe(true);
    expect(result.duration_ms).toBe(10);
  });
});

describe("parseGameScreenHandler", () => {
  afterEach(() => {
    setEmulator(null as unknown as EmulatorLike);
    setCartographerFn(null as unknown as (s: string) => Promise<string>);
  });

  it("returns mock output in mock mode", async () => {
    const result = await parseGameScreenHandler({ screen_text: "test" }, "mock", openPolicy) as Record<string, unknown>;
    expect(result.room_name).toBe("Mock Room");
    expect(result.exits).toEqual(["north", "south"]);
    expect(result.screen_text).toBe("test");
  });

  it("returns dry_run output in dry_run mode", async () => {
    const result = await parseGameScreenHandler({ screen_text: "test" }, "dry_run", openPolicy) as Record<string, unknown>;
    expect(result.room_name).toBe("(dry_run)");
    expect(result.exits).toEqual([]);
  });

  it("rejects non-string screen_text", async () => {
    await expect(parseGameScreenHandler({ screen_text: 42 }, "live", openPolicy)).rejects.toThrow("input.screen_text must be a string");
  });

  it("returns raw screen text without cartographer", async () => {
    const result = await parseGameScreenHandler({ screen_text: "You are in a dark cave." }, "live", openPolicy) as Record<string, unknown>;
    expect(result.room_name).toBe("Unknown");
    expect(result.exits).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.description).toBe("You are in a dark cave.");
  });

  it("delegates to cartographer when configured", async () => {
    const cartographer = vi.fn().mockResolvedValue("Room: Dark Cave | Exits: north, south | Items: sword, shield | Desc: A damp cave");
    setCartographerFn(cartographer);
    const result = await parseGameScreenHandler({ screen_text: "cave text" }, "live", openPolicy) as Record<string, unknown>;
    expect(cartographer).toHaveBeenCalledWith("cave text");
    expect(result.room_name).toBe("Dark Cave");
    expect(result.exits).toEqual(["north", "south"]);
    expect(result.items).toEqual(["sword", "shield"]);
    expect(result.description).toBe("A damp cave");
  });

  it("handles cartographer response with 'none' items", async () => {
    setCartographerFn(vi.fn().mockResolvedValue("Room: Hall | Exits: east | Items: none | Desc: Empty hall"));
    const result = await parseGameScreenHandler({ screen_text: "hall" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.items).toEqual([]);
    expect(result.exits).toEqual(["east"]);
  });

  it("handles cartographer response with 'unknown' exits", async () => {
    setCartographerFn(vi.fn().mockResolvedValue("Room: Void | Exits: unknown | Items: key | Desc: Darkness"));
    const result = await parseGameScreenHandler({ screen_text: "void" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.exits).toEqual([]);
    expect(result.items).toEqual(["key"]);
  });

  it("handles malformed cartographer response gracefully", async () => {
    setCartographerFn(vi.fn().mockResolvedValue("This is not a structured response"));
    const result = await parseGameScreenHandler({ screen_text: "test" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.room_name).toBe("Unknown");
    expect(result.exits).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.description).toBe("");
  });

  it("handles empty cartographer response", async () => {
    setCartographerFn(vi.fn().mockResolvedValue(""));
    const result = await parseGameScreenHandler({ screen_text: "test" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.room_name).toBe("Unknown");
    expect(result.exits).toEqual([]);
    expect(result.items).toEqual([]);
  });
});

describe("gameCombatHandler", () => {
  afterEach(() => {
    setEmulator(null as unknown as EmulatorLike);
  });

  it("returns mock output in mock mode", async () => {
    const result = await gameCombatHandler({ target: "troll", weapon: "sword" }, "mock", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("victory");
    expect(result.rounds).toBe(1);
  });

  it("returns dry_run output in dry_run mode", async () => {
    const result = await gameCombatHandler({ target: "troll", weapon: "sword" }, "dry_run", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("victory");
    expect(result.rounds).toBe(0);
    expect(result.delta).toContain("attack troll with sword");
  });

  it("rejects non-string target", async () => {
    await expect(gameCombatHandler({ target: 1, weapon: "sword" }, "live", openPolicy)).rejects.toThrow("input.target and input.weapon must be strings");
  });

  it("rejects non-string weapon", async () => {
    await expect(gameCombatHandler({ target: "troll", weapon: null }, "live", openPolicy)).rejects.toThrow("input.target and input.weapon must be strings");
  });

  it("throws when no emulator configured in real mode", async () => {
    await expect(gameCombatHandler({ target: "troll", weapon: "sword" }, "live", openPolicy)).rejects.toThrow("No emulator configured");
  });

  it("detects victory outcome", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn()
        .mockResolvedValueOnce({ output: "...", delta: "You swing the sword.", roomHeader: "Arena", success: true, durationMs: 5 })
        .mockResolvedValueOnce({ output: "...", delta: "The troll is defeated!", roomHeader: "Arena", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const result = await gameCombatHandler({ target: "troll", weapon: "sword" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("victory");
    expect(result.rounds).toBe(2);
    expect(emu.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("detects death outcome", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: "You have died.", roomHeader: "Arena", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const result = await gameCombatHandler({ target: "dragon", weapon: "stick" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("death");
    expect(result.rounds).toBe(1);
  });

  it("detects fled outcome", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: "The goblin flees in terror!", roomHeader: "Arena", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const result = await gameCombatHandler({ target: "goblin", weapon: "sword" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("fled");
    expect(result.rounds).toBe(1);
  });

  it("detects weapon_lost outcome", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: "Your sword breaks!", roomHeader: "Arena", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const result = await gameCombatHandler({ target: "golem", weapon: "sword" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("weapon_lost");
    expect(result.rounds).toBe(1);
  });

  it("returns max_rounds after 25 rounds with no resolution", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: "You miss.", roomHeader: "Arena", success: true, durationMs: 1 }),
    });
    setEmulator(emu);
    const result = await gameCombatHandler({ target: "wall", weapon: "fist" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("max_rounds");
    expect(result.rounds).toBe(25);
    expect(emu.sendCommand).toHaveBeenCalledTimes(25);
  });

  it("accumulates deltas across combat rounds", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn()
        .mockResolvedValueOnce({ output: "...", delta: "Round 1 miss.", roomHeader: "Arena", success: true, durationMs: 1 })
        .mockResolvedValueOnce({ output: "...", delta: "Round 2 hit.", roomHeader: "Arena", success: true, durationMs: 1 })
        .mockResolvedValueOnce({ output: "...", delta: "The enemy collapses!", roomHeader: "Arena", success: true, durationMs: 1 }),
    });
    setEmulator(emu);
    const result = await gameCombatHandler({ target: "rat", weapon: "stick" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("victory");
    expect(result.rounds).toBe(3);
    expect(result.delta).toContain("Round 1 miss.");
    expect(result.delta).toContain("Round 2 hit.");
    expect(result.delta).toContain("The enemy collapses!");
  });

  it("prioritizes death over victory when both match", async () => {
    // "you have died" is checked before victory patterns
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: "You have died. The enemy is also defeated.", roomHeader: "Arena", success: true, durationMs: 1 }),
    });
    setEmulator(emu);
    const result = await gameCombatHandler({ target: "lich", weapon: "sword" }, "live", openPolicy) as Record<string, unknown>;
    expect(result.outcome).toBe("death");
  });

  it("matches various victory keywords", async () => {
    const victoryPhrases = [
      "The orc drops dead",
      "The skeleton crumbles to dust",
      "The ghost vanishes",
      "The rat is dead",
      "The spider dissolves",
      "The thief slumps over",
    ];
    for (const phrase of victoryPhrases) {
      const emu = makeEmulator({
        sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: phrase, roomHeader: "Arena", success: true, durationMs: 1 }),
      });
      setEmulator(emu);
      const result = await gameCombatHandler({ target: "enemy", weapon: "sword" }, "live", openPolicy) as Record<string, unknown>;
      expect(result.outcome).toBe("victory");
    }
  });
});

describe("gameTakeAllHandler", () => {
  afterEach(() => {
    setEmulator(null as unknown as EmulatorLike);
  });

  it("returns mock output in mock mode", async () => {
    const result = await gameTakeAllHandler({ items: ["sword", "shield"] }, "mock", openPolicy) as Record<string, unknown>;
    expect(result.taken).toEqual(["sword", "shield"]);
    expect(result.failed).toEqual([]);
  });

  it("returns dry_run output in dry_run mode", async () => {
    const result = await gameTakeAllHandler({ items: ["key"] }, "dry_run", openPolicy) as Record<string, unknown>;
    expect(result.taken).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.final_screen).toContain("key");
  });

  it("rejects non-array items", async () => {
    await expect(gameTakeAllHandler({ items: "sword" }, "live", openPolicy)).rejects.toThrow("input.items must be a non-empty string array");
  });

  it("rejects empty items array", async () => {
    await expect(gameTakeAllHandler({ items: [] }, "live", openPolicy)).rejects.toThrow("input.items must be a non-empty string array");
  });

  it("throws when no emulator configured", async () => {
    await expect(gameTakeAllHandler({ items: ["sword"] }, "live", openPolicy)).rejects.toThrow("No emulator configured");
  });

  it("takes all items successfully", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: ">", delta: "Taken.", roomHeader: "Room", success: true, durationMs: 1 }),
    });
    setEmulator(emu);
    const result = await gameTakeAllHandler({ items: ["sword", "shield", "key"] }, "live", openPolicy) as Record<string, unknown>;
    expect(result.taken).toEqual(["sword", "shield", "key"]);
    expect(result.failed).toEqual([]);
    expect(emu.sendCommand).toHaveBeenCalledWith("take sword");
    expect(emu.sendCommand).toHaveBeenCalledWith("take shield");
    expect(emu.sendCommand).toHaveBeenCalledWith("take key");
  });

  it("stops on first failure and records it", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn()
        .mockResolvedValueOnce({ output: ">", delta: "Taken.", roomHeader: "Room", success: true, durationMs: 1 })
        .mockResolvedValueOnce({ output: ">", delta: "You can't take that.", roomHeader: "Room", success: true, durationMs: 1 })
        .mockResolvedValueOnce({ output: ">", delta: "Taken.", roomHeader: "Room", success: true, durationMs: 1 }),
    });
    setEmulator(emu);
    const result = await gameTakeAllHandler({ items: ["sword", "boulder", "key"] }, "live", openPolicy) as Record<string, unknown>;
    expect(result.taken).toEqual(["sword"]);
    expect(result.failed).toEqual(["boulder"]);
    // Third item should NOT be attempted
    expect(emu.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("matches 'Taken' with trailing period and whitespace", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: ">", delta: "Taken. \n", roomHeader: "Room", success: true, durationMs: 1 }),
    });
    setEmulator(emu);
    const result = await gameTakeAllHandler({ items: ["gem"] }, "live", openPolicy) as Record<string, unknown>;
    expect(result.taken).toEqual(["gem"]);
  });

  it("matches 'Taken' case-insensitively", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: ">", delta: "taken.", roomHeader: "Room", success: true, durationMs: 1 }),
    });
    setEmulator(emu);
    const result = await gameTakeAllHandler({ items: ["coin"] }, "live", openPolicy) as Record<string, unknown>;
    expect(result.taken).toEqual(["coin"]);
  });

  it("handles all items failing on first attempt", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: ">", delta: "That's fixed in place.", roomHeader: "Room", success: true, durationMs: 1 }),
    });
    setEmulator(emu);
    const result = await gameTakeAllHandler({ items: ["statue", "table"] }, "live", openPolicy) as Record<string, unknown>;
    expect(result.taken).toEqual([]);
    expect(result.failed).toEqual(["statue"]);
    expect(emu.sendCommand).toHaveBeenCalledTimes(1);
  });
});

describe("gameNavigateHandler", () => {
  afterEach(() => {
    setEmulator(null as unknown as EmulatorLike);
  });

  it("returns mock output in mock mode", async () => {
    const steps = [{ direction: "north", destination: "Hallway" }, { direction: "east", destination: "Library" }];
    const result = await gameNavigateHandler({ steps }, "mock", openPolicy) as Record<string, unknown>;
    expect(result.completed).toBe(2);
    expect(result.final_room).toBe("Library");
    expect((result.steps_taken as unknown[]).length).toBe(2);
  });

  it("returns dry_run output in dry_run mode", async () => {
    const steps = [{ direction: "north", destination: "Hall" }];
    const result = await gameNavigateHandler({ steps }, "dry_run", openPolicy) as Record<string, unknown>;
    expect(result.completed).toBe(0);
    expect(result.final_room).toBe("(dry_run)");
    expect(result.final_screen).toContain("north");
  });

  it("rejects non-array steps", async () => {
    await expect(gameNavigateHandler({ steps: "north" }, "live", openPolicy)).rejects.toThrow("input.steps must be a non-empty array");
  });

  it("rejects empty steps array", async () => {
    await expect(gameNavigateHandler({ steps: [] }, "live", openPolicy)).rejects.toThrow("input.steps must be a non-empty array");
  });

  it("throws when no emulator configured", async () => {
    await expect(gameNavigateHandler({ steps: [{ direction: "n", destination: "X" }] }, "live", openPolicy)).rejects.toThrow("No emulator configured");
  });

  it("navigates through multiple rooms successfully", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn()
        .mockResolvedValueOnce({ output: "...", delta: "You go north.", roomHeader: "Hallway", success: true, durationMs: 5 })
        .mockResolvedValueOnce({ output: "...", delta: "You go east.", roomHeader: "Library", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const steps = [{ direction: "north", destination: "Hallway" }, { direction: "east", destination: "Library" }];
    const result = await gameNavigateHandler({ steps }, "live", openPolicy) as Record<string, unknown>;
    expect(result.completed).toBe(2);
    expect(result.final_room).toBe("Library");
    expect(emu.sendCommand).toHaveBeenCalledWith("go north");
    expect(emu.sendCommand).toHaveBeenCalledWith("go east");
  });

  it("stops on destination mismatch", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn()
        .mockResolvedValueOnce({ output: "...", delta: "You go north.", roomHeader: "Kitchen", success: true, durationMs: 5 })
        .mockResolvedValueOnce({ output: "...", delta: "You go east.", roomHeader: "Library", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const steps = [{ direction: "north", destination: "Hallway" }, { direction: "east", destination: "Library" }];
    const result = await gameNavigateHandler({ steps }, "live", openPolicy) as Record<string, unknown>;
    // Stops after first step because Kitchen !== Hallway
    expect(result.completed).toBe(1);
    expect(result.final_room).toBe("Kitchen");
    expect(emu.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("matches destination case-insensitively", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: "You go north.", roomHeader: "HALLWAY", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const steps = [{ direction: "north", destination: "hallway" }];
    const result = await gameNavigateHandler({ steps }, "live", openPolicy) as Record<string, unknown>;
    expect(result.completed).toBe(1);
    expect(result.final_room).toBe("HALLWAY");
  });

  it("continues when roomHeader is empty (no room detection)", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: "You go north.", roomHeader: "", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const steps = [
      { direction: "north", destination: "Hall" },
      { direction: "south", destination: "Lobby" },
    ];
    const result = await gameNavigateHandler({ steps }, "live", openPolicy) as Record<string, unknown>;
    // Empty roomHeader is falsy, so the mismatch check is skipped
    expect(result.completed).toBe(2);
  });

  it("records steps_taken with actual room names", async () => {
    const emu = makeEmulator({
      sendCommand: vi.fn().mockResolvedValue({ output: "...", delta: "Moved.", roomHeader: "Hall", success: true, durationMs: 5 }),
    });
    setEmulator(emu);
    const steps = [{ direction: "north", destination: "Hall" }];
    const result = await gameNavigateHandler({ steps }, "live", openPolicy) as Record<string, unknown>;
    const taken = result.steps_taken as Array<{ direction: string; destination: string; actual_room: string }>;
    expect(taken).toEqual([{ direction: "north", destination: "Hall", actual_room: "Hall" }]);
  });
});
