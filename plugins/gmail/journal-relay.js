/**
 * JournalRelay — subscribes to journal events, sends progress as Gmail replies in-thread.
 */
import { formatJournalEvent, formatJournalEventHtml } from "./message-formatter.js";

/** Events worth relaying to Gmail */
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

/** Throttle interval for step events per sender (ms) — higher than Signal (emails are noisier) */
const STEP_THROTTLE_MS = 10000;

export class JournalRelay {
  /**
   * @param {object} opts
   * @param {object} opts.journal - Journal instance with on() method
   * @param {import("./gmail-client.js").GmailClient} opts.gmailClient
   * @param {import("./session-bridge.js").SessionBridge} opts.sessionBridge
   * @param {import("./approval-handler.js").ApprovalHandler} opts.approvalHandler
   * @param {object} [opts.logger]
   */
  constructor({ journal, gmailClient, sessionBridge, approvalHandler, logger }) {
    this.journal = journal;
    this.gmailClient = gmailClient;
    this.sessionBridge = sessionBridge;
    this.approvalHandler = approvalHandler;
    this.logger = logger;
    this._unsubscribe = null;
    /** @type {Map<string, number>} sender -> last step post timestamp */
    this._lastStepPost = new Map();
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
    this._lastStepPost.clear();
  }

  /**
   * @param {object} event
   */
  async _handleEvent(event) {
    if (!RELAYED_EVENTS.has(event.type)) return;

    const sessionId = event.session_id;
    const sender = this.sessionBridge.getSenderForSession(sessionId);
    if (!sender) return; // Not a Gmail-originated session

    const threadId = this.sessionBridge.getThreadIdForSession(sessionId);
    const subject = this.sessionBridge.getSubjectForSession(sessionId);

    // Delegate permission requests to approval handler
    if (event.type === "permission.requested") {
      await this.approvalHandler.handlePermissionRequest(event, sender, { threadId, subject });
      return;
    }

    // Throttle step events to avoid flooding
    if (event.type === "step.started" || event.type === "step.succeeded" || event.type === "step.failed") {
      const now = Date.now();
      const lastPost = this._lastStepPost.get(sender) ?? 0;
      if (now - lastPost < STEP_THROTTLE_MS) return;
      this._lastStepPost.set(sender, now);
    }

    const formatted = formatJournalEvent(event);
    if (!formatted) return;

    const html = formatJournalEventHtml(event);

    await this.gmailClient.sendReply({
      to: sender,
      subject: subject ? `Re: ${subject}` : "Re: KarnEvil9 Task",
      body: formatted,
      html: html ?? undefined,
      threadId,
    });

    // Clean up on session end
    if (event.type === "session.completed" || event.type === "session.failed" || event.type === "session.aborted") {
      this.sessionBridge.removeSession(sessionId);
      this._lastStepPost.delete(sender);
    }
  }
}
