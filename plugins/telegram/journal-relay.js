/**
 * JournalRelay — subscribes to journal events, sends progress as Telegram messages.
 *
 * Progress events (plan, step start/succeed/fail) are consolidated into a single
 * edit-in-place message per chat. Terminal events (session complete/fail/abort)
 * and warning events are sent as separate standalone messages.
 */
import { formatJournalEvent } from "./message-formatter.js";

/** Events worth relaying to Telegram */
const RELAYED_EVENTS = new Set([
  "plan.accepted",
  "step.started",
  "step.succeeded",
  "step.failed",
  "session.completed",
  "session.failed",
  "session.aborted",
  "permission.requested",
  "futility.detected",
  "limit.exceeded",
]);

/** Progress events that get consolidated into the edit-in-place message */
const PROGRESS_EVENTS = new Set([
  "plan.accepted",
  "step.started",
  "step.succeeded",
  "step.failed",
]);

/** Terminal events sent as standalone messages */
const TERMINAL_EVENTS = new Set([
  "session.completed",
  "session.failed",
  "session.aborted",
]);

/** Warning events sent as standalone messages */
const WARNING_EVENTS = new Set([
  "futility.detected",
  "limit.exceeded",
]);

/** Debounce interval for editing the progress message (ms) */
const EDIT_DEBOUNCE_MS = 1500;

/** Max progress lines before truncation */
const MAX_PROGRESS_LINES = 10;

export class JournalRelay {
  /**
   * @param {object} opts
   * @param {object} opts.journal - Journal instance with on() method
   * @param {import("./telegram-client.js").TelegramClient} opts.telegramClient
   * @param {import("./session-bridge.js").SessionBridge} opts.sessionBridge
   * @param {import("./approval-handler.js").ApprovalHandler} opts.approvalHandler
   * @param {object} [opts.logger]
   */
  constructor({ journal, telegramClient, sessionBridge, approvalHandler, logger }) {
    this.journal = journal;
    this.telegramClient = telegramClient;
    this.sessionBridge = sessionBridge;
    this.approvalHandler = approvalHandler;
    this.logger = logger;
    this._unsubscribe = null;
    /** @type {Map<number, { messageId: number|null, lines: string[], sendPromise: Promise<void>|null }>} chatId -> progress tracker */
    this._progressMessages = new Map();
    /** @type {Map<number, ReturnType<typeof setTimeout>>} chatId -> debounce timer */
    this._editTimers = new Map();
  }

  /**
   * Start listening to journal events.
   */
  start() {
    this._unsubscribe = this.journal.on((event) => {
      void this._handleEvent(event).catch((err) => {
        this.logger?.error("Journal relay error", { error: err.message, eventType: event.type });
      });
    });
  }

  /**
   * Stop listening.
   */
  stop() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    // Clear all timers
    for (const timer of this._editTimers.values()) {
      clearTimeout(timer);
    }
    this._editTimers.clear();
    this._progressMessages.clear();
  }

  /**
   * @param {object} event
   */
  async _handleEvent(event) {
    if (!RELAYED_EVENTS.has(event.type)) return;

    const sessionId = event.session_id;
    const chatId = this.sessionBridge.getChatIdForSession(sessionId);
    if (chatId === undefined) return; // Not a Telegram-originated session

    // Delegate permission requests to approval handler
    if (event.type === "permission.requested") {
      await this.approvalHandler.handlePermissionRequest(event, chatId);
      return;
    }

    // Progress events → edit-in-place consolidated message
    if (PROGRESS_EVENTS.has(event.type)) {
      await this._appendProgress(chatId, event);
      // Deliver respond tool output as a standalone message
      if (event.type === "step.succeeded" && event.payload.output?.delivered === true && event.payload.output.text) {
        await this.telegramClient.sendMessage({ chatId, text: event.payload.output.text });
      }
      return;
    }

    // Terminal events → final flush progress, then standalone message
    if (TERMINAL_EVENTS.has(event.type)) {
      await this._finalFlush(chatId);
      const formatted = formatJournalEvent(event);
      if (formatted) {
        await this.telegramClient.sendMessage({ chatId, text: formatted });
      }
      this.sessionBridge.removeSession(sessionId);
      return;
    }

    // Warning events → standalone message
    if (WARNING_EVENTS.has(event.type)) {
      const formatted = formatJournalEvent(event);
      if (formatted) {
        await this.telegramClient.sendMessage({ chatId, text: formatted });
      }
      return;
    }
  }

  /**
   * Append a progress line and debounce-edit the message.
   * @param {number} chatId
   * @param {object} event
   */
  async _appendProgress(chatId, event) {
    const line = this._formatProgressLine(event);
    if (!line) return;

    let tracker = this._progressMessages.get(chatId);

    if (!tracker) {
      // Create tracker synchronously to prevent race conditions —
      // subsequent events that arrive before sendMessage resolves will
      // append to this tracker and schedule edits instead of sending new messages.
      tracker = { messageId: null, lines: [line], sendPromise: null };
      this._progressMessages.set(chatId, tracker);
      tracker.sendPromise = this.telegramClient.sendMessage({ chatId, text: line })
        .then((messageId) => {
          tracker.messageId = messageId;
          // If lines accumulated while we were awaiting, flush an edit now
          if (tracker.lines.length > 1) {
            this._scheduleEdit(chatId);
          }
        })
        .catch((err) => {
          this.logger?.error("Failed to send progress message", { error: err.message });
          this._progressMessages.delete(chatId);
        });
      return;
    }

    // Append line to tracker
    tracker.lines.push(line);

    // Debounce the edit (only if we have a message_id to edit)
    if (tracker.messageId) {
      this._scheduleEdit(chatId);
    }
  }

  /**
   * Schedule a debounced edit of the progress message.
   * @param {number} chatId
   */
  _scheduleEdit(chatId) {
    const existing = this._editTimers.get(chatId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._editTimers.delete(chatId);
      void this._flushEdit(chatId).catch((err) => {
        this.logger?.error("Failed to edit progress message", { error: err.message });
      });
    }, EDIT_DEBOUNCE_MS);

    this._editTimers.set(chatId, timer);
  }

  /**
   * Flush pending edits for a chat — edit the progress message with current lines.
   * @param {number} chatId
   */
  async _flushEdit(chatId) {
    const tracker = this._progressMessages.get(chatId);
    if (!tracker || !tracker.messageId) return;

    const text = this._renderProgressLines(tracker.lines);

    try {
      await this.telegramClient.editMessage({
        chatId,
        messageId: tracker.messageId,
        text,
      });
    } catch {
      // Silently handle "message not modified", stale messages, etc.
    }
  }

  /**
   * Render progress lines with truncation (first line + "..." + last N).
   * @param {string[]} lines
   * @returns {string}
   */
  _renderProgressLines(lines) {
    if (lines.length <= MAX_PROGRESS_LINES) {
      return lines.join("\n");
    }
    const first = lines[0];
    const tail = lines.slice(-(MAX_PROGRESS_LINES - 2));
    return [first, "...", ...tail].join("\n");
  }

  /**
   * Final flush: await the initial send (if still pending), edit the progress
   * message with all accumulated lines, then clear the tracker.
   * Called by terminal events so no progress lines are lost.
   * @param {number} chatId
   */
  async _finalFlush(chatId) {
    // Cancel any pending debounce timer
    const timer = this._editTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this._editTimers.delete(chatId);
    }

    const tracker = this._progressMessages.get(chatId);
    if (!tracker) return;

    // Wait for the initial sendMessage to resolve if still in flight
    if (tracker.sendPromise) {
      await tracker.sendPromise;
    }

    // Edit the progress message with all accumulated lines
    if (tracker.messageId && tracker.lines.length > 1) {
      const text = this._renderProgressLines(tracker.lines);
      try {
        await this.telegramClient.editMessage({
          chatId,
          messageId: tracker.messageId,
          text,
        });
      } catch {
        // Silently handle edit errors
      }
    }

    this._progressMessages.delete(chatId);
  }

  /**
   * Clear progress tracker and cancel pending edits for a chat.
   * @param {number} chatId
   */
  _clearProgress(chatId) {
    const timer = this._editTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this._editTimers.delete(chatId);
    }
    this._progressMessages.delete(chatId);
  }

  /**
   * Format an event into a compact progress line.
   * @param {object} event
   * @returns {string|null}
   */
  _formatProgressLine(event) {
    switch (event.type) {
      case "plan.accepted": {
        const stepCount = event.payload.step_count ?? event.payload.plan?.steps?.length ?? event.payload.steps?.length ?? "?";
        return `\uD83D\uDCCB Plan accepted \u2014 ${stepCount} step${stepCount === 1 ? "" : "s"}`;
      }
      case "step.started": {
        const tool = event.payload.tool_name ?? event.payload.tool ?? event.payload.step_id ?? "unknown";
        return `\u2699\uFE0F Running ${tool}...`;
      }
      case "step.succeeded": {
        const stepId = event.payload.step_id ?? "step";
        return `\u2705 ${stepId}`;
      }
      case "step.failed": {
        const stepId = event.payload.step_id ?? "step";
        return `\u274C ${stepId} failed`;
      }
      default:
        return null;
    }
  }
}
