/**
 * Zork I — dfrotz Z-machine emulator (--frotz mode)
 *
 * Replaces the Playwright + apple2js Apple II emulator with a direct
 * Z-machine interpreter. Spawns dfrotz as a child process and communicates
 * via stdin / stdout — no browser, no canvas, no modal dialogs.
 *
 * Why this is better than the Apple II emulator:
 *   • ~5ms per command vs ~300–500ms (no canvas rendering)
 *   • Clean text output — no Apple II screen memory parsing
 *   • Works headlessly in CI / servers (no Chrome needed)
 *   • Save/restore game state via dfrotz -r / -s flags
 *
 * Same interface as ZorkEmulator so apple2-zork-swarm.ts needs no changes.
 *
 * Usage:
 *   const emu = new ZorkFrotzEmulator();
 *   await emu.launch();
 *   const r = await emu.sendCommand("open mailbox");
 *   console.log(r.delta);     // "Opening the small mailbox reveals a leaflet."
 *   console.log(r.roomHeader);// "West of House"
 *   await emu.close();
 *
 * Requires: brew install frotz  (provides /opt/homebrew/bin/dfrotz)
 *           scripts/zork1.z3    (Zork I Z-machine story file, MIT licence)
 */

import { spawn, ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DFROTZ_BIN  = "dfrotz";
export const ZORK1_Z3    = join(__dirname, "zork1.z3");

export interface ZorkCommandResult {
  output:       string;   // full raw dfrotz output for this turn
  delta:        string;   // game response text only (no status line, no blanks)
  roomHeader:   string;   // room name parsed from dfrotz status line
  success:      boolean;
  durationMs:   number;
  tokensApprox: number;
}

// ─── dfrotz output format ─────────────────────────────────────────────────────
//
// dfrotz (-m flag suppresses [MORE] pauses) outputs each turn as:
//
//   " West of House                              Score: 0        Moves: 3\n"
//   "\n"
//   "Opening the small mailbox reveals a leaflet.\n"
//   "\n"
//   "> "          ← prompt, no trailing newline — process blocks here
//
// The status line starts with a space and always contains "Score:" and "Moves:".
// The delta is everything between the status line and the ">" prompt.
// ─────────────────────────────────────────────────────────────────────────────

function parseOutput(raw: string): { roomHeader: string; delta: string } {
  const lines = raw.split("\n");

  // Locate the status line: " West of House      Score: 0        Moves: 3"
  const statusIdx = lines.findIndex(l => /Score:\s*\d+.*Moves:\s*\d+/i.test(l));

  let roomHeader = "";
  let bodyLines:  string[];

  if (statusIdx !== -1) {
    // Strip everything from the first run of 2+ spaces onward ("Score: ...")
    roomHeader = lines[statusIdx]!.replace(/\s{2,}Score:.*$/i, "").trim();
    bodyLines  = lines.slice(statusIdx + 1);
  } else {
    // No status line (e.g. startup banner, inventory response) — use all lines
    bodyLines = lines;
  }

  const delta = bodyLines
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join("\n")
    .trim();

  return { roomHeader, delta: delta || "(no visible response)" };
}

// ─── ZorkFrotzEmulator ────────────────────────────────────────────────────────

export class ZorkFrotzEmulator {
  private proc:        ChildProcess | null = null;
  private buffer                           = "";
  private waiters:     Array<() => void>   = [];
  private lastScreen                       = "";
  // Saved by launch() so saveGame() can send it at the dfrotz filename prompt.
  private savePath:    string | null       = null;

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async launch(gamePath?: string, options?: { savePath?: string; restorePath?: string }): Promise<void> {
    this.savePath = options?.savePath ?? null;
    const spawnArgs: string[] = ["-m"];    // suppress [MORE] prompts
    // dfrotz uses -L to restore from a save file on startup.
    // (Note: -s is the random seed, -r sets runtime options — neither is save-related.)
    if (options?.restorePath) spawnArgs.push("-L", options.restorePath);
    spawnArgs.push(gamePath ?? ZORK1_Z3);

    this.proc = spawn(DFROTZ_BIN, spawnArgs, { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      // Notify all pending waiters so they can re-check the buffer
      for (const w of [...this.waiters]) w();
    });

    // Suppress dfrotz's startup line on stderr ("Using normal formatting. / Loading …")
    this.proc.stderr!.on("data", () => {});

    this.proc.on("error", (err) => {
      throw new Error(`dfrotz process error: ${err.message}\n  Is dfrotz installed? Run: brew install frotz`);
    });

    // Consume the startup banner + initial room description
    this.lastScreen = await this._readUntilPrompt();
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    try { this.proc.stdin!.write("quit\ny\n"); } catch (_) {}
    await new Promise<void>(r => setTimeout(r, 150));
    try { this.proc.kill(); } catch (_) {}
    this.proc = null;
  }

  /**
   * Save the Z-machine game state.
   *
   * Sends "save\n" to dfrotz. dfrotz prompts:
   *   "Please enter a filename [zork1.qzl]: "
   *
   * We respond with this.savePath (set at launch) to write to our checkpoint
   * directory, or "\n" to accept the default if savePath is not set.
   *
   * Returns true on confirmed save ("Ok." in response), false otherwise.
   */
  async saveGame(): Promise<boolean> {
    if (!this.proc) return false;
    this.proc.stdin!.write("save\n");
    // dfrotz filename prompt ends with "]: " — _readUntilPrompt would hang here,
    // so use _readUntilOneOf which also matches that pattern.
    const raw = await this._readUntilOneOf([/\n> *$/, /^> *$/, /\]: *$/]);
    if (/\]: *$/.test(raw.trimEnd())) {
      // Send our configured save path (absolute), or accept the default with "\n"
      this.proc.stdin!.write((this.savePath ?? "") + "\n");
      const raw2 = await this._readUntilPrompt();
      return /ok/i.test(raw2);
    }
    return /ok/i.test(raw);
  }

  // ── game I/O ─────────────────────────────────────────────────────────────────

  async sendCommand(command: string): Promise<ZorkCommandResult> {
    const start = Date.now();
    this.proc!.stdin!.write(command + "\n");
    const raw = await this._readUntilPrompt();
    const durationMs = Date.now() - start;

    this.lastScreen = raw;
    const { roomHeader, delta } = parseOutput(raw);

    return {
      output:       raw,
      delta,
      roomHeader,
      success:      delta !== "(no visible response)",
      durationMs,
      // Approximate: 4 characters ≈ 1 token
      tokensApprox: Math.max(1, Math.ceil(delta.length / 4)),
    };
  }

  /**
   * Read the current game state without issuing a command.
   * Used by the Cartographer for independent consensus verification.
   */
  async readScreen(): Promise<string | null> {
    return this.lastScreen || null;
  }

  /**
   * No-op in frotz mode — every command is a real dfrotz call.
   * Exists so swarm.ts can call emulator.skipTurn() unconditionally.
   */
  skipTurn(): void {}

  // ── internal: prompt detection ───────────────────────────────────────────────

  /**
   * Resolve as soon as the accumulated buffer matches ANY of the supplied
   * patterns. Used when dfrotz may emit prompts other than the standard "> "
   * (e.g. the save-filename prompt "]: ").
   *
   * Clears the buffer on resolution so subsequent reads start fresh.
   */
  private _readUntilOneOf(patterns: RegExp[]): Promise<string> {
    return new Promise((resolve) => {
      const check = () => {
        for (const pat of patterns) {
          if (pat.test(this.buffer)) {
            this.waiters = this.waiters.filter(w => w !== check);
            const text = this.buffer;
            this.buffer = "";
            resolve(text);
            return;
          }
        }
      };
      this.waiters.push(check);
      check();
    });
  }

  /**
   * Read from dfrotz stdout until the "> " prompt appears.
   *
   * dfrotz writes "> " (greater-than + space) and then blocks waiting for stdin.
   * In the accumulated buffer this appears as "\n> " at the end of each response.
   * We detect it by checking if the buffer matches /\n> *$/ after each data event.
   *
   * Edge cases:
   *   • Startup: initial prompt may not have a preceding \n → also match /^> *$/
   *   • Long responses: data arrives in multiple chunks → accumulate before checking
   *   • ">" in game text: always followed by more text, never at EOL + blocking
   */
  private _readUntilPrompt(): Promise<string> {
    return new Promise((resolve) => {
      const check = () => {
        // Primary: buffer ends with newline + ">" + optional space (interactive prompt)
        if (/\n> *$/.test(this.buffer)) {
          this._extractAndResolve(resolve, check);
          return;
        }
        // Fallback: buffer IS just "> " (very first startup prompt)
        if (/^> *$/.test(this.buffer.trim())) {
          this._extractAndResolve(resolve, check);
        }
      };

      this.waiters.push(check);
      check(); // immediate check in case buffer already contains a full response
    });
  }

  private _extractAndResolve(resolve: (s: string) => void, check: () => void): void {
    // Remove this waiter from the list
    this.waiters = this.waiters.filter(w => w !== check);

    // Cut the buffer at the last "\n>" to extract the response body
    const promptIdx = this.buffer.lastIndexOf("\n>");
    let text: string;
    if (promptIdx !== -1) {
      text = this.buffer.slice(0, promptIdx);
      this.buffer = ""; // cleared — next response starts fresh
    } else {
      // Startup case: entire buffer is the prompt itself
      text = this.buffer.replace(/> *$/, "").trim();
      this.buffer = "";
    }

    resolve(text);
  }
}
