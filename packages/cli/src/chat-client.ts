import * as readline from "node:readline";
import {
  green, red, yellow, dim,
  chatPrompt, formatEvent, helpText, TERMINAL_EVENTS,
} from "./chat-formatter.js";
import type { StatusBarLike } from "./status-bar.js";

// ─── DI Interfaces ────────────────────────────────────────────────

/** Minimal WebSocket interface — only what ChatClient calls. */
export interface ChatWebSocket {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export type WebSocketFactory = (url: string) => ChatWebSocket;

/** Terminal I/O abstraction (wraps readline + stdout). */
export interface TerminalIO {
  createReadline(): void;
  closeReadline(): void;
  setPrompt(prompt: string): void;
  prompt(): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  question(prompt: string, callback: (answer: string) => void): void;
  clearLine(): void;
  writeLine(text: string): void;
}

export interface ProcessControl {
  exit(code: number): void;
}

// ─── ChatClient ───────────────────────────────────────────────────

export interface ChatClientConfig {
  wsUrl: string;
  mode: string;
  wsFactory: WebSocketFactory;
  terminal: TerminalIO;
  process?: ProcessControl;
  statusBar?: StatusBarLike;
  pingIntervalMs?: number;
  maxReconnectDelay?: number;
  initialReconnectDelay?: number;
}

export class ChatClient {
  private _running = false;
  private _currentSessionId: string | null = null;
  private _userClose = false;
  private _reconnecting = false;
  private _reconnectScheduled = false;
  private _reconnectDelay: number;
  private _ws: ChatWebSocket | null = null;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;
  private _approvalQueue: Array<{ requestId: string; toolName: string; scopes: string }> = [];
  private _approvalActive = false;
  private _outputBuffer: string[] = [];

  private readonly _wsUrl: string;
  private readonly _mode: string;
  private readonly _wsFactory: WebSocketFactory;
  private readonly _terminal: TerminalIO;
  private readonly _process: ProcessControl;
  private readonly _statusBar: StatusBarLike | null;
  private readonly _pingIntervalMs: number;
  private readonly _maxReconnectDelay: number;
  private readonly _initialReconnectDelay: number;

  constructor(config: ChatClientConfig) {
    this._wsUrl = config.wsUrl;
    this._mode = config.mode;
    this._wsFactory = config.wsFactory;
    this._terminal = config.terminal;
    this._process = config.process ?? process;
    this._statusBar = config.statusBar ?? null;
    this._pingIntervalMs = config.pingIntervalMs ?? 30000;
    this._maxReconnectDelay = config.maxReconnectDelay ?? 30000;
    this._initialReconnectDelay = config.initialReconnectDelay ?? 1000;
    this._reconnectDelay = this._initialReconnectDelay;
  }

  get isRunning(): boolean {
    return this._running;
  }

  get currentSession(): string | null {
    return this._currentSessionId;
  }

  connect(): void {
    this._reconnectScheduled = false;
    const ws = this._wsFactory(this._wsUrl);
    this._ws = ws;

    ws.on("open", () => this.handleWsOpen());
    ws.on("message", (...args: unknown[]) => this.handleWsMessage(args[0] as Buffer | string));
    ws.on("close", () => this.handleWsClose());
    ws.on("error", (...args: unknown[]) => this.handleWsError(args[0] as Error));

    // Keepalive ping
    this._pingInterval = setInterval(() => {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, this._pingIntervalMs);

    ws.on("close", () => {
      if (this._pingInterval) {
        clearInterval(this._pingInterval);
        this._pingInterval = null;
      }
    });
  }

  close(): void {
    this._userClose = true;
    if (this._statusBar) this._statusBar.teardown();
    if (this._ws) this._ws.close();
    this._terminal.closeReadline();
    this._process.exit(0);
  }

  // ─── Internal handlers ────────────────────────────────────────

  private handleWsOpen(): void {
    this._reconnectDelay = this._initialReconnectDelay;

    // Set up scroll region BEFORE any output so the clip area is established first
    if (this._statusBar) {
      this._statusBar.setup();
      this._statusBar.update({ connection: "connected", wsUrl: this._wsUrl, mode: this._mode });
    }

    this._terminal.writeLine(green("Connected to KarnEvil9 server"));
    this._terminal.writeLine(dim("Type a message to start a session. Commands: /help, /abort, /quit\n"));

    this._terminal.createReadline();
    this._terminal.setPrompt(chatPrompt(this._running));
    this._terminal.prompt();

    this._terminal.onLine((line: string) => this.handleLine(line));
    this._terminal.onClose(() => {
      if (this._reconnecting) return;
      this.close();
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      this.updatePrompt();
      return;
    }

    switch (trimmed) {
      case "/quit":
      case "/exit":
        this.close();
        return;
      case "/abort":
        if (this._currentSessionId && this._ws) {
          this._ws.send(JSON.stringify({ type: "abort", session_id: this._currentSessionId }));
          this.printAbove(yellow("Abort requested"));
        } else {
          this.printAbove(dim("No active session to abort"));
        }
        break;
      case "/help":
        this.printAbove(helpText());
        break;
      default:
        if (this._ws) {
          this._ws.send(JSON.stringify({ type: "submit", text: trimmed, mode: this._mode }));
        }
        // Don't updatePrompt here — session.created will set [running] prompt
        return;
    }
    this.updatePrompt();
  }

  private handleWsMessage(raw: Buffer | string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : (raw as Buffer).toString("utf-8"));
    } catch {
      return;
    }

    switch (msg.type) {
      case "session.created": {
        const sid = String(msg.session_id ?? "");
        this._currentSessionId = sid;
        this._running = true;
        this.printAbove(green(`Session ${sid} created`));
        if (this._statusBar) {
          this._statusBar.update({
            sessionState: "running",
            sessionId: sid,
            totalTokens: 0,
            costUsd: 0,
            model: null,
          });
        }
        break;
      }
      case "event": {
        const event = msg.event as Record<string, unknown>;
        const eventType = String(event?.type ?? "");
        const payload = event?.payload as Record<string, unknown> | undefined;

        // Intercept usage.recorded for status bar before formatEvent (which suppresses it)
        if (eventType === "usage.recorded" && this._statusBar && payload) {
          const cumulative = payload.cumulative as Record<string, unknown> | undefined;
          if (cumulative) {
            this._statusBar.update({
              totalTokens: typeof cumulative.total_tokens === "number" ? cumulative.total_tokens : 0,
              costUsd: typeof cumulative.total_cost_usd === "number" ? cumulative.total_cost_usd : 0,
            });
          }
          const model = payload.model;
          if (typeof model === "string" && model) {
            this._statusBar.update({ model });
          }
        }

        const formatted = formatEvent(String(msg.session_id), event);
        if (formatted !== null) this.printAbove(formatted);

        if (TERMINAL_EVENTS.has(eventType)) {
          this._running = false;
          this._currentSessionId = null;
          if (this._statusBar) {
            this._statusBar.update({ sessionState: "idle", sessionId: null });
          }
          this.updatePrompt();
        }
        break;
      }
      case "approve.needed": {
        const requestId = String(msg.request_id ?? "");
        const request = msg.request as Record<string, unknown> | undefined;
        const toolName = String(request?.tool_name ?? "?");
        const perms = request?.permissions;
        const scopes = Array.isArray(perms)
          ? perms.map((p: unknown) => String((p as Record<string, unknown>).scope ?? "")).join(", ")
          : "";
        if (requestId) {
          this._approvalQueue.push({ requestId, toolName, scopes });
          this.processApprovalQueue();
        }
        break;
      }
      case "error":
        this.printAbove(red(`Error: ${msg.message ?? "unknown"}`));
        break;
      case "pong":
        break;
    }
  }

  private handleWsClose(): void {
    if (this._userClose) return;
    this._reconnecting = true;
    this._terminal.closeReadline();
    this._reconnecting = false;
    if (this._statusBar) this._statusBar.update({ connection: "reconnecting" });
    this._terminal.writeLine(yellow(`\nDisconnected. Reconnecting in ${this._reconnectDelay / 1000}s...`));
    this.scheduleReconnect();
  }

  private handleWsError(err: Error): void {
    if (this._userClose) return;
    if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      this._reconnecting = true;
      this._terminal.closeReadline();
      this._reconnecting = false;
      if (this._statusBar) this._statusBar.update({ connection: "disconnected" });
      this._terminal.writeLine(red(`Cannot connect to server — is it running?`));
      this._terminal.writeLine(yellow(`Retrying in ${this._reconnectDelay / 1000}s...`));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this._reconnectScheduled) return;
    this._reconnectScheduled = true;
    setTimeout(() => this.connect(), this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
  }

  private processApprovalQueue(): void {
    if (this._approvalActive || this._approvalQueue.length === 0) return;
    this._approvalActive = true;
    const { requestId, toolName, scopes } = this._approvalQueue.shift()!;
    const pending = this._approvalQueue.length;
    const pendingNote = pending > 0 ? dim(` (${pending} more pending)`) : "";
    // Flush any buffered output before showing the question
    this.flushOutputBuffer();
    this._terminal.clearLine();
    this._terminal.writeLine(yellow(`\nApproval needed — Tool: ${toolName}, Scopes: ${scopes}`) + pendingNote);
    this._terminal.question(yellow("[a]llow once / [s]ession / [d]eny: "), (answer: string) => {
      const map: Record<string, string> = { a: "allow_once", s: "allow_session", d: "deny" };
      const decision = map[answer.trim().toLowerCase()] ?? "deny";
      if (this._ws) {
        this._ws.send(JSON.stringify({ type: "approve", request_id: requestId, decision }));
      }
      this._approvalActive = false;
      this.flushOutputBuffer();
      if (this._approvalQueue.length > 0) {
        this.processApprovalQueue();
      } else {
        this.updatePrompt();
      }
    });
  }

  private printAbove(text: string): void {
    if (this._approvalActive) {
      // Buffer output while a question is visible to avoid overwriting it
      this._outputBuffer.push(text);
      return;
    }
    this._terminal.clearLine();
    this._terminal.writeLine(text);
    // Only re-render the prompt when idle — during execution, events just stream
    if (!this._running) {
      this.updatePrompt();
    }
  }

  private flushOutputBuffer(): void {
    if (this._outputBuffer.length === 0) return;
    for (const line of this._outputBuffer) {
      this._terminal.writeLine(line);
    }
    this._outputBuffer = [];
  }

  private updatePrompt(): void {
    this._terminal.setPrompt(chatPrompt(this._running));
    this._terminal.prompt();
  }
}

// ─── RealTerminalIO ───────────────────────────────────────────────

export class RealTerminalIO implements TerminalIO {
  private _rl: readline.Interface | null = null;

  createReadline(): void {
    // Close existing readline to prevent listener stacking on process.stdin
    if (this._rl) {
      this._rl.removeAllListeners();
      this._rl.close();
    }
    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  closeReadline(): void {
    if (this._rl) {
      this._rl.removeAllListeners();
      this._rl.close();
      this._rl = null;
    }
  }

  setPrompt(prompt: string): void {
    if (this._rl) this._rl.setPrompt(prompt);
  }

  prompt(): void {
    if (this._rl) this._rl.prompt(true);
  }

  onLine(handler: (line: string) => void): void {
    if (this._rl) this._rl.on("line", handler);
  }

  onClose(handler: () => void): void {
    if (this._rl) this._rl.on("close", handler);
  }

  question(prompt: string, callback: (answer: string) => void): void {
    if (this._rl) this._rl.question(prompt, callback);
  }

  clearLine(): void {
    process.stdout.write("\r\x1b[K");
  }

  writeLine(text: string): void {
    console.log(text);
  }
}
