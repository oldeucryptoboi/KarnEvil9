import { describe, it, expect, vi } from "vitest";
import { IFPlanner } from "./if-planner.js";
import type { IFGameState, IFModelCallFn } from "./if-planner.js";

/** Minimal game state factory — all required fields with sensible defaults. */
function makeGameState(overrides: Partial<IFGameState> = {}): IFGameState {
  return {
    currentRoom: "Living Room",
    lastDelta: "You are in the living room.",
    fullScreen: "Living Room\nYou are in the living room.\nExits: north, east.",
    commandHistory: [],
    inventory: [],
    visitedRooms: ["Living Room"],
    futilityHint: "",
    failedCommands: [],
    blockedPuzzles: [],
    knownExits: ["north", "east"],
    roomItems: [],
    roomDirections: {},
    dirGraph: { "Living Room": { north: "Kitchen", east: "Garden" } },
    blockedExits: {},
    turnsStalled: 0,
    ...overrides,
  };
}

/** Create a mock callModel that returns a fixed command string. */
function mockModel(command: string): IFModelCallFn {
  return async () => ({
    text: `${command}\nGame: unknown | Confidence: 50% | Reason: test\nReasoning: test action`,
  });
}

/** Shortcut to extract the game command from a plan result. */
function getCommand(result: { plan: { steps: Array<{ input: Record<string, unknown> }> } }): string {
  return result.plan.steps[0]?.input?.command as string ?? "";
}

describe("IFPlanner", () => {
  // ─── Constructor ─────────────────────────────────────────────────

  describe("constructor", () => {
    it("accepts minimal config", () => {
      const planner = new IFPlanner({ callModel: mockModel("look") });
      expect(planner).toBeDefined();
      expect(planner.generatePlan).toBeTypeOf("function");
    });

    it("accepts all config options", () => {
      const verbose = vi.fn();
      const planner = new IFPlanner({
        callModel: mockModel("look"),
        blind: true,
        onVerbose: verbose,
      });
      expect(planner).toBeDefined();
    });
  });

  // ─── No game state (first iteration) ────────────────────────────

  describe("no game state", () => {
    it("returns 'look' plan when game state is undefined", async () => {
      const planner = new IFPlanner({ callModel: mockModel("look") });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        {}, // no context.game_state
        {},
      );
      expect(result.plan.goal).toBe("Initial room observation");
      expect(result.plan.steps).toHaveLength(2);
      expect(getCommand(result)).toBe("look");
    });
  });

  // ─── Game over ───────────────────────────────────────────────────

  describe("game over", () => {
    it("returns empty plan when gameOver is true", async () => {
      const planner = new IFPlanner({ callModel: mockModel("look") });
      const gs = makeGameState({ gameOver: true });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(result.plan.goal).toBe("Game complete");
      expect(result.plan.steps).toHaveLength(0);
    });
  });

  // ─── Standard plan structure ─────────────────────────────────────

  describe("plan structure", () => {
    it("produces 2-step plan: execute-game-command + parse-game-screen", async () => {
      const planner = new IFPlanner({ callModel: mockModel("go north") });
      const gs = makeGameState({ knownExits: [], turnsStalled: 0 });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(result.plan.steps).toHaveLength(2);
      expect(result.plan.steps[0]!.tool_ref.name).toBe("execute-game-command");
      expect(result.plan.steps[1]!.tool_ref.name).toBe("parse-game-screen");
      expect(result.plan.steps[1]!.depends_on).toContain(result.plan.steps[0]!.step_id);
    });

    it("passes usage metrics through from model call", async () => {
      const planner = new IFPlanner({
        callModel: async () => ({
          text: "go north",
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, model: "test" },
        }),
      });
      const gs = makeGameState({ knownExits: [], turnsStalled: 0 });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(result.usage).toBeDefined();
      expect(result.usage!.input_tokens).toBe(100);
    });
  });

  // ─── BFS navigation ─────────────────────────────────────────────

  describe("BFS navigation hint", () => {
    it("generates nav hint when unvisited rooms exist in dirGraph", async () => {
      const verbose = vi.fn();
      const planner = new IFPlanner({ callModel: mockModel("go north"), onVerbose: verbose });
      const gs = makeGameState({
        currentRoom: "Living Room",
        visitedRooms: ["Living Room"],
        dirGraph: { "Living Room": { north: "Kitchen" }, "Kitchen": { south: "Living Room" } },
        roomDirections: { north: "Kitchen" },
        knownExits: ["north"],
      });
      await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      const navCall = verbose.mock.calls.find(c => c[0] === "[NavHint]");
      expect(navCall).toBeDefined();
    });

    it("builds compound navigate plan when BFS path has >1 step", async () => {
      const planner = new IFPlanner({ callModel: mockModel("go north") });
      const gs = makeGameState({
        currentRoom: "A",
        visitedRooms: ["A", "B"],
        dirGraph: { "A": { north: "B" }, "B": { east: "C" }, "C": {} },
        roomDirections: { north: "B" },
        knownExits: ["north"],
      });
      // BFS: A → north → B → east → C (2 steps, unvisited target C)
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // The model says "go north" which matches first BFS step, so it should become a navigate plan
      expect(result.plan.steps[0]!.tool_ref.name).toBe("game-navigate");
      expect(result.plan.steps[0]!.input.steps).toHaveLength(2);
    });
  });

  // ─── Exploration exhaustion ──────────────────────────────────────

  describe("exploration exhaustion", () => {
    it("detects when all rooms are visited and all exits mapped", async () => {
      const verbose = vi.fn();
      const planner = new IFPlanner({ callModel: mockModel("examine rug"), onVerbose: verbose });
      const gs = makeGameState({
        currentRoom: "A",
        visitedRooms: ["A", "B"],
        dirGraph: { "A": { north: "B" }, "B": { south: "A" } },
        roomDirections: { north: "B" },
        knownExits: ["north"],
        turnsStalled: 0, // keep low so early stall probes don't fire
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // Exploration exhausted → anti-backtrack disabled, creative actions allowed
      expect(getCommand(result)).toBe("examine rug");
    });
  });

  // ─── Early stall probes ──────────────────────────────────────────

  describe("early stall probes", () => {
    it("fires after turnsStalled >= 3 when unexplored known exits exist", async () => {
      const planner = new IFPlanner({ callModel: mockModel("look") });
      const gs = makeGameState({
        turnsStalled: 3,
        knownExits: ["north", "east"],
        roomDirections: { north: "Kitchen" }, // east unexplored
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // Should probe the unexplored exit "east" instead of calling LLM
      expect(getCommand(result)).toBe("go east");
    });

    it("does not fire when turnsStalled < 3", async () => {
      const callModel = vi.fn(mockModel("go north"));
      const planner = new IFPlanner({ callModel });
      const gs = makeGameState({
        turnsStalled: 2,
        knownExits: ["north", "east"],
        roomDirections: { north: "Kitchen" },
      });
      await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // Should fall through to LLM since stalled < 3
      expect(callModel).toHaveBeenCalled();
    });

    it("probes non-compass directions when no unexplored known exits", async () => {
      const planner = new IFPlanner({ callModel: mockModel("look") });
      const gs = makeGameState({
        turnsStalled: 3,
        currentRoom: "Room A",
        knownExits: ["north"],
        roomDirections: { north: "Room B" },
        dirGraph: { "Room A": { north: "Room B" }, "Room B": { south: "Room A" } },
        visitedRooms: ["Room A", "Room B"],
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // Should try a non-compass hidden probe (in, out, up, or down)
      const cmd = getCommand(result);
      expect(["go in", "go out", "go up", "go down"]).toContain(cmd);
    });

    it("skips blocked exits during probing", async () => {
      const planner = new IFPlanner({ callModel: mockModel("examine door") });
      const gs = makeGameState({
        turnsStalled: 3,
        currentRoom: "Room A",
        knownExits: ["east"],
        roomDirections: {},
        blockedExits: { "Room A": ["east"] },
        dirGraph: { "Room A": {} },
        visitedRooms: ["Room A"],
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // east is blocked → filtered from candidates. blockedSet.size > 0 → non-compass skipped.
      // Falls through to LLM which returns "examine door".
      expect(getCommand(result)).toBe("examine door");
    });
  });

  // ─── Anti-backtrack ──────────────────────────────────────────────

  describe("anti-backtrack", () => {
    it("suppresses move to visited room when unexplored exits exist", async () => {
      const planner = new IFPlanner({ callModel: mockModel("go north") });
      const gs = makeGameState({
        currentRoom: "Living Room",
        visitedRooms: ["Living Room", "Kitchen"],
        knownExits: ["north", "east"],
        roomDirections: { north: "Kitchen" }, // east is unexplored
        dirGraph: {
          "Living Room": { north: "Kitchen", east: "Garden" },
          "Kitchen": { south: "Living Room" },
        },
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // LLM says "go north" (Kitchen, visited), but east is unexplored → redirect
      expect(getCommand(result)).toBe("go east");
    });

    it("allows backtrack when following nav hint first step", async () => {
      const planner = new IFPlanner({ callModel: mockModel("go north") });
      const gs = makeGameState({
        currentRoom: "A",
        visitedRooms: ["A", "B"],
        knownExits: ["north"],
        roomDirections: { north: "B" },
        dirGraph: {
          "A": { north: "B" },
          "B": { east: "C" },
          "C": {},
        },
      });
      // BFS: A → north → B → east → C (2 steps, C unvisited)
      // LLM says "go north" matching BFS first step → allow despite B being visited
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // Should produce a compound navigate plan through B to C
      expect(result.plan.steps[0]!.tool_ref.name).toBe("game-navigate");
      expect(result.plan.steps[0]!.input.steps).toHaveLength(2);
    });

    it("disables anti-backtrack when exploration is exhausted", async () => {
      const planner = new IFPlanner({ callModel: mockModel("go north") });
      const gs = makeGameState({
        currentRoom: "A",
        visitedRooms: ["A", "B"],
        knownExits: ["north"],
        roomDirections: { north: "B" },
        dirGraph: { "A": { north: "B" }, "B": { south: "A" } },
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // All rooms visited, all exits mapped — exploration exhausted
      // Anti-backtrack disabled, so "go north" should be allowed
      expect(getCommand(result)).toBe("go north");
    });
  });

  // ─── Compound plans ──────────────────────────────────────────────

  describe("compound plans", () => {
    it("builds combat plan for 'attack X with Y'", async () => {
      const planner = new IFPlanner({ callModel: mockModel("attack troll with sword") });
      const gs = makeGameState({ knownExits: [] });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(result.plan.steps[0]!.tool_ref.name).toBe("game-combat");
      expect(result.plan.steps[0]!.input.target).toBe("troll");
      expect(result.plan.steps[0]!.input.weapon).toBe("sword");
    });

    it("builds take-all plan when room has multiple items", async () => {
      const planner = new IFPlanner({ callModel: mockModel("take sword") });
      const gs = makeGameState({
        knownExits: [],
        roomItems: ["sword", "lamp", "key"],
        inventory: [],
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(result.plan.steps[0]!.tool_ref.name).toBe("game-take-all");
      expect(result.plan.steps[0]!.input.items).toEqual(["sword", "lamp", "key"]);
    });

    it("does not take-all for items already in inventory", async () => {
      const planner = new IFPlanner({ callModel: mockModel("take key") });
      const gs = makeGameState({
        knownExits: [],
        roomItems: ["sword", "key"],
        inventory: ["sword"], // already have sword
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // Only 1 item not in inventory → no take-all (requires >1 items)
      expect(result.plan.steps[0]!.tool_ref.name).toBe("execute-game-command");
    });
  });

  // ─── LLM response parsing ───────────────────────────────────────

  describe("LLM response parsing", () => {
    it("strips quotes and punctuation from command", async () => {
      const planner = new IFPlanner({
        callModel: async () => ({
          text: '"go north."\nGame: test\nReasoning: test',
        }),
      });
      const gs = makeGameState({ knownExits: [] });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(getCommand(result)).toBe("go north");
    });

    it("defaults to 'look' when LLM returns only Game/Reasoning lines", async () => {
      const planner = new IFPlanner({
        callModel: async () => ({
          text: "Game: unknown | Confidence: 10%\nReasoning: confused",
        }),
      });
      const gs = makeGameState({ knownExits: [] });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(getCommand(result)).toBe("look");
    });

    it("lowercases the command", async () => {
      const planner = new IFPlanner({
        callModel: async () => ({ text: "EXAMINE RUG" }),
      });
      const gs = makeGameState({ knownExits: [] });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(getCommand(result)).toBe("examine rug");
    });
  });

  // ─── Look suppression ───────────────────────────────────────────

  describe("look suppression", () => {
    it("suppresses 'look' when exits are already known and exploration not exhausted", async () => {
      const planner = new IFPlanner({ callModel: mockModel("look") });
      const gs = makeGameState({
        knownExits: ["north", "east"],
        roomDirections: { north: "Kitchen" }, // east is unexplored
      });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // Should redirect to unexplored exit instead of look
      expect(getCommand(result)).toBe("go east");
    });

    it("allows 'look' when no exits are known", async () => {
      const planner = new IFPlanner({ callModel: mockModel("look") });
      const gs = makeGameState({ knownExits: [] });
      const result = await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(getCommand(result)).toBe("look");
    });
  });

  // ─── Blind mode ──────────────────────────────────────────────────

  describe("blind mode", () => {
    it("masks game-identifying text in prompts", async () => {
      let _capturedSystem = "";
      let capturedUser = "";
      const planner = new IFPlanner({
        callModel: async (system, user) => {
          _capturedSystem = system;
          capturedUser = user;
          return { text: "go north" };
        },
        blind: true,
      });
      const gs = makeGameState({
        knownExits: [],
        currentRoom: "West of House",
        lastDelta: "ZORK I: The Great Underground Empire",
        fullScreen: "ZORK I\nCopyright 1981 Infocom\nRevision 88 / Serial number 840726",
      });
      await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      // Game-identifying text should be masked in user prompt
      expect(capturedUser).not.toContain("ZORK");
      expect(capturedUser).not.toContain("Infocom");
      // Room names are NOT masked
      expect(capturedUser).toContain("West of House");
    });
  });

  // ─── Verbose callback ───────────────────────────────────────────

  describe("verbose callback", () => {
    it("fires for recognition and reasoning lines", async () => {
      const verbose = vi.fn();
      const planner = new IFPlanner({
        callModel: async () => ({
          text: "go north\nGame: Zork | Confidence: 90%\nReasoning: exploring the house",
        }),
        onVerbose: verbose,
      });
      const gs = makeGameState({ knownExits: [] });
      await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      const labels = verbose.mock.calls.map(c => c[0]);
      expect(labels).toContain("[Recognition]");
      expect(labels).toContain("[Reasoning]");
      expect(labels).toContain("[Strategist/full]");
    });
  });

  // ─── Custom BFS pathfinder ──────────────────────────────────────

  describe("custom BFS pathfinder", () => {
    it("uses injected bfsPathFinder", async () => {
      const customBfs = vi.fn().mockReturnValue([
        { direction: "south", destination: "Secret Room" },
      ]);
      const planner = new IFPlanner({
        callModel: mockModel("go south"),
        bfsPathFinder: customBfs,
      });
      const gs = makeGameState({
        currentRoom: "A",
        visitedRooms: ["A"],
        dirGraph: { "A": { south: "Secret Room" }, "Secret Room": {} },
        roomDirections: { south: "Secret Room" },
        knownExits: ["south"],
      });
      await planner.generatePlan(
        { task_id: "t1", text: "play game", submitted_by: "test", created_at: new Date().toISOString() },
        [],
        { context: { game_state: gs } },
        {},
      );
      expect(customBfs).toHaveBeenCalled();
    });
  });
});
