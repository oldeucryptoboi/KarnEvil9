import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatClient, type ChatWebSocket, type TerminalIO, type ProcessControl } from "./chat-client.js";
import type { StatusBarLike, StatusBarData } from "./status-bar.js";

// ─── Mock helpers ─────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

class MockWebSocket implements ChatWebSocket {
  sent: string[] = [];
  readyState = 0; // CONNECTING
  private listeners = new Map<string, Listener[]>();

  send(data: string): void { this.sent.push(data); }
  close(): void { /* no-op */ }
  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    for (const l of this.listeners.get("open") ?? []) l();
  }
  simulateMessage(data: string): void {
    for (const l of this.listeners.get("message") ?? []) l(data);
  }
  simulateClose(): void {
    this.readyState = 3; // CLOSED
    for (const l of this.listeners.get("close") ?? []) l();
  }
  simulateError(err: Error): void {
    for (const l of this.listeners.get("error") ?? []) l(err);
  }
}

class MockTerminal implements TerminalIO {
  lines: string[] = [];
  prompts: string[] = [];
  cleared = 0;
  private lineHandler: ((line: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private questionCallback: ((answer: string) => void) | null = null;
  questionPrompt: string | null = null;
  created = 0;
  closed = 0;

  createReadline(): void { this.created++; }
  closeReadline(): void { this.closed++; }
  setPrompt(prompt: string): void { this.prompts.push(prompt); }
  prompt(): void { /* no-op */ }
  onLine(handler: (line: string) => void): void { this.lineHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  question(prompt: string, callback: (answer: string) => void): void {
    this.questionPrompt = prompt;
    this.questionCallback = callback;
  }
  clearLine(): void { this.cleared++; }
  writeLine(text: string): void { this.lines.push(text); }

  simulateLine(text: string): void { this.lineHandler?.(text); }
  simulateClose(): void { this.closeHandler?.(); }
  simulateAnswer(text: string): void { this.questionCallback?.(text); }
}

function createMockProcess(): ProcessControl & { exit: ReturnType<typeof vi.fn> } {
  return { exit: vi.fn() };
}

class MockStatusBar implements StatusBarLike {
  setupCalls = 0;
  teardownCalls = 0;
  repaintCalls = 0;
  resizeCalls = 0;
  updates: Array<Partial<StatusBarData>> = [];

  setup(): void { this.setupCalls++; }
  teardown(): void { this.teardownCalls++; }
  update(patch: Partial<StatusBarData>): void { this.updates.push(patch); }
  repaint(): void { this.repaintCalls++; }
  onResize(): void { this.resizeCalls++; }

  /** Get the most recent update, or undefined. */
  lastUpdate(): Partial<StatusBarData> | undefined {
    return this.updates[this.updates.length - 1];
  }

  /** Get all updates that touched a specific key. */
  updatesFor<K extends keyof StatusBarData>(key: K): Array<StatusBarData[K]> {
    return this.updates
      .filter((u) => key in u)
      .map((u) => u[key] as StatusBarData[K]);
  }
}

function createClient(overrides?: {
  ws?: MockWebSocket;
  terminal?: MockTerminal;
  process?: ProcessControl;
  wsFactory?: (url: string) => ChatWebSocket;
  statusBar?: MockStatusBar;
  pingIntervalMs?: number;
  maxReconnectDelay?: number;
  initialReconnectDelay?: number;
}) {
  const ws = overrides?.ws ?? new MockWebSocket();
  const terminal = overrides?.terminal ?? new MockTerminal();
  const proc = overrides?.process ?? createMockProcess();
  const factory = overrides?.wsFactory ?? (() => ws);
  const statusBar = overrides?.statusBar;

  const client = new ChatClient({
    wsUrl: "ws://test:3100/api/ws",
    mode: "real",
    wsFactory: factory,
    terminal,
    process: proc,
    statusBar,
    pingIntervalMs: overrides?.pingIntervalMs ?? 60000, // long to avoid interference
    maxReconnectDelay: overrides?.maxReconnectDelay ?? 30000,
    initialReconnectDelay: overrides?.initialReconnectDelay ?? 1000,
  });

  return { client, ws, terminal, process: proc as ReturnType<typeof createMockProcess>, statusBar };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("ChatClient", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe("connection lifecycle", () => {
    it("calls wsFactory with the configured URL", () => {
      const factory = vi.fn(() => new MockWebSocket());
      const { client } = createClient({ wsFactory: factory });
      client.connect();
      expect(factory).toHaveBeenCalledWith("ws://test:3100/api/ws");
    });

    it("prints 'Connected' on open", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      expect(terminal.lines.some((l) => l.includes("Connected"))).toBe(true);
    });

    it("creates readline on open", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      expect(terminal.created).toBe(1);
    });

    it("reconnects on non-user close", () => {
      const sockets: MockWebSocket[] = [];
      const factory = vi.fn(() => {
        const s = new MockWebSocket();
        sockets.push(s);
        return s;
      });
      const { client } = createClient({ wsFactory: factory, initialReconnectDelay: 500 });
      client.connect();
      sockets[0]!.simulateOpen();
      sockets[0]!.simulateClose();

      expect(factory).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it("does not reconnect on user close", () => {
      const factory = vi.fn(() => new MockWebSocket());
      const { client } = createClient({ wsFactory: factory });
      client.connect();
      client.close();
      vi.advanceTimersByTime(60000);
      // Only called once for the initial connect
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("applies exponential backoff capped at maxReconnectDelay", () => {
      const sockets: MockWebSocket[] = [];
      const factory = vi.fn(() => {
        const s = new MockWebSocket();
        sockets.push(s);
        return s;
      });
      const { client } = createClient({
        wsFactory: factory,
        initialReconnectDelay: 1000,
        maxReconnectDelay: 4000,
      });
      client.connect();

      // First disconnect (without open → no delay reset) → 1000ms delay
      sockets[0]!.simulateClose();
      vi.advanceTimersByTime(999);
      expect(factory).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(2);

      // Second disconnect (without open) → 2000ms delay
      sockets[1]!.simulateClose();
      vi.advanceTimersByTime(1999);
      expect(factory).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(3);

      // Third disconnect (without open) → capped at 4000ms
      sockets[2]!.simulateClose();
      vi.advanceTimersByTime(3999);
      expect(factory).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(4);
    });

    it("resets reconnect delay on successful connect", () => {
      const sockets: MockWebSocket[] = [];
      const factory = vi.fn(() => {
        const s = new MockWebSocket();
        sockets.push(s);
        return s;
      });
      const { client } = createClient({
        wsFactory: factory,
        initialReconnectDelay: 1000,
        maxReconnectDelay: 30000,
      });
      client.connect();

      // First connection + disconnect → delay becomes 2000
      sockets[0]!.simulateOpen();
      sockets[0]!.simulateClose();
      vi.advanceTimersByTime(1000);

      // Second connection succeeds (resets delay), then disconnects → delay should be 1000 again
      sockets[1]!.simulateOpen();
      sockets[1]!.simulateClose();
      vi.advanceTimersByTime(999);
      expect(factory).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(3);
    });
  });

  describe("user input", () => {
    it("/quit exits the process", () => {
      const { client, ws, terminal, process: proc } = createClient();
      client.connect();
      ws.simulateOpen();
      terminal.simulateLine("/quit");
      expect(proc.exit).toHaveBeenCalledWith(0);
    });

    it("/exit exits the process", () => {
      const { client, ws, terminal, process: proc } = createClient();
      client.connect();
      ws.simulateOpen();
      terminal.simulateLine("/exit");
      expect(proc.exit).toHaveBeenCalledWith(0);
    });

    it("/help prints help text", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      terminal.simulateLine("/help");
      expect(terminal.lines.some((l) => l.includes("/help"))).toBe(true);
      expect(terminal.lines.some((l) => l.includes("/abort"))).toBe(true);
      expect(terminal.lines.some((l) => l.includes("/quit"))).toBe(true);
    });

    it("/abort sends abort message when session is active", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      // Create a session first
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      terminal.simulateLine("/abort");
      const abortMsg = ws.sent.find((s) => JSON.parse(s).type === "abort");
      expect(abortMsg).toBeDefined();
      expect(JSON.parse(abortMsg!).session_id).toBe("s1");
    });

    it("/abort prints message when no active session", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      terminal.simulateLine("/abort");
      expect(terminal.lines.some((l) => l.includes("No active session"))).toBe(true);
    });

    it("text input sends submit message", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      terminal.simulateLine("hello world");
      const submitMsg = ws.sent.find((s) => JSON.parse(s).type === "submit");
      expect(submitMsg).toBeDefined();
      const parsed = JSON.parse(submitMsg!);
      expect(parsed.text).toBe("hello world");
      expect(parsed.mode).toBe("real");
    });

    it("empty input is ignored", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      const sentBefore = ws.sent.length;
      terminal.simulateLine("   ");
      // No new messages sent (only ping interval messages possible)
      const sentAfter = ws.sent.length;
      expect(sentAfter).toBe(sentBefore);
    });
  });

  describe("server messages", () => {
    it("session.created sets running state and session id", () => {
      const { client, ws } = createClient();
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      expect(client.isRunning).toBe(true);
      expect(client.currentSession).toBe("s1");
    });

    it("terminal event resets running state", () => {
      const { client, ws } = createClient();
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      ws.simulateMessage(JSON.stringify({
        type: "event",
        session_id: "s1",
        event: { type: "session.completed", timestamp: "2025-01-01T00:00:00Z", payload: {} },
      }));
      expect(client.isRunning).toBe(false);
      expect(client.currentSession).toBeNull();
    });

    it("event formats and prints via formatEvent", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({
        type: "event",
        session_id: "s1",
        event: { type: "step.succeeded", timestamp: "2025-01-01T12:00:00Z", payload: { output: "result" } },
      }));
      expect(terminal.lines.some((l) => l.includes("step.succeeded"))).toBe(true);
      expect(terminal.lines.some((l) => l.includes("result"))).toBe(true);
    });

    it("approve.needed prompts user and sends response", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({
        type: "approve.needed",
        request_id: "req1",
        request: { tool_name: "shell-exec", permissions: [{ scope: "shell:exec:*" }] },
      }));
      expect(terminal.lines.some((l) => l.includes("Approval needed"))).toBe(true);
      expect(terminal.questionPrompt).not.toBeNull();

      // Simulate user answering "a" for allow_once
      terminal.simulateAnswer("a");
      const approveMsg = ws.sent.find((s) => {
        try { return JSON.parse(s).type === "approve"; } catch { return false; }
      });
      expect(approveMsg).toBeDefined();
      const parsed = JSON.parse(approveMsg!);
      expect(parsed.request_id).toBe("req1");
      expect(parsed.decision).toBe("allow_once");
    });

    it("approve.needed defaults to deny for unknown answer", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({
        type: "approve.needed",
        request_id: "req2",
        request: { tool_name: "write-file", permissions: [] },
      }));
      terminal.simulateAnswer("x");
      const approveMsg = ws.sent.find((s) => {
        try { return JSON.parse(s).type === "approve"; } catch { return false; }
      });
      expect(JSON.parse(approveMsg!).decision).toBe("deny");
    });

    it("concurrent approvals are queued and presented one at a time", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();

      // Three approvals arrive at once
      ws.simulateMessage(JSON.stringify({
        type: "approve.needed", request_id: "r1",
        request: { tool_name: "read-file", permissions: [{ scope: "fs:read" }] },
      }));
      ws.simulateMessage(JSON.stringify({
        type: "approve.needed", request_id: "r2",
        request: { tool_name: "read-file", permissions: [{ scope: "fs:read" }] },
      }));
      ws.simulateMessage(JSON.stringify({
        type: "approve.needed", request_id: "r3",
        request: { tool_name: "read-file", permissions: [{ scope: "fs:read" }] },
      }));

      // Only the first question should be active
      expect(terminal.questionPrompt).not.toBeNull();

      // Answer the first — sends approve for r1, then shows second question
      terminal.simulateAnswer("s");
      const r1Msg = ws.sent.find((s) => {
        try { const p = JSON.parse(s); return p.type === "approve" && p.request_id === "r1"; } catch { return false; }
      });
      expect(r1Msg).toBeDefined();
      expect(JSON.parse(r1Msg!).decision).toBe("allow_session");

      // Answer the second
      terminal.simulateAnswer("a");
      const r2Msg = ws.sent.find((s) => {
        try { const p = JSON.parse(s); return p.type === "approve" && p.request_id === "r2"; } catch { return false; }
      });
      expect(r2Msg).toBeDefined();
      expect(JSON.parse(r2Msg!).decision).toBe("allow_once");

      // Answer the third
      terminal.simulateAnswer("d");
      const r3Msg = ws.sent.find((s) => {
        try { const p = JSON.parse(s); return p.type === "approve" && p.request_id === "r3"; } catch { return false; }
      });
      expect(r3Msg).toBeDefined();
      expect(JSON.parse(r3Msg!).decision).toBe("deny");
    });

    it("shows pending count for queued approvals", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();

      ws.simulateMessage(JSON.stringify({
        type: "approve.needed", request_id: "r1",
        request: { tool_name: "read-file", permissions: [{ scope: "fs:read" }] },
      }));
      ws.simulateMessage(JSON.stringify({
        type: "approve.needed", request_id: "r2",
        request: { tool_name: "write-file", permissions: [{ scope: "fs:write" }] },
      }));

      // First approval shown — second is pending
      terminal.simulateAnswer("a");
      // After answering first, second should be shown with pending note
      expect(terminal.lines.some((l) => l.includes("write-file"))).toBe(true);
    });

    it("error prints in red", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "error", message: "something broke" }));
      expect(terminal.lines.some((l) => l.includes("Error") && l.includes("something broke"))).toBe(true);
    });

    it("pong is silent", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      const linesBefore = terminal.lines.length;
      ws.simulateMessage(JSON.stringify({ type: "pong" }));
      // Only prompt-related output, no new writeLine calls for pong
      expect(terminal.lines.length).toBe(linesBefore);
    });

    it("invalid JSON is ignored", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      const linesBefore = terminal.lines.length;
      ws.simulateMessage("not valid json{{{");
      expect(terminal.lines.length).toBe(linesBefore);
    });

    it("unknown message type is ignored", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      const linesBefore = terminal.lines.length;
      ws.simulateMessage(JSON.stringify({ type: "totally.unknown" }));
      expect(terminal.lines.length).toBe(linesBefore);
    });
  });

  describe("state transitions", () => {
    it("full session cycle: created → event → completed", () => {
      const { client, ws } = createClient();
      client.connect();
      ws.simulateOpen();

      expect(client.isRunning).toBe(false);
      expect(client.currentSession).toBeNull();

      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      expect(client.isRunning).toBe(true);
      expect(client.currentSession).toBe("s1");

      ws.simulateMessage(JSON.stringify({
        type: "event", session_id: "s1",
        event: { type: "step.succeeded", timestamp: "2025-01-01T00:00:00Z", payload: { output: "ok" } },
      }));
      expect(client.isRunning).toBe(true);

      ws.simulateMessage(JSON.stringify({
        type: "event", session_id: "s1",
        event: { type: "session.completed", timestamp: "2025-01-01T00:00:01Z", payload: {} },
      }));
      expect(client.isRunning).toBe(false);
      expect(client.currentSession).toBeNull();
    });

    it("supports multiple sequential sessions", () => {
      const { client, ws } = createClient();
      client.connect();
      ws.simulateOpen();

      // First session
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      expect(client.currentSession).toBe("s1");
      ws.simulateMessage(JSON.stringify({
        type: "event", session_id: "s1",
        event: { type: "session.completed", timestamp: "2025-01-01T00:00:00Z", payload: {} },
      }));
      expect(client.currentSession).toBeNull();

      // Second session
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s2" }));
      expect(client.currentSession).toBe("s2");
    });

    it("submit during running session still sends", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      terminal.simulateLine("more input");
      const submitMsgs = ws.sent.filter((s) => {
        try { return JSON.parse(s).type === "submit"; } catch { return false; }
      });
      expect(submitMsgs.length).toBe(1);
      expect(JSON.parse(submitMsgs[0]!).text).toBe("more input");
    });
  });

  describe("reconnection", () => {
    it("schedules reconnect after ws close", () => {
      const sockets: MockWebSocket[] = [];
      const factory = vi.fn(() => {
        const s = new MockWebSocket();
        sockets.push(s);
        return s;
      });
      const { client, terminal } = createClient({ wsFactory: factory, initialReconnectDelay: 2000 });
      client.connect();
      sockets[0]!.simulateOpen();
      sockets[0]!.simulateClose();
      expect(terminal.lines.some((l) => l.includes("Disconnected"))).toBe(true);
      expect(terminal.lines.some((l) => l.includes("Reconnecting in 2s"))).toBe(true);
    });

    it("ECONNREFUSED shows error + retry message", () => {
      const { client, ws, terminal } = createClient({ initialReconnectDelay: 3000 });
      client.connect();
      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      ws.simulateError(err);
      expect(terminal.lines.some((l) => l.includes("Cannot connect"))).toBe(true);
      expect(terminal.lines.some((l) => l.includes("Retrying in 3s"))).toBe(true);
    });

    it("reconnecting flag prevents terminal close from exiting", () => {
      const sockets: MockWebSocket[] = [];
      const factory = vi.fn(() => {
        const s = new MockWebSocket();
        sockets.push(s);
        return s;
      });
      const proc = createMockProcess();
      const { client } = createClient({ wsFactory: factory, process: proc });
      client.connect();
      sockets[0]!.simulateOpen();
      // Simulate ws close (which sets reconnecting briefly and closes readline)
      sockets[0]!.simulateClose();
      // Process.exit should not have been called during reconnection
      expect(proc.exit).not.toHaveBeenCalled();
    });

    it("clears ping interval on close", () => {
      const { client, ws } = createClient({ pingIntervalMs: 100 });
      client.connect();
      ws.simulateOpen();
      // Verify ping is sent
      vi.advanceTimersByTime(100);
      const pings = ws.sent.filter((s) => JSON.parse(s).type === "ping");
      expect(pings.length).toBe(1);

      ws.simulateClose();
      // Advance more time — no additional pings should be sent
      vi.advanceTimersByTime(500);
      const pingsAfter = ws.sent.filter((s) => JSON.parse(s).type === "ping");
      expect(pingsAfter.length).toBe(1);
    });
  });

  describe("status bar integration", () => {
    it("calls setup on open and teardown on close", () => {
      const statusBar = new MockStatusBar();
      const { client, ws } = createClient({ statusBar });
      client.connect();
      ws.simulateOpen();
      expect(statusBar.setupCalls).toBe(1);
      expect(statusBar.updatesFor("connection")).toContain("connected");

      client.close();
      expect(statusBar.teardownCalls).toBe(1);
    });

    it("updates connection state to reconnecting on ws close", () => {
      const sockets: MockWebSocket[] = [];
      const factory = vi.fn(() => {
        const s = new MockWebSocket();
        sockets.push(s);
        return s;
      });
      const statusBar = new MockStatusBar();
      const { client } = createClient({ wsFactory: factory, statusBar });
      client.connect();
      sockets[0]!.simulateOpen();
      sockets[0]!.simulateClose();
      expect(statusBar.updatesFor("connection")).toContain("reconnecting");
    });

    it("updates connection state to disconnected on ECONNREFUSED", () => {
      const statusBar = new MockStatusBar();
      const { client, ws } = createClient({ statusBar });
      client.connect();
      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      ws.simulateError(err);
      expect(statusBar.updatesFor("connection")).toContain("disconnected");
    });

    it("updates session state on session.created", () => {
      const statusBar = new MockStatusBar();
      const { client, ws } = createClient({ statusBar });
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      expect(statusBar.updatesFor("sessionState")).toContain("running");
      expect(statusBar.updatesFor("sessionId")).toContain("s1");
    });

    it("resets token counters on new session", () => {
      const statusBar = new MockStatusBar();
      const { client, ws } = createClient({ statusBar });
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      const sessionUpdate = statusBar.updates.find(
        (u) => u.sessionState === "running",
      );
      expect(sessionUpdate?.totalTokens).toBe(0);
      expect(sessionUpdate?.costUsd).toBe(0);
    });

    it("updates session state to idle on terminal event", () => {
      const statusBar = new MockStatusBar();
      const { client, ws } = createClient({ statusBar });
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      ws.simulateMessage(JSON.stringify({
        type: "event",
        session_id: "s1",
        event: { type: "session.completed", timestamp: "2025-01-01T00:00:00Z", payload: {} },
      }));
      expect(statusBar.updatesFor("sessionState")).toContain("idle");
    });

    it("extracts tokens and cost from usage.recorded events", () => {
      const statusBar = new MockStatusBar();
      const { client, ws } = createClient({ statusBar });
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      ws.simulateMessage(JSON.stringify({
        type: "event",
        session_id: "s1",
        event: {
          type: "usage.recorded",
          timestamp: "2025-01-01T00:00:00Z",
          payload: {
            model: "claude-sonnet-4-5-20250929",
            cumulative: { total_tokens: 15000, total_cost_usd: 0.03 },
          },
        },
      }));
      expect(statusBar.updatesFor("totalTokens")).toContain(15000);
      expect(statusBar.updatesFor("costUsd")).toContain(0.03);
      expect(statusBar.updatesFor("model")).toContain("claude-sonnet-4-5-20250929");
    });

    it("handles usage.recorded without cumulative gracefully", () => {
      const statusBar = new MockStatusBar();
      const { client, ws } = createClient({ statusBar });
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({
        type: "event",
        session_id: "s1",
        event: {
          type: "usage.recorded",
          timestamp: "2025-01-01T00:00:00Z",
          payload: { model: "gpt-4o" },
        },
      }));
      // Should still update model without crashing
      expect(statusBar.updatesFor("model")).toContain("gpt-4o");
    });

    it("works correctly without a status bar (no crash)", () => {
      const { client, ws, terminal } = createClient();
      client.connect();
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "session.created", session_id: "s1" }));
      ws.simulateMessage(JSON.stringify({
        type: "event",
        session_id: "s1",
        event: {
          type: "usage.recorded",
          timestamp: "2025-01-01T00:00:00Z",
          payload: { cumulative: { total_tokens: 100, total_cost_usd: 0.001 } },
        },
      }));
      // Should not crash — usage.recorded is suppressed by formatEvent
      expect(terminal.lines.every((l) => !l.includes("usage.recorded"))).toBe(true);
    });
  });
});
