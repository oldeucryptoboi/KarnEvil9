/**
 * ApprovalHandler — interactive Slack buttons for permission requests.
 */
import { formatApprovalRequest } from "./message-formatter.js";

export class ApprovalHandler {
  /**
   * @param {object} opts
   * @param {import("./slack-app.js").SlackApp} opts.slackApp
   * @param {string} opts.apiBaseUrl - Jarvis API base URL
   * @param {string} [opts.apiToken] - Jarvis API token
   * @param {object} [opts.logger]
   */
  constructor({ slackApp, apiBaseUrl, apiToken, logger }) {
    this.slackApp = slackApp;
    this.apiBaseUrl = apiBaseUrl;
    this.apiToken = apiToken;
    this.logger = logger;
    /** @type {Map<string, { channel: string, ts: string }>} requestId -> message info */
    this._pendingApprovals = new Map();
  }

  /**
   * Register interactive button handler with the Slack app.
   */
  registerActions() {
    this.slackApp.onAction(/^jarvis_approval_/, async ({ action, ack, respond }) => {
      await ack();
      await this._handleApprovalAction(action, respond);
    });
  }

  /**
   * Post approval buttons for a permission.requested journal event.
   * @param {object} event - journal event
   * @param {{ channel: string, threadTs: string }} threadInfo
   */
  async handlePermissionRequest(event, threadInfo) {
    const requestId = event.payload.request_id ?? event.event_id;
    const formatted = formatApprovalRequest(event.payload, requestId);

    const result = await this.slackApp.postMessage({
      channel: threadInfo.channel,
      thread_ts: threadInfo.threadTs,
      text: formatted.text,
      blocks: formatted.blocks,
    });

    this._pendingApprovals.set(requestId, {
      channel: threadInfo.channel,
      ts: result.ts,
    });
  }

  /**
   * Handle a button click on an approval message.
   * @param {object} action - Slack action payload
   * @param {Function} respond - respond function
   */
  async _handleApprovalAction(action, respond) {
    // action_id format: jarvis_approval_{requestId}_{decision}
    const parts = action.action_id.split("_");
    // "jarvis", "approval", ...requestId parts..., decision
    // Decision is the last part, requestId is everything between "approval" and decision
    const decision = parts[parts.length - 1];
    const requestId = parts.slice(2, -1).join("_");

    const validDecisions = ["allow_once", "allow_session", "deny"];
    const mappedDecision = decision === "allow" ? "allow_once" : decision;

    if (!validDecisions.includes(mappedDecision)) {
      this.logger?.warn("Unknown approval decision", { decision, requestId });
      return;
    }

    // Resolve via Jarvis API
    try {
      const url = `${this.apiBaseUrl}/api/approvals/${requestId}`;
      const headers = { "Content-Type": "application/json" };
      if (this.apiToken) {
        headers["Authorization"] = `Bearer ${this.apiToken}`;
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: mappedDecision }),
      });

      if (res.ok) {
        await respond({
          text: `:white_check_mark: Approval resolved: *${mappedDecision.replace(/_/g, " ")}*`,
          replace_original: true,
        });
      } else if (res.status === 404) {
        await respond({
          text: `:hourglass: Approval request has expired`,
          replace_original: true,
        });
      } else {
        const body = await res.text();
        this.logger?.error("Approval API error", { status: res.status, body });
        await respond({
          text: `:warning: Failed to resolve approval (HTTP ${res.status})`,
          replace_original: true,
        });
      }
    } catch (err) {
      this.logger?.error("Approval resolution failed", { error: err.message });
      await respond({
        text: `:warning: Failed to resolve approval: ${err.message}`,
        replace_original: true,
      });
    }

    this._pendingApprovals.delete(requestId);
  }
}
