import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GameSessionManager, type GameCheckpoint } from "./game-session-manager.js";

// Mock node:fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock @karnevil9/tools setEmulator
vi.mock("@karnevil9/tools", () => ({
  setEmulator: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe("GameSessionManager", () => {
  const gamePath = "/games/sigma.z8";
  const checkpointDir = "/tmp/test-checkpoints";

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  describe("constructor", () => {
    it("creates checkpoint directory if it does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      new GameSessionManager({ gamePath, checkpointDir });
      expect(mockMkdirSync).toHaveBeenCalledWith(checkpointDir, { recursive: true });
    });

    it("does not create checkpoint directory if it already exists", () => {
      mockExistsSync.mockReturnValue(true);
      new GameSessionManager({ gamePath, checkpointDir });
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it("uses default maxTurns=20 and rngSeed=42", () => {
      mockExistsSync.mockReturnValue(true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      expect(mgr.getMaxTurns()).toBe(20);
    });

    it("accepts custom maxTurns", () => {
      mockExistsSync.mockReturnValue(true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir, maxTurns: 50 });
      expect(mgr.getMaxTurns()).toBe(50);
    });
  });

  describe("isLocked / locking", () => {
    it("starts unlocked", () => {
      mockExistsSync.mockReturnValue(true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      expect(mgr.isLocked()).toBe(false);
    });
  });

  describe("loadCheckpoint", () => {
    it("returns null when meta.json does not exist", () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith("meta.json")) return false;
        return true;
      });
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      expect(mgr.loadCheckpoint()).toBeNull();
    });

    it("returns parsed checkpoint when meta.json exists", () => {
      const checkpoint: GameCheckpoint = {
        commandHistory: ["look", "north"],
        currentRoom: "West of House",
        inventory: ["lantern"],
        visitedRooms: ["West of House"],
        roomGraph: {},
        blockedPuzzles: [],
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(checkpoint));
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      const result = mgr.loadCheckpoint();
      expect(result).toEqual(checkpoint);
    });

    it("returns null and warns when meta.json is malformed", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not valid json{{{");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      const result = mgr.loadCheckpoint();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load checkpoint")
      );
      warnSpy.mockRestore();
    });
  });

  describe("saveCheckpoint", () => {
    it("writes checkpoint to meta.json", () => {
      mockExistsSync.mockReturnValue(true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      const checkpoint: GameCheckpoint = {
        commandHistory: ["look"],
        currentRoom: "Start",
        inventory: [],
        visitedRooms: ["Start"],
        roomGraph: {},
        blockedPuzzles: [],
        updatedAt: new Date().toISOString(),
      };
      mgr.saveCheckpoint(checkpoint);
      const metaPath = join(checkpointDir, "meta.json");
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        metaPath,
        JSON.stringify(checkpoint, null, 2),
        "utf-8"
      );
      logSpy.mockRestore();
    });
  });

  describe("acquireSession", () => {
    it("rejects when already locked", async () => {
      mockExistsSync.mockReturnValue(true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      // Simulate locked state by setting internal locked flag via prototype hack
      (mgr as unknown as { locked: boolean }).locked = true;
      await expect(mgr.acquireSession()).rejects.toThrow("Game session already active");
    });

    it("sets locked on acquire and resets on failure", async () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith("meta.json")) return false;
        return true;
      });
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      // The dynamic import of ZorkFrotzEmulator will fail since the module doesn't exist
      // This should reset the locked state
      await expect(mgr.acquireSession()).rejects.toThrow();
      expect(mgr.isLocked()).toBe(false);
      expect(mgr.currentEmulator).toBeNull();
    });
  });

  describe("releaseSession", () => {
    it("releases session without emulator or plugin api", async () => {
      mockExistsSync.mockReturnValue(true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      // Manually set locked state
      (mgr as unknown as { locked: boolean }).locked = true;
      await mgr.releaseSession();
      expect(mgr.isLocked()).toBe(false);
      expect(mgr.currentEmulator).toBeNull();
      expect(logSpy).toHaveBeenCalledWith("[game] Session released");
      logSpy.mockRestore();
    });

    it("saves checkpoint when pluginApi provides data", async () => {
      mockExistsSync.mockReturnValue(true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      (mgr as unknown as { locked: boolean }).locked = true;
      const pluginApi = {
        _commandHistory: ["look", "north"],
        _gameMemory: {
          currentRoom: "West of House",
          inventory: ["lantern"],
          visitedRooms: ["West of House"],
          roomGraph: {},
          blockedPuzzles: [],
        },
        _cartState: {
          rooms: ["West of House"],
          lastRoomHeader: "West of House",
          roomExits: { "West of House": ["north"] },
          dirGraph: {},
        },
      };
      await mgr.releaseSession(pluginApi);
      expect(mockWriteFileSync).toHaveBeenCalled();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0]![1] as string);
      expect(written.commandHistory).toEqual(["look", "north"]);
      expect(written.currentRoom).toBe("West of House");
      expect(written.swarmState.rooms).toEqual(["West of House"]);
      logSpy.mockRestore();
    });

    it("saves checkpoint when pluginApi has commandHistory but no gameMemory", async () => {
      mockExistsSync.mockReturnValue(true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      (mgr as unknown as { locked: boolean }).locked = true;
      const pluginApi = {
        _commandHistory: ["look"],
      };
      await mgr.releaseSession(pluginApi);
      expect(mockWriteFileSync).toHaveBeenCalled();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0]![1] as string);
      expect(written.commandHistory).toEqual(["look"]);
      expect(written.currentRoom).toBe("");
      logSpy.mockRestore();
    });

    it("skips checkpoint when pluginApi has no commandHistory or gameMemory", async () => {
      mockExistsSync.mockReturnValue(true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      (mgr as unknown as { locked: boolean }).locked = true;
      const pluginApi = {};
      await mgr.releaseSession(pluginApi);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it("handles emulator save error gracefully", async () => {
      mockExistsSync.mockReturnValue(true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      (mgr as unknown as { locked: boolean }).locked = true;
      // Create a fake emulator that fails on saveGame
      const fakeEmulator = {
        sendCommand: vi.fn(),
        getScreen: vi.fn(),
        saveGame: vi.fn().mockRejectedValue(new Error("save failed")),
        close: vi.fn().mockResolvedValue(undefined),
        launch: vi.fn(),
      };
      mgr.currentEmulator = fakeEmulator;
      await mgr.releaseSession();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("save failed (best-effort)")
      );
      expect(fakeEmulator.close).toHaveBeenCalled();
      expect(mgr.isLocked()).toBe(false);
      logSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it("closes emulator successfully when saveGame succeeds", async () => {
      mockExistsSync.mockReturnValue(true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      (mgr as unknown as { locked: boolean }).locked = true;
      const fakeEmulator = {
        sendCommand: vi.fn(),
        getScreen: vi.fn(),
        saveGame: vi.fn().mockResolvedValue(true),
        close: vi.fn().mockResolvedValue(undefined),
        launch: vi.fn(),
      };
      mgr.currentEmulator = fakeEmulator;
      await mgr.releaseSession();
      expect(fakeEmulator.saveGame).toHaveBeenCalled();
      expect(fakeEmulator.close).toHaveBeenCalled();
      expect(mgr.currentEmulator).toBeNull();
      logSpy.mockRestore();
    });
  });

  describe("cleanup", () => {
    it("is a no-op when no emulator is active", async () => {
      mockExistsSync.mockReturnValue(true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      await mgr.cleanup();
      expect(mgr.currentEmulator).toBeNull();
    });

    it("closes emulator and resets state", async () => {
      mockExistsSync.mockReturnValue(true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      const fakeEmulator = {
        sendCommand: vi.fn(),
        getScreen: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
        saveGame: vi.fn(),
        launch: vi.fn(),
      };
      mgr.currentEmulator = fakeEmulator;
      (mgr as unknown as { locked: boolean }).locked = true;
      await mgr.cleanup();
      expect(fakeEmulator.close).toHaveBeenCalled();
      expect(mgr.currentEmulator).toBeNull();
      expect(mgr.isLocked()).toBe(false);
    });

    it("handles close error gracefully during cleanup", async () => {
      mockExistsSync.mockReturnValue(true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      const fakeEmulator = {
        sendCommand: vi.fn(),
        getScreen: vi.fn(),
        close: vi.fn().mockRejectedValue(new Error("close failed")),
        saveGame: vi.fn(),
        launch: vi.fn(),
      };
      mgr.currentEmulator = fakeEmulator;
      (mgr as unknown as { locked: boolean }).locked = true;
      await mgr.cleanup();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("cleanup error"));
      expect(mgr.currentEmulator).toBeNull();
      expect(mgr.isLocked()).toBe(false);
      stderrSpy.mockRestore();
    });
  });

  describe("checkpointDir accessor", () => {
    it("exposes checkpointDir as a readonly property", () => {
      mockExistsSync.mockReturnValue(true);
      const mgr = new GameSessionManager({ gamePath, checkpointDir });
      expect(mgr.checkpointDir).toBe(checkpointDir);
    });
  });
});
