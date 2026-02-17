/**
 * ApprovalHandler — text-based numbered menu for permission requests via WhatsApp.
 */
import { formatApprovalRequest } from "./message-formatter.js";

const APPROVAL_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export class ApprovalHandler {
  /**
   * @param {object} opts
   * @param {import("./whatsapp-client.js").WhatsAppClient} opts.whatsappClient
   * @param {string} opts.apiBaseUrl - KarnEvil9 API base URL
   * @param {string} [opts.apiToken] - KarnEvil9 API token
   * @param {object} [opts.logger]
   */
  constructor({ whatsappClient, apiBaseUrl, apiToken, logger }) {
    this.whatsappClient = whatsappClient;
    this.apiBaseUrl = apiBaseUrl;
    this.apiToken = apiToken;
    this.logger = logger;
    /** @type {Map<string, { requestId: string, timer: ReturnType<typeof setTimeout> }>} sender -> pending approval */
    this._pendingApprovals = new Map();
  }

  /**
   * Check if a sender has a pending approval and the text is a valid reply (1/2/3).
   * @param {string} sender - WhatsApp JID
   * @param {string} text - message text
   * @returns {boolean}
   */
  isPendingReply(sender, text) {
    if (!this._pendingApprovals.has(sender)) return false;
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
    const pending = this._pendingApprovals.get(sender);
    if (!pending) return;

    const choice = text.trim();
    const decisionMap = { "1": "allow_once", "2": "allow_session", "3": "deny" };
    const decision = decisionMap[choice];
    if (!decision) return;

    clearTimeout(pending.timer);
    this._pendingApprovals.delete(sender);

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
        await this.whatsappClient.sendMessage({
          jid: sender,
          message: `\u2705 Approval resolved: ${label}`,
        });
      } else if (res.status === 404) {
        await this.whatsappClient.sendMessage({
          jid: sender,
          message: `\u231B Approval request has expired`,
        });
      } else {
        const body = await res.text();
        this.logger?.error("Approval API error", { status: res.status, body });
        await this.whatsappClient.sendMessage({
          jid: sender,
          message: `\u26A0\uFE0F Failed to resolve approval (HTTP ${res.status})`,
        });
      }
    } catch (err) {
      this.logger?.error("Approval resolution failed", { error: err.message });
      await this.whatsappClient.sendMessage({
        jid: sender,
        message: `\u26A0\uFE0F Failed to resolve approval: ${err.message}`,
      });
    }
  }

  /**
   * Send approval request to a sender as a numbered menu.
   * @param {object} event - journal event
   * @param {string} sender - WhatsApp JID
   */
  async handlePermissionRequest(event, sender) {
    const requestId = event.payload.request_id ?? event.event_id;
    const formatted = formatApprovalRequest(event.payload, requestId);

    // Clear any previous pending approval for this sender
    const existing = this._pendingApprovals.get(sender);
    if (existing) {
      clearTimeout(existing.timer);
    }

    // Auto-expire after 5 minutes
    const timer = setTimeout(() => {
      if (this._pendingApprovals.has(sender)) {
        this._pendingApprovals.delete(sender);
        this.whatsappClient.sendMessage({
          jid: sender,
          message: `\u231B Approval request expired (${requestId})`,
        }).catch(() => {});
      }
    }, APPROVAL_EXPIRY_MS);

    this._pendingApprovals.set(sender, { requestId, timer });

    await this.whatsappClient.sendMessage({ jid: sender, message: formatted });
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
