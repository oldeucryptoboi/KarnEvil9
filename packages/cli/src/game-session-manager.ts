/**
 * GameSessionManager — Owns the dfrotz emulator lifecycle and concurrency.
 *
 * Mirrors the if-kernel-runner.ts setup: launches dfrotz, wires setEmulator(),
 * replays command history from checkpoint for session resume, and persists
 * game state to meta.json after each session.
 *
 * Only one game session can be active at a time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmulatorLike } from "@karnevil9/tools";
import { setEmulator } from "@karnevil9/tools";

export interface GameCheckpoint {
  commandHistory: string[];
  currentRoom: string;
  inventory: string[];
  visitedRooms: string[];
  roomGraph: Record<string, string[]>;
  blockedPuzzles: Array<{ room: string; object: string; reason: string }>;
  swarmState?: {
    tacticianCompleted?: number;
    tacticianFailed?: number;
    cartoCompleted?: number;
    cartoFailed?: number;
    tacticianEscrow?: number;
    cartoEscrow?: number;
    rooms?: string[];
    lastRoomHeader?: string;
    roomExits?: Record<string, string[]>;
    dirGraph?: Record<string, Record<string, string>>;
    currentRoom?: string;
    inventory?: string[];
    visitedRooms?: string[];
    roomGraph?: Record<string, string[]>;
    blockedPuzzles?: Array<{ room: string; object: string; reason: string }>;
    sessionId?: string;
  };
  updatedAt: string;
}

// Minimal interface for the ZorkFrotzEmulator — avoids hard dependency on scripts/
interface FrotzEmulator extends EmulatorLike {
  launch(gamePath?: string, options?: { savePath?: string; restorePath?: string; seed?: number }): Promise<void>;
  close(): Promise<void>;
  saveGame(): Promise<boolean>;
}

export class GameSessionManager {
  private gamePath: string;
  readonly checkpointDir: string;
  private maxTurns: number;
  private rngSeed: number;
  private locked = false;
  currentEmulator: EmulatorLike | null = null;

  constructor(opts: {
    gamePath: string;
    checkpointDir: string;
    maxTurns?: number;
    rngSeed?: number;
  }) {
    this.gamePath = opts.gamePath;
    this.checkpointDir = opts.checkpointDir;
    this.maxTurns = opts.maxTurns ?? 20;
    this.rngSeed = opts.rngSeed ?? 42;

    // Ensure checkpoint directory exists
    if (!existsSync(this.checkpointDir)) {
      mkdirSync(this.checkpointDir, { recursive: true });
    }
  }

  isLocked(): boolean {
    return this.locked;
  }

  getMaxTurns(): number {
    return this.maxTurns;
  }

  /**
   * Acquire a game session — launches dfrotz and replays checkpoint if available.
   * Mirrors if-kernel-runner.ts: fresh dfrotz + RNG seed + command history replay.
   * Rejects if another session is already active.
   */
  async acquireSession(): Promise<{ emulator: EmulatorLike; checkpoint: GameCheckpoint | null }> {
    if (this.locked) {
      throw new Error("Game session already active — only one concurrent session allowed");
    }
    this.locked = true;

    try {
      const checkpoint = this.loadCheckpoint();

      // Dynamic import of ZorkFrotzEmulator from scripts/ (TypeScript source).
      // Node 25+ supports importing .ts files directly via experimental type stripping.
      // This is the same emulator used by if-kernel-runner.ts and apple2-zork-swarm.ts.
      const frotzPath = join(this.gamePath, "..", "apple2-zork-frotz.ts");
      const { ZorkFrotzEmulator } = await import(frotzPath) as { ZorkFrotzEmulator: new () => FrotzEmulator };
      const emulator = new ZorkFrotzEmulator();

      // Launch fresh dfrotz with RNG seed for deterministic combat outcomes.
      // Same pattern as if-kernel-runner.ts line 341.
      await emulator.launch(this.gamePath, {
        seed: this.rngSeed,
        savePath: join(this.checkpointDir, "game.qzl"),
      });

      // Replay command history from checkpoint to resume game state (~5ms/cmd).
      // This is how dfrotz resume works: fresh process + replay all prior commands
      // with a fixed RNG seed = identical game state.
      if (checkpoint?.commandHistory?.length) {
        console.log(`[game] Replaying ${checkpoint.commandHistory.length} commands from checkpoint...`);
        for (const cmd of checkpoint.commandHistory) {
          await emulator.sendCommand(cmd);
        }
        console.log(`[game] Replay complete — resumed at ${checkpoint.currentRoom || "unknown"}`);
      }

      // Wire emulator into tool handlers (same as if-kernel-runner.ts line 345)
      this.currentEmulator = emulator;
      setEmulator(emulator);

      return { emulator, checkpoint };
    } catch (err) {
      this.locked = false;
      this.currentEmulator = null;
      throw err;
    }
  }

  /**
   * Release the current game session — saves checkpoint and closes dfrotz.
   * When called without explicit checkpoint data, extracts state from the
   * swarm-delegation plugin's exposed fields (_commandHistory, _gameMemory, _cartState).
   */
  async releaseSession(pluginApi?: Record<string, unknown>): Promise<void> {
    const emulator = this.currentEmulator as FrotzEmulator | null;

    try {
      // Extract game state from the swarm-delegation plugin's exposed fields.
      // The plugin sets these on the api object at lines 310-313 of index.ts:
      //   api._cartState, api._gameMemory, api._commandHistory
      if (pluginApi) {
        const commandHistory = pluginApi._commandHistory as string[] | undefined;
        const gameMemory = pluginApi._gameMemory as {
          currentRoom?: string;
          inventory?: string[];
          visitedRooms?: string[];
          roomGraph?: Record<string, string[]>;
          blockedPuzzles?: Array<{ room: string; object: string; reason: string }>;
        } | undefined;
        const cartState = pluginApi._cartState as {
          rooms?: string[];
          lastRoomHeader?: string;
          roomExits?: Record<string, string[]>;
          dirGraph?: Record<string, Record<string, string>>;
        } | undefined;

        if (commandHistory || gameMemory) {
          this.saveCheckpoint({
            commandHistory: commandHistory ?? [],
            currentRoom: gameMemory?.currentRoom ?? cartState?.lastRoomHeader ?? "",
            inventory: gameMemory?.inventory ?? [],
            visitedRooms: gameMemory?.visitedRooms ?? [],
            roomGraph: gameMemory?.roomGraph ?? {},
            blockedPuzzles: gameMemory?.blockedPuzzles ?? [],
            swarmState: {
              rooms: cartState?.rooms,
              lastRoomHeader: cartState?.lastRoomHeader,
              roomExits: cartState?.roomExits,
              dirGraph: cartState?.dirGraph,
              currentRoom: gameMemory?.currentRoom,
              inventory: gameMemory?.inventory,
              visitedRooms: gameMemory?.visitedRooms,
              roomGraph: gameMemory?.roomGraph,
              blockedPuzzles: gameMemory?.blockedPuzzles,
            },
            updatedAt: new Date().toISOString(),
          });
        }
      }

      if (emulator) {
        try {
          await emulator.saveGame();
        } catch (_) {
          // Best-effort save — don't fail release
        }
        await emulator.close();
      }
    } finally {
      this.currentEmulator = null;
      this.locked = false;
      console.log("[game] Session released");
    }
  }

  /**
   * Load checkpoint from meta.json. Returns null if no checkpoint exists.
   */
  loadCheckpoint(): GameCheckpoint | null {
    const metaPath = join(this.checkpointDir, "meta.json");
    if (!existsSync(metaPath)) return null;

    try {
      const raw = readFileSync(metaPath, "utf-8");
      return JSON.parse(raw) as GameCheckpoint;
    } catch {
      console.warn("[game] Failed to load checkpoint — starting fresh");
      return null;
    }
  }

  /**
   * Save checkpoint to meta.json.
   */
  saveCheckpoint(checkpoint: GameCheckpoint): void {
    const metaPath = join(this.checkpointDir, "meta.json");
    writeFileSync(metaPath, JSON.stringify(checkpoint, null, 2), "utf-8");
    console.log(`[game] Checkpoint saved to ${metaPath}`);
  }

  /**
   * Clean up resources on shutdown.
   */
  async cleanup(): Promise<void> {
    if (this.currentEmulator) {
      try {
        await (this.currentEmulator as FrotzEmulator).close();
      } catch (_) {}
      this.currentEmulator = null;
      this.locked = false;
    }
  }
}
