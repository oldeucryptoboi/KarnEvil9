import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JournalRelay } from "./journal-relay.js";

// ── Mock factories ──

function mockTelegramClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue(1001), // returns message_id
    editMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function mockSessionBridge() {
  const chatMap = new Map(); // sessionId -> chatId
  return {
    getChatIdForSession: vi.fn((sid) => chatMap.get(sid)),
    removeSession: vi.fn(),
    // Test helper: register a mapping
    _register(sessionId, chatId) {
      chatMap.set(sessionId, chatId);
    },
  };
}

function mockApprovalHandler() {
  return {
    handlePermissionRequest: vi.fn().mockResolvedValue(undefined),
  };
}

function mockJournal() {
  let handler = null;
  return {
    on: vi.fn((fn) => {
      handler = fn;
      return () => { handler = null; };
    }),
    // Test helper: emit an event
    _emit(event) {
      if (handler) handler(event);
    },
  };
}

function makeEvent(type, sessionId = "sess-1", payload = {}) {
  return { type, session_id: sessionId, payload };
}

// ── Tests ──

describe("JournalRelay", () => {
  let telegramClient, sessionBridge, approvalHandler, journal, relay;

  beforeEach(() => {
    vi.useFakeTimers();
    telegramClient = mockTelegramClient();
    sessionBridge = mockSessionBridge();
    approvalHandler = mockApprovalHandler();
    journal = mockJournal();

    sessionBridge._register("sess-1", 42);

    relay = new JournalRelay({
      journal,
      telegramClient,
      sessionBridge,
      approvalHandler,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    relay.start();
  });

  afterEach(() => {
    relay.stop();
    vi.useRealTimers();
  });

  // ── Ignores irrelevant events ──

  it("ignores events not in RELAYED_EVENTS set", async () => {
    journal._emit(makeEvent("some.random.event"));
    await vi.advanceTimersByTimeAsync(100);
    expect(telegramClient.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores events for unknown sessions", async () => {
    journal._emit(makeEvent("step.started", "unknown-session", { tool_name: "test" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(telegramClient.sendMessage).not.toHaveBeenCalled();
  });

  // ── Permission delegation ──

  it("delegates permission.requested to approval handler", async () => {
    journal._emit(makeEvent("permission.requested", "sess-1", { tool_name: "test" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(approvalHandler.handlePermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: "permission.requested" }),
      42,
    );
    expect(telegramClient.sendMessage).not.toHaveBeenCalled();
  });

  // ── Progress events: edit-in-place ──

  describe("progress events (edit-in-place)", () => {
    it("sends a new message for first progress event", async () => {
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 3 }));
      await vi.advanceTimersByTimeAsync(100);

      expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegramClient.sendMessage).toHaveBeenCalledWith({
        chatId: 42,
        text: expect.stringContaining("Plan accepted"),
      });
    });

    it("edits the message for subsequent progress events (after debounce)", async () => {
      // First event → sends new message
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 3 }));
      await vi.advanceTimersByTimeAsync(100);

      // Second event → appends to tracker, schedules edit
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "search" }));
      await vi.advanceTimersByTimeAsync(100);

      // Not yet edited (debounce = 1500ms)
      expect(telegramClient.editMessage).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(1500);

      expect(telegramClient.editMessage).toHaveBeenCalledTimes(1);
      expect(telegramClient.editMessage).toHaveBeenCalledWith({
        chatId: 42,
        messageId: 1001,
        text: expect.stringContaining("Running search"),
      });
    });

    it("debounces rapid successive events into one edit", async () => {
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 5 }));
      await vi.advanceTimersByTimeAsync(100);

      // Rapid-fire 3 events within debounce window
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "tool1" }));
      await vi.advanceTimersByTimeAsync(100);
      journal._emit(makeEvent("step.succeeded", "sess-1", { step_id: "s1" }));
      await vi.advanceTimersByTimeAsync(100);
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "tool2" }));
      await vi.advanceTimersByTimeAsync(100);

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(1500);

      // Should only have edited once with all 3 lines
      expect(telegramClient.editMessage).toHaveBeenCalledTimes(1);
      const editText = telegramClient.editMessage.mock.calls[0][0].text;
      expect(editText).toContain("Plan accepted");
      expect(editText).toContain("Running tool1");
      expect(editText).toContain("s1");
      expect(editText).toContain("Running tool2");
    });

    it("handles rapid events arriving before first sendMessage resolves (race condition)", async () => {
      // Simulate slow sendMessage — resolves after a delay
      let resolveSend;
      telegramClient.sendMessage.mockImplementationOnce(() => {
        return new Promise((resolve) => { resolveSend = resolve; });
      });

      // Fire 3 events rapidly — all before sendMessage resolves
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 3 }));
      await vi.advanceTimersByTimeAsync(10);
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "tool1" }));
      await vi.advanceTimersByTimeAsync(10);
      journal._emit(makeEvent("step.succeeded", "sess-1", { step_id: "s1" }));
      await vi.advanceTimersByTimeAsync(10);

      // Only 1 sendMessage call (the first event), not 3
      expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);

      // Now resolve the first sendMessage
      resolveSend(1001);
      await vi.advanceTimersByTimeAsync(10);

      // After resolving, the accumulated lines should schedule an edit
      await vi.advanceTimersByTimeAsync(1500);

      expect(telegramClient.editMessage).toHaveBeenCalledTimes(1);
      const editText = telegramClient.editMessage.mock.calls[0][0].text;
      expect(editText).toContain("Plan accepted");
      expect(editText).toContain("Running tool1");
      expect(editText).toContain("s1");
    });

    it("truncates lines beyond MAX_PROGRESS_LINES (10)", async () => {
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 20 }));
      await vi.advanceTimersByTimeAsync(100);

      // Emit 12 more events (total 13 lines)
      for (let i = 1; i <= 12; i++) {
        journal._emit(makeEvent("step.started", "sess-1", { tool_name: `tool${i}` }));
        await vi.advanceTimersByTimeAsync(100);
      }

      await vi.advanceTimersByTimeAsync(1500);

      const editText = telegramClient.editMessage.mock.calls.at(-1)[0].text;
      const lines = editText.split("\n");
      // Should be: first line + "..." + last 8 = 10 lines
      expect(lines).toHaveLength(10);
      expect(lines[0]).toContain("Plan accepted");
      expect(lines[1]).toBe("...");
      expect(lines[lines.length - 1]).toContain("tool12");
    });
  });

  // ── Terminal events: final flush + standalone messages ──

  describe("terminal events (final flush + standalone)", () => {
    it("sends session.completed as a standalone message", async () => {
      // Start progress first
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 1 }));
      await vi.advanceTimersByTimeAsync(100);
      telegramClient.sendMessage.mockClear();

      journal._emit(makeEvent("session.completed", "sess-1"));
      await vi.advanceTimersByTimeAsync(100);

      expect(telegramClient.sendMessage).toHaveBeenCalledWith({
        chatId: 42,
        text: expect.stringContaining("Session completed"),
      });
    });

    it("sends session.failed as a standalone message", async () => {
      journal._emit(makeEvent("session.failed", "sess-1", { error: "out of memory" }));
      await vi.advanceTimersByTimeAsync(100);

      expect(telegramClient.sendMessage).toHaveBeenCalledWith({
        chatId: 42,
        text: expect.stringContaining("Session failed"),
      });
    });

    it("sends session.aborted as a standalone message", async () => {
      journal._emit(makeEvent("session.aborted", "sess-1", { reason: "user cancelled" }));
      await vi.advanceTimersByTimeAsync(100);

      expect(telegramClient.sendMessage).toHaveBeenCalledWith({
        chatId: 42,
        text: expect.stringContaining("Session aborted"),
      });
    });

    it("final flushes progress before sending terminal message", async () => {
      // Build up progress with multiple lines
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 3 }));
      await vi.advanceTimersByTimeAsync(100);
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "search" }));
      await vi.advanceTimersByTimeAsync(100);
      journal._emit(makeEvent("step.succeeded", "sess-1", { step_id: "s1" }));
      await vi.advanceTimersByTimeAsync(100);

      // Terminal event — should flush progress edit BEFORE standalone message
      journal._emit(makeEvent("session.completed", "sess-1"));
      await vi.advanceTimersByTimeAsync(100);

      // Progress message was edited with all accumulated lines
      expect(telegramClient.editMessage).toHaveBeenCalledTimes(1);
      const editText = telegramClient.editMessage.mock.calls[0][0].text;
      expect(editText).toContain("Plan accepted");
      expect(editText).toContain("Running search");
      expect(editText).toContain("s1");

      // Terminal message sent as standalone
      expect(telegramClient.sendMessage).toHaveBeenCalledWith({
        chatId: 42,
        text: expect.stringContaining("Session completed"),
      });
    });

    it("final flush awaits pending sendMessage before editing", async () => {
      // Simulate slow sendMessage
      let resolveSend;
      telegramClient.sendMessage.mockImplementationOnce(() => {
        return new Promise((resolve) => { resolveSend = resolve; });
      });

      // Fire progress events before sendMessage resolves
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 3 }));
      await vi.advanceTimersByTimeAsync(10);
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "tool1" }));
      await vi.advanceTimersByTimeAsync(10);

      // Terminal event arrives while sendMessage still pending
      journal._emit(makeEvent("session.completed", "sess-1"));
      await vi.advanceTimersByTimeAsync(10);

      // Resolve the initial sendMessage — final flush should now edit
      resolveSend(1001);
      await vi.advanceTimersByTimeAsync(100);

      // Final flush should have edited with accumulated lines
      expect(telegramClient.editMessage).toHaveBeenCalledTimes(1);
      const editText = telegramClient.editMessage.mock.calls[0][0].text;
      expect(editText).toContain("Plan accepted");
      expect(editText).toContain("Running tool1");
    });

    it("clears progress tracker on terminal event", async () => {
      // Build up progress
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 3 }));
      await vi.advanceTimersByTimeAsync(100);
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "test" }));
      await vi.advanceTimersByTimeAsync(100);

      // Terminal event (triggers final flush + clears tracker)
      journal._emit(makeEvent("session.completed", "sess-1"));
      await vi.advanceTimersByTimeAsync(100);

      // Advancing past debounce should NOT trigger another edit (tracker cleared)
      telegramClient.editMessage.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      expect(telegramClient.editMessage).not.toHaveBeenCalled();
    });

    it("removes session from bridge on terminal event", async () => {
      journal._emit(makeEvent("session.completed", "sess-1"));
      await vi.advanceTimersByTimeAsync(100);

      expect(sessionBridge.removeSession).toHaveBeenCalledWith("sess-1");
    });
  });

  // ── Warning events: standalone messages ──

  describe("warning events (standalone)", () => {
    it("sends futility.detected as a standalone message", async () => {
      journal._emit(makeEvent("futility.detected", "sess-1"));
      await vi.advanceTimersByTimeAsync(100);

      expect(telegramClient.sendMessage).toHaveBeenCalledWith({
        chatId: 42,
        text: expect.stringContaining("Futility detected"),
      });
    });

    it("sends limit.exceeded as a standalone message", async () => {
      journal._emit(makeEvent("limit.exceeded", "sess-1", { limit: "max_iterations" }));
      await vi.advanceTimersByTimeAsync(100);

      expect(telegramClient.sendMessage).toHaveBeenCalledWith({
        chatId: 42,
        text: expect.stringContaining("Limit exceeded"),
      });
    });

    it("does not interfere with progress tracker", async () => {
      // Start progress
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 3 }));
      await vi.advanceTimersByTimeAsync(100);
      telegramClient.sendMessage.mockClear();

      // Warning in the middle
      journal._emit(makeEvent("futility.detected", "sess-1"));
      await vi.advanceTimersByTimeAsync(100);

      // Warning goes as new message
      expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);

      // More progress still edits the original
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "retry" }));
      await vi.advanceTimersByTimeAsync(1600);

      expect(telegramClient.editMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 1001, text: expect.stringContaining("retry") }),
      );
    });
  });

  // ── Error handling ──

  describe("error handling", () => {
    it("silently handles editMessageText errors", async () => {
      telegramClient.editMessage.mockRejectedValue(new Error("message not modified"));

      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 1 }));
      await vi.advanceTimersByTimeAsync(100);
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "test" }));
      await vi.advanceTimersByTimeAsync(1600);

      // Should not throw, relay continues operating
      expect(telegramClient.editMessage).toHaveBeenCalled();
    });
  });

  // ── Stop / cleanup ──

  describe("stop", () => {
    it("clears all timers and progress trackers", () => {
      journal._emit(makeEvent("plan.accepted", "sess-1", { step_count: 1 }));
      journal._emit(makeEvent("step.started", "sess-1", { tool_name: "test" }));

      relay.stop();

      // Internal state should be cleared
      expect(relay._progressMessages.size).toBe(0);
      expect(relay._editTimers.size).toBe(0);
    });
  });
});
