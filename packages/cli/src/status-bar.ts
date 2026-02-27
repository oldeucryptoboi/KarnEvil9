// Status bar for the chat CLI — persistent 2-line bar at the bottom using ANSI scroll regions.
// Falls back gracefully when not a TTY or terminal is too small.

// ─── DI Interface ────────────────────────────────────────────────

/** Writable output + terminal dimensions — injectable for testing. */
export interface StatusBarWriter {
  write(data: string): void;
  getSize(): { rows: number; cols: number };
}

export class RealStatusBarWriter implements StatusBarWriter {
  write(data: string): void {
    process.stdout.write(data);
  }
  getSize(): { rows: number; cols: number } {
    return {
      rows: process.stdout.rows ?? 0,
      cols: process.stdout.columns ?? 80,
    };
  }
}

// ─── Data Types ──────────────────────────────────────────────────

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
export type SessionState = "idle" | "running";

export interface StatusBarData {
  connection: ConnectionState;
  sessionState: SessionState;
  sessionId: string | null;
  model: string | null;
  mode: string;
  totalTokens: number;
  costUsd: number;
  wsUrl: string;
}

// ─── Formatting Helpers ──────────────────────────────────────────

const KILO = 1000;
const MEGA = 1_000_000;

export function formatTokens(n: number): string {
  if (n >= MEGA) return `${(n / MEGA).toFixed(1)}M`;
  if (n >= KILO) return `${(n / KILO).toFixed(1)}k`;
  return String(n);
}

export function shortenModel(model: string): string {
  // claude-sonnet-4-5-20250929 → claude-sonnet-4-5
  // gpt-4o-2024-11-20 → gpt-4o
  return model.replace(/-\d{8,}$/, "");
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ─── ANSI Helpers ────────────────────────────────────────────────

const ESC = "\x1b";
/** Save cursor position. */
const SAVE = `${ESC}7`;
/** Restore cursor position. */
const RESTORE = `${ESC}8`;
/** Set scroll region rows 1..n (1-indexed). */
function setScrollRegion(top: number, bottom: number): string {
  return `${ESC}[${top};${bottom}r`;
}
/** Reset scroll region to full terminal. */
const RESET_SCROLL = `${ESC}[r`;
/** Move cursor to row, col (1-indexed). */
function moveTo(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}
/** Clear from cursor to end of line. */
const CLEAR_EOL = `${ESC}[K`;

const MIN_ROWS = 5;
const STATUS_LINES = 2;

// ─── StatusBar ───────────────────────────────────────────────────

export interface StatusBarLike {
  setup(): void;
  teardown(): void;
  update(patch: Partial<StatusBarData>): void;
  repaint(): void;
  onResize(): void;
}

export class StatusBar implements StatusBarLike {
  private _writer: StatusBarWriter;
  private _data: StatusBarData;
  private _active = false;

  constructor(writer: StatusBarWriter, initial?: Partial<StatusBarData>) {
    this._writer = writer;
    this._data = {
      connection: "connecting",
      sessionState: "idle",
      sessionId: null,
      model: null,
      mode: "live",
      totalTokens: 0,
      costUsd: 0,
      wsUrl: "",
      ...initial,
    };
  }

  get isActive(): boolean {
    return this._active;
  }

  setup(): void {
    const { rows } = this._writer.getSize();
    if (rows < MIN_ROWS) return;

    this._active = true;
    const scrollBottom = rows - STATUS_LINES;
    // Push existing content up so it doesn't overlap the status area
    this._writer.write("\n".repeat(STATUS_LINES));
    // Establish scroll region — confines all future scrolling to rows 1..scrollBottom
    this._writer.write(setScrollRegion(1, scrollBottom));
    // Position cursor at top of scroll region
    this._writer.write(moveTo(1, 1));
    // Paint the fixed status bar outside the scroll region
    this.repaint();
  }

  teardown(): void {
    if (!this._active) return;
    this._active = false;
    const { rows } = this._writer.getSize();
    // Reset scroll region
    this._writer.write(RESET_SCROLL);
    // Clear the status lines
    this._writer.write(moveTo(rows - 1, 1) + CLEAR_EOL);
    this._writer.write(moveTo(rows, 1) + CLEAR_EOL);
    // Move cursor back to a reasonable position
    this._writer.write(moveTo(rows - STATUS_LINES, 1));
  }

  update(patch: Partial<StatusBarData>): void {
    Object.assign(this._data, patch);
    if (this._active) this.repaint();
  }

  onResize(): void {
    if (!this._active) return;
    const { rows } = this._writer.getSize();
    if (rows < MIN_ROWS) {
      // Terminal too small — disable
      this._writer.write(RESET_SCROLL);
      this._active = false;
      return;
    }
    const scrollBottom = rows - STATUS_LINES;
    this._writer.write(setScrollRegion(1, scrollBottom));
    this.repaint();
  }

  repaint(): void {
    if (!this._active) return;
    const { rows, cols } = this._writer.getSize();
    const line1Row = rows - 1;
    const line2Row = rows;

    const line1 = this.formatLine1(cols);
    const line2 = this.formatLine2(cols);

    this._writer.write(SAVE);
    this._writer.write(moveTo(line1Row, 1) + CLEAR_EOL + line1);
    this._writer.write(moveTo(line2Row, 1) + CLEAR_EOL + line2);
    this._writer.write(RESTORE);
  }

  // ─── Line formatting ─────────────────────────────────────────

  private formatLine1(cols: number): string {
    const conn = this._data.connection;
    const sess = this._data.sessionState;
    const text = ` ${conn} | ${sess} `;
    return `${ESC}[7m${ESC}[2m${pad(text, cols)}${ESC}[0m`;
  }

  private formatLine2(cols: number): string {
    let text: string;
    if (this._data.sessionState === "running" && this._data.sessionId) {
      const sid = this.shortenId(this._data.sessionId);
      const parts = [sid];
      if (this._data.model) parts.push(shortenModel(this._data.model));
      parts.push(this._data.mode);
      if (this._data.totalTokens > 0) parts.push(`tokens ${formatTokens(this._data.totalTokens)}`);
      if (this._data.costUsd > 0) parts.push(formatCost(this._data.costUsd));
      text = ` ${parts.join(" | ")} `;
    } else {
      // Strip token from wsUrl for display
      const displayUrl = this._data.wsUrl.replace(/\?token=[^&]+/, "");
      text = ` ${displayUrl} | ${this._data.mode} `;
    }
    return `${ESC}[7m${ESC}[2m${pad(text, cols)}${ESC}[0m`;
  }

  private shortenId(id: string): string {
    if (id.length <= 11) return id;
    return `${id.slice(0, 3)}..${id.slice(-3)}`;
  }
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}
