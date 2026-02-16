/**
 * ApprovalHandler — text-based numbered menu for permission requests via Gmail.
 */
import { formatApprovalRequest } from "./message-formatter.js";

const APPROVAL_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export class ApprovalHandler {
  /**
   * @param {object} opts
   * @param {import("./gmail-client.js").GmailClient} opts.gmailClient
   * @param {string} opts.apiBaseUrl - KarnEvil9 API base URL
   * @param {string} [opts.apiToken] - KarnEvil9 API token
   * @param {object} [opts.logger]
   */
  constructor({ gmailClient, apiBaseUrl, apiToken, logger }) {
    this.gmailClient = gmailClient;
    this.apiBaseUrl = apiBaseUrl;
    this.apiToken = apiToken;
    this.logger = logger;
    /** @type {Map<string, { requestId: string, threadId: string | null, subject: string, timer: ReturnType<typeof setTimeout> }>} sender -> pending approval */
    this._pendingApprovals = new Map();
  }

  /**
   * Check if a sender has a pending approval and the text is a valid reply (1/2/3).
   * @param {string} sender - email address
   * @param {string} text - message text
   * @returns {boolean}
   */
  isPendingReply(sender, text) {
    if (!this._pendingApprovals.has(sender.toLowerCase())) return false;
    const trimmed = text.trim();
    return trimmed === "1" || trimmed === "2" || trimmed === "3";
  }

  /**
   * Handle a reply to a pending approval.
   * @param {string} sender
   * @param {string} text - "1", "2", or "3"
   * @returns {Promise<void>}
   */
  async handleReply(sender, text) {
    const senderLower = sender.toLowerCase();
    const pending = this._pendingApprovals.get(senderLower);
    if (!pending) return;

    const choice = text.trim();
    const decisionMap = { "1": "allow_once", "2": "allow_session", "3": "deny" };
    const decision = decisionMap[choice];
    if (!decision) return;

    clearTimeout(pending.timer);
    this._pendingApprovals.delete(senderLower);

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
        await this.gmailClient.sendReply({
          to: sender,
          subject: pending.subject ? `Re: ${pending.subject}` : "Re: KarnEvil9 Approval",
          body: `\u2705 Approval resolved: ${label}`,
          threadId: pending.threadId,
        });
      } else if (res.status === 404) {
        await this.gmailClient.sendReply({
          to: sender,
          subject: pending.subject ? `Re: ${pending.subject}` : "Re: KarnEvil9 Approval",
          body: `\u231B Approval request has expired`,
          threadId: pending.threadId,
        });
      } else {
        const body = await res.text();
        this.logger?.error("Approval API error", { status: res.status, body });
        await this.gmailClient.sendReply({
          to: sender,
          subject: pending.subject ? `Re: ${pending.subject}` : "Re: KarnEvil9 Approval",
          body: `\u26A0\uFE0F Failed to resolve approval (HTTP ${res.status})`,
          threadId: pending.threadId,
        });
      }
    } catch (err) {
      this.logger?.error("Approval resolution failed", { error: err.message });
      await this.gmailClient.sendReply({
        to: sender,
        subject: pending.subject ? `Re: ${pending.subject}` : "Re: KarnEvil9 Approval",
        body: `\u26A0\uFE0F Failed to resolve approval: ${err.message}`,
        threadId: pending.threadId,
      });
    }
  }

  /**
   * Send approval request to a sender as a numbered menu via email.
   * @param {object} event - journal event
   * @param {string} sender - email address
   * @param {{ threadId?: string, subject?: string }} [context] - reply context
   */
  async handlePermissionRequest(event, sender, context = {}) {
    const senderLower = sender.toLowerCase();
    const requestId = event.payload.request_id ?? event.event_id;
    const { text, html } = formatApprovalRequest(event.payload, requestId);

    // Clear any previous pending approval for this sender
    const existing = this._pendingApprovals.get(senderLower);
    if (existing) {
      clearTimeout(existing.timer);
    }

    // Auto-expire after 5 minutes
    const timer = setTimeout(() => {
      if (this._pendingApprovals.has(senderLower)) {
        this._pendingApprovals.delete(senderLower);
        this.gmailClient.sendReply({
          to: sender,
          subject: context.subject ? `Re: ${context.subject}` : "Re: KarnEvil9 Approval",
          body: `\u231B Approval request expired (${requestId})`,
          threadId: context.threadId,
        }).catch(() => {});
      }
    }, APPROVAL_EXPIRY_MS);

    this._pendingApprovals.set(senderLower, {
      requestId,
      threadId: context.threadId ?? null,
      subject: context.subject ?? "",
      timer,
    });

    await this.gmailClient.sendReply({
      to: sender,
      subject: context.subject ? `Re: ${context.subject}` : "KarnEvil9 \u2014 Permission Request",
      body: text,
      html,
      threadId: context.threadId,
    });
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
