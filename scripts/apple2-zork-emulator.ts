/**
 * Zork I Emulator — apple2js.com via Playwright (or scripted simulation)
 *
 * Two modes:
 *   Simulated (default) — pre-scripted turn sequence; no browser needed.
 *                         Includes one deliberate slow turn for re-delegation demo.
 *   Apple2 (apple2: true) — headed Chromium → apple2js.com → Zork I disk image.
 *                          Reads Apple II text memory via page.evaluate().
 *
 * Usage:
 *   const emu = new ZorkEmulator();                           // simulated
 *   const emu = new ZorkEmulator({ apple2: true });           // Playwright
 *   const emu = new ZorkEmulator({ apple2: true, injectFailureOnTurn: 9 }); // force SLO miss on turn 9
 *   await emu.launch();
 *   const r = await emu.sendCommand("open mailbox");
 *   const screen = await emu.readScreen();  // read without typing (for independent consensus)
 *   await emu.close();
 */

// ─── Apple II text memory helpers (used in real mode) ──────────────────────────

// Apple II text screen page 1: $0400–$07FF, 24×40, non-linear row layout.
const A2_TEXT_PAGE = 0x0400;
const A2_ROW_OFFSETS = [
  0x000, 0x080, 0x100, 0x180, 0x200, 0x280, 0x300, 0x380,
  0x028, 0x0a8, 0x128, 0x1a8, 0x228, 0x2a8, 0x328, 0x3a8,
  0x050, 0x0d0, 0x150, 0x1d0, 0x250, 0x2d0, 0x350, 0x3d0,
];

/** Injected into page.evaluate() to read Apple II screen text.
 *  Uses the gr.getText() API exposed by the scullinsteel apple2js build. */
const READ_SCREEN_FN = `(function() {
  const a2 = window.Apple2?.apple2;
  if (!a2) return null;

  // Primary: gr.getText() returns decoded 24-row string (scullinsteel build)
  try {
    const text = a2.gr?.getText?.();
    if (typeof text === 'string' && text.trim().length > 0) return text.trim();
  } catch(_) {}

  // Fallback: memPages via page.read(offset)
  try {
    const ROWS = ${JSON.stringify(A2_ROW_OFFSETS)};
    const BASE = ${A2_TEXT_PAGE};
    const mp = a2.cpu?.memPages;
    if (!mp) return null;
    const lines = [];
    for (const off of ROWS) {
      let row = '';
      for (let c = 0; c < 40; c++) {
        const pg = mp[(BASE + off + c) >> 8];
        let b = 0;
        if (pg) b = typeof pg.read === 'function' ? pg.read((BASE + off + c) & 0xff) : (pg[(BASE + off + c) & 0xff] ?? 0);
        b = b & 0x7f;
        row += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ' ';
      }
      lines.push(row.trimEnd());
    }
    return lines.join('\\n').trim() || null;
  } catch(_) {}

  return null;
})()`;

// ─── Screen delta extraction ────────────────────────────────────────────────────

/**
 * Extract the new game response from the current screen by finding the echoed command.
 *
 * Root cause this solves: gr.getText() returns the full rolling 24-row Apple II
 * display — including scroll history, previous echoed commands, and old room text.
 * Parsing the full snapshot causes the Cartographer to see stale rooms and the
 * consensus hash to include irrelevant history.
 *
 * Fix: scan from the bottom of the new screen for the echoed ">COMMAND" line
 * (Apple II always echoes input with a > prefix in uppercase). Everything after
 * that line is the game's response to this specific command.
 */
export function extractDelta(command: string, currScreen: string, prevScreen: string): string {
  const lines = currScreen.split("\n");
  const cmdEcho = `>${command.toUpperCase()}`;

  // Scan from the bottom upward for the most recent command echo.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith(cmdEcho)) {
      const response = lines
        .slice(i + 1)
        .filter((l) => l.trim().length > 0)
        .join("\n")
        .trim();
      return response || "(no visible response)";
    }
  }

  // Fallback: return lines that did not appear in the previous screen.
  const prevSet = new Set(prevScreen.split("\n").map((l) => l.trim()));
  const newLines = lines.filter((l) => l.trim() && !prevSet.has(l.trim()));
  return newLines.join("\n").trim() || "(screen unchanged)";
}

/**
 * Extract the room name from the top line of an Apple II Zork screen,
 * stripping the "SCORE: X/Y" suffix that Zork appends.
 *
 * Root cause: "WEST OF HOUSE            SCORE: 0/1" would otherwise be treated
 * as a unique location on every turn, inflating the Cartographer's map.
 */
export function extractRoomHeader(screenLine0: string): string {
  return screenLine0
    .replace(/\s{2,}SCORE:\s*\d+\/\d+.*/i, "")
    .trim();
}

// ─── Scripted Zork I turn sequence ────────────────────────────────────────────

export interface ZorkTurn {
  command: string;
  /** Approximate ms for Zork to respond (drives SLO compliance) */
  latencyMs: number;
  /** Simulated token count for the response */
  tokens: number;
  output: string;
}

/** 12 pre-scripted turns that exercise all framework features.
 *
 *  Turn  6: "attack troll"  — risky keyword → Firebreak blocks.
 *  Turn  9: "go in"         — latencyMs=7200, tokens=0 → SLO violation → re-delegation.
 *  Turn  8: "open window"   — NOTE: intentionally NOT in RISKY_COMMANDS (required puzzle step).
 */
export const ZORK_SCRIPT: ZorkTurn[] = [
  {
    command: "look",
    latencyMs: 280, tokens: 52,
    output: "West of House\nYou are standing in an open field west of a white house, with a boarded front door.\nThere is a small mailbox here.",
  },
  {
    command: "open mailbox",
    latencyMs: 312, tokens: 48,
    output: "Opening the small mailbox reveals a leaflet.",
  },
  {
    command: "take leaflet",
    latencyMs: 195, tokens: 22,
    output: "Taken.",
  },
  {
    command: "read leaflet",
    latencyMs: 440, tokens: 120,
    output: "WELCOME TO ZORK!\nZork is a game of adventure, danger and low cunning. In it you will explore some of the most amazing territory ever seen by mortal man. Hardiness, above all else, is mandatory.",
  },
  {
    command: "go north",
    latencyMs: 305, tokens: 44,
    output: "North of House\nYou are facing the north side of a white house. There is no door here, and all the windows are boarded up.",
  },
  // Turn 6: risky command — cognitive friction + Firebreak triggered
  {
    command: "attack troll",
    latencyMs: 350, tokens: 38,
    output: "You see no troll here.",
  },
  {
    command: "go east",
    latencyMs: 270, tokens: 55,
    output: "Behind House\nYou are behind the white house. A path leads into the forest to the east. In one corner of the house there is a small window which is slightly ajar.",
  },
  // Turn 8: opening the window — legitimately safe (required puzzle step, NOT in RISKY_COMMANDS)
  {
    command: "open window",
    latencyMs: 410, tokens: 60,
    output: "With great effort, you open the window far enough to allow entry.",
  },
  // Turn 9: SIMULATED FAILURE — triggers bond slash + re-delegation
  {
    command: "go in",
    latencyMs: 7200, tokens: 0,   // reported duration exceeds SLO; emulator returns immediately
    output: "",
  },
  {
    command: "enter house",
    latencyMs: 330, tokens: 72,
    output: "Kitchen\nYou are in the kitchen of the white house. A table seems to have been used recently for the preparation of food. On the table is an elongated brown sack, smelling of hot peppers.\nA bottle is sitting on the table.\nThe glass bottle contains:\n  A quantity of water",
  },
  {
    command: "take sack",
    latencyMs: 210, tokens: 25,
    output: "Taken.",
  },
  {
    command: "go west",
    latencyMs: 295, tokens: 68,
    output: "Living Room\nYou are in the living room. There is a doorway to the east, a wooden door with strange gothic lettering to the west, which appears to be nailed shut, and a large oriental rug in the center of the room.\nAbove the fireplace is mounted a brass lantern, unlit.\nA sword of great antiquity is propped against the south wall.",
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ZorkCommandResult {
  /** Full 24-row Apple II screen snapshot (used for independent consensus reads). */
  output: string;
  /**
   * Only the new text produced by this command (delta).
   *
   * Root cause this solves: the full screen includes scroll history from prior
   * turns. Agents that parse `output` for game state see stale room descriptions
   * and echoed old commands. `delta` isolates just what the game returned for
   * this specific command.
   */
  delta: string;
  /** Room name from screen line 0, score suffix stripped. */
  roomHeader: string;
  durationMs: number;
  tokensApprox: number;
  success: boolean;
}

export interface ZorkEmulatorOptions {
  /** Use Playwright (--apple2 mode) + apple2js.com. Default: false (scripted simulation) */
  apple2?: boolean;
  /** Playwright headless. Only used when apple2=true. Default: false */
  headless?: boolean;
  /**
   * When apple2=true, inject a synthetic SLO failure on this (1-based) command number.
   *
   * Root cause this solves: the deliberate latencyMs=7200 in ZORK_SCRIPT[8] only
   * fires in simulated mode. Real Playwright always responds in ~4s, so re-delegation
   * recovery is never exercised. This flag forces a failure at any chosen turn so
   * the full bond-slash → reputation-downgrade → re-delegation path can be tested
   * against the live emulator.
   *
   * Example: { apple2: true, injectFailureOnTurn: 9 } fails the 9th real command.
   */
  injectFailureOnTurn?: number;
}

// ─── ZorkEmulator ─────────────────────────────────────────────────────────────

export class ZorkEmulator {
  private opts: Required<Omit<ZorkEmulatorOptions, "injectFailureOnTurn">> & { injectFailureOnTurn?: number };
  private turnIndex = 0;

  // Real mode: Playwright
  private browser: unknown = null;
  private page: unknown = null;
  /** Full screen snapshot after the most recent command; used by readScreen(). */
  private lastScreen = "";

  // Simulated mode: last output (for readScreen() independent verification calls)
  private lastSimScreen = "";

  // Injection tracking
  private realCommandCount = 0;

  constructor(opts: ZorkEmulatorOptions = {}) {
    this.opts = { apple2: false, headless: false, ...opts };
  }

  async launch(): Promise<void> {
    if (!this.opts.apple2) return; // simulation needs no setup

    // Dynamic import so the module loads fine without playwright installed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { chromium } = await import("playwright") as any;
    const br = await (chromium as any).launch({
      headless: this.opts.headless,
      slowMo: 40,
      args: ["--disable-web-security"],  // allow cross-origin disk fetch
    });
    const ctx = await br.newContext({ viewport: { width: 900, height: 700 } });
    this.page = await ctx.newPage();
    this.browser = br;

    // Navigate to apple2js — disk loaded via hash fragment (Drive 1).
    // Root cause note: apple2js.com is expired; scullinsteel.com/apple2/ is the live host.
    // Hash fragment (#) not query param (?disk2=) is the correct URL format.
    const diskUrl = "https://archive.org/download/wozaday_Zork_I_r26/00playable.woz";
    await (this.page as any).goto(
      `https://www.scullinsteel.com/apple2/#${encodeURIComponent(diskUrl)}`,
      { waitUntil: "networkidle", timeout: 30000 },
    );

    // Root cause: archive.org disk fetch + Apple II ROM boot + Zork disk load takes ~18s.
    // Less than 18s and the screen reader returns null (game not loaded yet).
    await new Promise<void>((r) => setTimeout(r, 20000));

    // Root cause: scullinsteel.com shows a welcome modal (#alert-modal) on first load
    // whose overlay intercepts ALL pointer events, making canvas.click() timeout.
    // Clicking the overlay's data-micromodal-close attribute dismisses it cleanly.
    const page = this.page as any;
    try {
      const overlay = page.locator(".modal__overlay[data-micromodal-close]").first();
      const isVisible = await overlay.isVisible({ timeout: 3000 });
      if (isVisible) {
        await overlay.click({ force: true });
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    } catch (_) {
      try { await page.keyboard.press("Escape"); } catch (_2) { /* no modal, ignore */ }
    }
  }

  /**
   * Read the current Apple II screen without typing anything.
   *
   * Used by the Cartographer for independent consensus verification: after the
   * Tactician reports what it saw, the Cartographer calls readScreen() on its own
   * to get a ground-truth hash. If the Tactician fabricated or misread output,
   * the hashes will differ and consensus will fail.
   */
  async readScreen(): Promise<string | null> {
    if (!this.opts.apple2) {
      // Simulated mode: return the last output that was "displayed"
      return this.lastSimScreen || null;
    }
    if (!this.page) return null;
    return (this.page as any).evaluate(READ_SCREEN_FN);
  }

  async sendCommand(command: string): Promise<ZorkCommandResult> {
    if (!this.opts.apple2) {
      return this._simulatedCommand(command);
    }
    return this._realCommand(command);
  }

  private async _realCommand(command: string): Promise<ZorkCommandResult> {
    this.realCommandCount++;

    // Root cause: the deliberate SLO failure in ZORK_SCRIPT[8] only fires in
    // simulated mode because real Playwright always responds in ~4s. This flag
    // allows testing the bond-slash/re-delegation path against the live emulator.
    if (this.opts.injectFailureOnTurn === this.realCommandCount) {
      // Return synthetic failure immediately (don't block for 7200ms in real time)
      return { output: "", delta: "", roomHeader: "", durationMs: 7200, tokensApprox: 0, success: false };
    }

    const page = this.page as any;
    const start = Date.now();

    // Dismiss any lingering modal before interacting
    try {
      const overlay = page.locator(".modal__overlay[data-micromodal-close]").first();
      const isVisible = await overlay.isVisible({ timeout: 500 });
      if (isVisible) {
        await overlay.click({ force: true });
        await new Promise<void>((r) => setTimeout(r, 300));
      }
    } catch (_) { /* no modal */ }

    // Capture screen BEFORE typing so we can compute the delta afterward.
    // Root cause: without prevScreen, extractDelta falls back to a line diff that
    // can be noisy. Capturing before typing gives a clean baseline.
    const prevScreen = await page.evaluate(READ_SCREEN_FN) ?? "";

    // Click canvas to acquire keyboard focus (Apple II needs direct keyboard input)
    // Root cause: "Return" is not a valid Playwright key name — must use "Enter"
    await page.locator("canvas").first().click({ timeout: 10000 });
    await new Promise<void>((r) => setTimeout(r, 200));

    await page.keyboard.type(command, { delay: 80 });
    await page.keyboard.press("Enter");

    // Wait for Zork to process and scroll output (~3s including Apple II rendering)
    await new Promise<void>((r) => setTimeout(r, 3500));

    const currScreen: string = await page.evaluate(READ_SCREEN_FN) ?? "";
    const durationMs = Date.now() - start;

    const delta = extractDelta(command, currScreen, prevScreen);
    const roomHeader = extractRoomHeader(currScreen.split("\n")[0] ?? "");

    this.lastScreen = currScreen;
    return {
      output: currScreen,
      delta,
      roomHeader,
      durationMs,
      tokensApprox: Math.ceil(delta.length / 4),
      success: currScreen.length > 0,
    };
  }

  /** Returns the scripted turn for the current index, then advances. */
  private async _simulatedCommand(command: string): Promise<ZorkCommandResult> {
    const turn = ZORK_SCRIPT[this.turnIndex] ?? ZORK_SCRIPT[ZORK_SCRIPT.length - 1]!;
    this.turnIndex++;

    // Simulate actual latency so SLO checks are meaningful
    await new Promise<void>((r) => setTimeout(r, Math.min(turn.latencyMs, 200)));

    // In simulation, `output` = full scripted text; delta = same (no rolling buffer).
    this.lastSimScreen = turn.output;
    const roomHeader = extractRoomHeader(turn.output.split("\n")[0] ?? "");

    return {
      output: turn.output,
      delta: turn.output,
      roomHeader,
      durationMs: turn.latencyMs,
      tokensApprox: turn.tokens,
      success: turn.tokens > 0,
    };
  }

  getCurrentTurnIndex(): number { return this.turnIndex; }

  /**
   * Advance the scripted turn index without executing a command.
   *
   * Root cause: when Firebreak blocks a turn, emulator.sendCommand() is never
   * called, so turnIndex stays behind. Every subsequent turn then executes the
   * WRONG scripted entry (the blocked command's response instead of the next one).
   * In simulated mode this shifts the deliberate SLO failure from turn 9 to turn 10.
   * Call skipTurn() from the main game loop whenever Firebreak cancels a turn.
   *
   * No-op in --apple2 mode (apple2 mode ignores turnIndex entirely).
   */
  skipTurn(): void {
    if (!this.opts.apple2 && this.turnIndex < ZORK_SCRIPT.length) {
      this.turnIndex++;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await (this.browser as any).close();
      this.browser = null;
      this.page = null;
    }
  }
}
