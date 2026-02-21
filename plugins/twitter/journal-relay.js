/**
 * JournalRelay — subscribes to journal events, sends progress as Twitter DMs.
 */
import { formatJournalEvent } from "./message-formatter.js";

/** Events worth relaying to Twitter DMs */
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

/** Throttle interval for step events per sender (ms) */
const STEP_THROTTLE_MS = 3000;

export class JournalRelay {
  /**
   * @param {object} opts
   * @param {object} opts.journal - Journal instance with on() method
   * @param {import("./twitter-client.js").TwitterClient} opts.twitterClient
   * @param {import("./session-bridge.js").SessionBridge} opts.sessionBridge
   * @param {import("./approval-handler.js").ApprovalHandler} opts.approvalHandler
   * @param {object} [opts.logger]
   */
  constructor({ journal, twitterClient, sessionBridge, approvalHandler, logger }) {
    this.journal = journal;
    this.twitterClient = twitterClient;
    this.sessionBridge = sessionBridge;
    this.approvalHandler = approvalHandler;
    this.logger = logger;
    this._unsubscribe = null;
    /** @type {Map<string, number>} senderId -> last step post timestamp */
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
    const senderId = this.sessionBridge.getSenderForSession(sessionId);
    if (!senderId) return; // Not a Twitter-originated session

    // Delegate permission requests to approval handler
    if (event.type === "permission.requested") {
      await this.approvalHandler.handlePermissionRequest(event, senderId);
      return;
    }

    // Throttle step events to avoid flooding
    if (event.type === "step.started" || event.type === "step.succeeded" || event.type === "step.failed") {
      const now = Date.now();
      const lastPost = this._lastStepPost.get(senderId) ?? 0;
      if (now - lastPost < STEP_THROTTLE_MS) return;
      this._lastStepPost.set(senderId, now);
    }

    const formatted = formatJournalEvent(event);
    if (!formatted) return;

    await this.twitterClient.sendDm({ recipientId: senderId, text: formatted });

    // Clean up on session end
    if (event.type === "session.completed" || event.type === "session.failed" || event.type === "session.aborted") {
      this.sessionBridge.removeSession(sessionId);
      this._lastStepPost.delete(senderId);
    }
  }
}
