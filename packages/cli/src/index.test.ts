/**
 * Tests for packages/cli/src/index.ts
 *
 * Since index.ts is a CLI entry point with side-effects (Commander setup, process handlers),
 * we mock all heavy dependencies and test the utility functions and command structures
 * through Commander's programmatic interface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Mock all heavy dependencies before importing index.ts              *
 * ------------------------------------------------------------------ */

// Track process.on calls to verify error handlers
const processOnCalls: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
const originalProcessOn = process.on.bind(process);

const mockJournal = {
  init: vi.fn().mockResolvedValue(undefined),
  on: vi.fn().mockReturnValue(() => {}),
  close: vi.fn().mockResolvedValue(undefined),
  readAll: vi.fn().mockResolvedValue([]),
  readSession: vi.fn().mockResolvedValue([]),
  verifyIntegrity: vi.fn().mockResolvedValue({ valid: true }),
  registerShutdownHandler: vi.fn().mockReturnValue(() => {}),
};

const mockToolRegistry = {
  loadFromDirectory: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockReturnValue([]),
  get: vi.fn(),
  getSchemasForPlanner: vi.fn().mockReturnValue([]),
};

const mockToolRuntime = {
  registerHandler: vi.fn(),
};

const mockPermissionEngine = {};

const mockKernel = {
  createSession: vi.fn().mockResolvedValue({ session_id: "test-session", status: "created" }),
  run: vi.fn().mockResolvedValue({ session_id: "test-session", status: "completed" }),
  getTaskState: vi.fn().mockReturnValue(null),
  getUsageSummary: vi.fn().mockReturnValue(null),
};

const mockPluginRegistry = {
  discoverAndLoadAll: vi.fn().mockResolvedValue([]),
  listPlugins: vi.fn().mockReturnValue([]),
  getPlugin: vi.fn(),
  reloadPlugin: vi.fn(),
  getPluginPermissions: vi.fn().mockReturnValue([]),
  getPluginApi: vi.fn(),
  getCommands: vi.fn().mockReturnValue([]),
};

const mockActiveMemory = {
  load: vi.fn().mockResolvedValue(undefined),
};

const mockScheduleStore = {
  size: 0,
};

const mockScheduler = {
  start: vi.fn().mockResolvedValue(undefined),
};

const mockApiServer = {
  listen: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  registerApproval: vi.fn(),
};

const mockMetricsCollector = {};

vi.mock("dotenv/config", () => ({}));

vi.mock("@karnevil9/journal", () => ({
  Journal: vi.fn().mockImplementation(() => mockJournal),
}));

vi.mock("@karnevil9/tools", () => ({
  ToolRegistry: vi.fn().mockImplementation(() => mockToolRegistry),
  ToolRuntime: vi.fn().mockImplementation(() => mockToolRuntime),
  respondHandler: vi.fn(),
  readFileHandler: vi.fn(),
  writeFileHandler: vi.fn(),
  shellExecHandler: vi.fn(),
  httpRequestHandler: vi.fn(),
  createBrowserHandler: vi.fn().mockReturnValue(vi.fn()),
  executeGameCommandHandler: vi.fn(),
  parseGameScreenHandler: vi.fn(),
  gameCombatHandler: vi.fn(),
  gameTakeAllHandler: vi.fn(),
  gameNavigateHandler: vi.fn(),
  setEmulator: vi.fn(),
}));

vi.mock("@karnevil9/permissions", () => ({
  PermissionEngine: vi.fn().mockImplementation(() => mockPermissionEngine),
}));

vi.mock("@karnevil9/kernel", () => ({
  Kernel: vi.fn().mockImplementation(() => mockKernel),
}));

vi.mock("./llm-adapters.js", () => ({
  createPlanner: vi.fn().mockReturnValue({
    generatePlan: vi.fn().mockResolvedValue({
      plan: { plan_id: "p1", schema_version: "0.1", goal: "test", steps: [] },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, model: "mock" },
    }),
  }),
}));

vi.mock("./game-session-manager.js", () => ({
  GameSessionManager: vi.fn().mockImplementation(() => ({
    isLocked: vi.fn().mockReturnValue(false),
    acquireSession: vi.fn(),
    releaseSession: vi.fn(),
    loadCheckpoint: vi.fn().mockReturnValue(null),
    currentEmulator: null,
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@karnevil9/api", () => ({
  ApiServer: vi.fn().mockImplementation(() => mockApiServer),
}));

vi.mock("@karnevil9/metrics", () => ({
  MetricsCollector: vi.fn().mockImplementation(() => mockMetricsCollector),
}));

vi.mock("@karnevil9/plugins", () => ({
  PluginRegistry: vi.fn().mockImplementation(() => mockPluginRegistry),
}));

vi.mock("@karnevil9/memory", () => ({
  ActiveMemory: vi.fn().mockImplementation(() => mockActiveMemory),
}));

vi.mock("@karnevil9/scheduler", () => ({
  ScheduleStore: vi.fn().mockImplementation(() => mockScheduleStore),
  Scheduler: vi.fn().mockImplementation(() => mockScheduler),
}));

vi.mock("@karnevil9/swarm", () => ({
  MeshManager: vi.fn(),
  WorkDistributor: vi.fn(),
  DEFAULT_SWARM_CONFIG: {},
}));

vi.mock("@karnevil9/browser-relay", () => ({
  ManagedDriver: vi.fn(),
  ExtensionDriver: vi.fn(),
  RelayServer: vi.fn(),
}));

// Mock commander to avoid process.exit on parse
const mockCommands = new Map<string, { description: string; action?: (...args: unknown[]) => Promise<void> }>();

vi.mock("commander", () => {
  class MockCommand {
    private _name = "";
    private _commands = new Map<string, MockCommand>();
    private _action: ((...args: unknown[]) => Promise<void>) | null = null;

    name(n: string) { this._name = n; return this; }
    description() { return this; }
    version() { return this; }
    argument() { return this; }
    option() { return this; }
    command(name: string) {
      const sub = new MockCommand();
      sub._name = name;
      this._commands.set(name, sub);
      mockCommands.set(name, { description: name });
      return sub;
    }
    action(fn: (...args: unknown[]) => Promise<void>) {
      this._action = fn;
      return this;
    }
    parse() {
      // no-op: don't actually parse CLI args
    }
  }
  return { Command: MockCommand };
});

// Mock readline for cliApprovalPrompt
vi.mock("node:readline", () => ({
  createInterface: vi.fn().mockReturnValue({
    question: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  }),
}));

/* ------------------------------------------------------------------ *
 *  Import index.ts — triggers module-level code execution             *
 * ------------------------------------------------------------------ */

describe("CLI index.ts module", () => {
  it("loads the module and registers Commander commands without errors", async () => {
    // Importing the module will execute the top-level code:
    // - Function definitions (parsePort, parsePositiveInt, cliApprovalPrompt, createRuntime)
    // - Commander program setup (all .command() calls)
    // - process.on handlers
    // - Constants (JOURNAL_PATH, TOOLS_DIR, etc.)
    await import("./index.js");

    // Verify commander commands were registered
    expect(mockCommands.size).toBeGreaterThan(0);
  });
});
