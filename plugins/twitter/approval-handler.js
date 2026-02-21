/**
 * ApprovalHandler — text-based numbered menu for permission requests via Twitter DM.
 */
import { formatApprovalRequest } from "./message-formatter.js";

const APPROVAL_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export class ApprovalHandler {
  /**
   * @param {object} opts
   * @param {import("./twitter-client.js").TwitterClient} opts.twitterClient
   * @param {string} opts.apiBaseUrl - KarnEvil9 API base URL
   * @param {string} [opts.apiToken] - KarnEvil9 API token
   * @param {object} [opts.logger]
   */
  constructor({ twitterClient, apiBaseUrl, apiToken, logger }) {
    this.twitterClient = twitterClient;
    this.apiBaseUrl = apiBaseUrl;
    this.apiToken = apiToken;
    this.logger = logger;
    /** @type {Map<string, { requestId: string, timer: ReturnType<typeof setTimeout> }>} senderId -> pending approval */
    this._pendingApprovals = new Map();
  }

  /**
   * Check if a sender has a pending approval and the text is a valid reply (1/2/3).
   * @param {string} senderId - Twitter user ID
   * @param {string} text - message text
   * @returns {boolean}
   */
  isPendingReply(senderId, text) {
    if (!this._pendingApprovals.has(senderId)) return false;
    const trimmed = text.trim();
    return trimmed === "1" || trimmed === "2" || trimmed === "3";
  }

  /**
   * Handle a reply to a pending approval.
   * @param {string} senderId
   * @param {string} text - "1", "2", or "3"
   * @returns {Promise<void>}
   */
  async handleReply(senderId, text) {
    const pending = this._pendingApprovals.get(senderId);
    if (!pending) return;

    const choice = text.trim();
    const decisionMap = { "1": "allow_once", "2": "allow_session", "3": "deny" };
    const decision = decisionMap[choice];
    if (!decision) return;

    clearTimeout(pending.timer);
    this._pendingApprovals.delete(senderId);

    // Resolve via KarnEvil9 API
    try {
      const url = `${this.apiBaseUrl}/api/approvals/${pending.requestId}`;
      const headers = { "Content-Type": "application/json" };
      if (this.apiToken) {
        headers["Authorization"] = `Bearer ${this.apiToken}`;
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ decision }),
      });

      if (res.ok) {
        const label = decision.replace(/_/g, " ");
        await this.twitterClient.sendDm({
          recipientId: senderId,
          text: `\u2705 Approval resolved: ${label}`,
        });
      } else if (res.status === 404) {
        await this.twitterClient.sendDm({
          recipientId: senderId,
          text: `\u231B Approval request has expired`,
        });
      } else {
        const body = await res.text();
        this.logger?.error("Approval API error", { status: res.status, body });
        await this.twitterClient.sendDm({
          recipientId: senderId,
          text: `\u26A0\uFE0F Failed to resolve approval (HTTP ${res.status})`,
        });
      }
    } catch (err) {
      this.logger?.error("Approval resolution failed", { error: err.message });
      await this.twitterClient.sendDm({
        recipientId: senderId,
        text: `\u26A0\uFE0F Failed to resolve approval: ${err.message}`,
      });
    }
  }

  /**
   * Send approval request to a sender as a numbered menu.
   * @param {object} event - journal event
   * @param {string} senderId - Twitter user ID
   */
  async handlePermissionRequest(event, senderId) {
    const requestId = event.payload.request_id ?? event.event_id;
    const formatted = formatApprovalRequest(event.payload, requestId);

    // Clear any previous pending approval for this sender
    const existing = this._pendingApprovals.get(senderId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    // Auto-expire after 5 minutes
    const timer = setTimeout(() => {
      if (this._pendingApprovals.has(senderId)) {
        this._pendingApprovals.delete(senderId);
        this.twitterClient.sendDm({
          recipientId: senderId,
          text: `\u231B Approval request expired (${requestId})`,
        }).catch(() => {});
      }
    }, APPROVAL_EXPIRY_MS);

    this._pendingApprovals.set(senderId, { requestId, timer });

    await this.twitterClient.sendDm({ recipientId: senderId, text: formatted });
  }

  /**
   * Clean up all pending approvals.
   */
  dispose() {
    for (const [, pending] of this._pendingApprovals) {
      clearTimeout(pending.timer);
    }
    this._pendingApprovals.clear();
  }
}
