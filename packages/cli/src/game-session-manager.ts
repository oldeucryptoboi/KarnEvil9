/**
 * GameSessionManager — Owns the dfrotz emulator lifecycle and concurrency.
 *
 * Only one game session can be active at a time. The manager handles:
 *   • Launching a fresh dfrotz subprocess with an RNG seed
 *   • Resuming from a checkpoint by replaying command history (~5ms/cmd)
 *   • Saving checkpoint state (meta.json) after each session
 *   • Concurrency guard — rejects concurrent acquire attempts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmulatorLike, CartographerFn } from "@karnevil9/tools";
import { setEmulator, setCartographerFn } from "@karnevil9/tools";

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
  private checkpointDir: string;
  private maxTurns: number;
  private rngSeed: number;
  private locked = false;
  currentEmulator: EmulatorLike | null = null;

  // Factory function for creating emulator instances — injected at construction
  private createEmulator: () => FrotzEmulator;

  constructor(opts: {
    gamePath: string;
    checkpointDir: string;
    maxTurns?: number;
    rngSeed?: number;
    createEmulator: () => FrotzEmulator;
  }) {
    this.gamePath = opts.gamePath;
    this.checkpointDir = opts.checkpointDir;
    this.maxTurns = opts.maxTurns ?? 20;
    this.rngSeed = opts.rngSeed ?? 42;
    this.createEmulator = opts.createEmulator;

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
   * Rejects if another session is already active.
   */
  async acquireSession(): Promise<{ emulator: EmulatorLike; checkpoint: GameCheckpoint | null }> {
    if (this.locked) {
      throw new Error("Game session already active — only one concurrent session allowed");
    }
    this.locked = true;

    try {
      const checkpoint = this.loadCheckpoint();
      const emulator = this.createEmulator();

      // Launch fresh dfrotz with RNG seed for deterministic combat
      await emulator.launch(this.gamePath, {
        seed: this.rngSeed,
        savePath: join(this.checkpointDir, "zork1.qzl"),
      });

      // Replay command history from checkpoint to resume game state (~5ms/cmd)
      if (checkpoint?.commandHistory?.length) {
        console.log(`[game] Replaying ${checkpoint.commandHistory.length} commands from checkpoint...`);
        for (const cmd of checkpoint.commandHistory) {
          await emulator.sendCommand(cmd);
        }
        console.log(`[game] Replay complete — resumed at ${checkpoint.currentRoom || "unknown"}`);
      }

      // Wire emulator into tool handlers
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
   */
  async releaseSession(checkpoint?: Partial<GameCheckpoint>): Promise<void> {
    const emulator = this.currentEmulator as FrotzEmulator | null;

    try {
      if (checkpoint) {
        this.saveCheckpoint({
          commandHistory: checkpoint.commandHistory ?? [],
          currentRoom: checkpoint.currentRoom ?? "",
          inventory: checkpoint.inventory ?? [],
          visitedRooms: checkpoint.visitedRooms ?? [],
          roomGraph: checkpoint.roomGraph ?? {},
          blockedPuzzles: checkpoint.blockedPuzzles ?? [],
          swarmState: checkpoint.swarmState,
          updatedAt: new Date().toISOString(),
        });
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
