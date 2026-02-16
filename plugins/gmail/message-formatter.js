/**
 * MessageFormatter — formats journal events as plain text + HTML for Gmail.
 * Dual-format output: plain text for simple clients, HTML with inline styles for rich display.
 */

const MAX_TEXT_LENGTH = 4000;

function truncate(text, max = MAX_TEXT_LENGTH) {
  if (typeof text !== "string") text = JSON.stringify(text, null, 2) ?? "";
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + "\n...(truncated)";
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format a journal event into plain text for Gmail.
 * @param {object} event - Journal event
 * @returns {string | null} - null if event should be skipped
 */
export function formatJournalEvent(event) {
  switch (event.type) {
    case "plan.accepted": {
      const stepCount = event.payload.step_count ?? event.payload.steps?.length ?? "?";
      return `\uD83D\uDCCB Plan accepted \u2014 ${stepCount} steps`;
    }

    case "step.started": {
      const tool = event.payload.tool_name ?? event.payload.step_id ?? "unknown";
      return `\u2699\uFE0F Running ${tool}`;
    }

    case "step.succeeded": {
      const stepId = event.payload.step_id ?? "step";
      const output = event.payload.output;
      let text = `\u2705 ${stepId} succeeded`;
      if (output) {
        const outputText = typeof output === "string" ? output : JSON.stringify(output, null, 2);
        text += `\n\n${truncate(outputText, 2900)}`;
      }
      return text;
    }

    case "step.failed": {
      const stepId = event.payload.step_id ?? "step";
      const err = event.payload.error;
      const errMsg = err ? `${err.code ?? "ERROR"}: ${err.message ?? "unknown"}` : "unknown error";
      return `\u274C ${stepId} failed \u2014 ${truncate(errMsg, 2900)}`;
    }

    case "session.completed":
      return `\uD83C\uDF89 Session completed`;

    case "session.failed": {
      const reason = event.payload.error ?? event.payload.reason ?? "unknown";
      return `\uD83D\uDEA8 Session failed \u2014 ${truncate(String(reason), 2900)}`;
    }

    case "session.aborted": {
      const reason = event.payload.reason ?? "user requested";
      return `\uD83D\uDED1 Session aborted \u2014 ${reason}`;
    }

    case "futility.detected":
      return `\u26A0\uFE0F Futility detected \u2014 the session appears stuck`;

    case "limit.exceeded": {
      const limit = event.payload.limit ?? "unknown";
      return `\u26D4 Limit exceeded \u2014 ${limit}`;
    }

    default:
      return null;
  }
}

/**
 * Format a journal event into HTML for Gmail.
 * @param {object} event - Journal event
 * @returns {string | null}
 */
export function formatJournalEventHtml(event) {
  const plain = formatJournalEvent(event);
  if (!plain) return null;

  switch (event.type) {
    case "step.succeeded": {
      const stepId = event.payload.step_id ?? "step";
      const output = event.payload.output;
      let html = `<p style="color:#2e7d32;font-weight:bold;">\u2705 ${escapeHtml(stepId)} succeeded</p>`;
      if (output) {
        const outputText = typeof output === "string" ? output : JSON.stringify(output, null, 2);
        html += `<pre style="background:#f5f5f5;padding:8px;border-radius:4px;overflow-x:auto;font-size:12px;">${escapeHtml(truncate(outputText, 2900))}</pre>`;
      }
      return html;
    }

    case "step.failed": {
      const stepId = event.payload.step_id ?? "step";
      const err = event.payload.error;
      const errMsg = err ? `${err.code ?? "ERROR"}: ${err.message ?? "unknown"}` : "unknown error";
      return `<p style="color:#c62828;font-weight:bold;">\u274C ${escapeHtml(stepId)} failed</p><pre style="background:#fff3f3;padding:8px;border-radius:4px;font-size:12px;">${escapeHtml(truncate(errMsg, 2900))}</pre>`;
    }

    case "session.completed":
      return `<p style="color:#2e7d32;font-weight:bold;">\uD83C\uDF89 Session completed</p>`;

    case "session.failed": {
      const reason = event.payload.error ?? event.payload.reason ?? "unknown";
      return `<p style="color:#c62828;font-weight:bold;">\uD83D\uDEA8 Session failed \u2014 ${escapeHtml(truncate(String(reason), 2900))}</p>`;
    }

    default:
      return `<p>${escapeHtml(plain)}</p>`;
  }
}

/**
 * Format a permission request as a numbered text menu for email.
 * @param {object} request - Permission request
 * @param {string} requestId - Unique request ID
 * @returns {{ text: string, html: string }}
 */
export function formatApprovalRequest(request, requestId) {
  const scopes = request.permissions?.map((p) => p.scope).join(", ") ?? "unknown";

  const text = [
    `\uD83D\uDD12 Permission requested`,
    `Tool: ${request.tool_name}`,
    `Step: ${request.step_id}`,
    `Scopes: ${scopes}`,
    ``,
    `Reply with:`,
    `  1 = Allow once`,
    `  2 = Allow session`,
    `  3 = Deny`,
  ].join("\n");

  const html = [
    `<div style="border:1px solid #e0e0e0;padding:12px;border-radius:8px;max-width:500px;">`,
    `<p style="font-weight:bold;margin:0 0 8px 0;">\uD83D\uDD12 Permission requested</p>`,
    `<table style="border-collapse:collapse;margin-bottom:8px;">`,
    `<tr><td style="padding:2px 8px 2px 0;font-weight:bold;">Tool:</td><td>${escapeHtml(request.tool_name)}</td></tr>`,
    `<tr><td style="padding:2px 8px 2px 0;font-weight:bold;">Step:</td><td>${escapeHtml(request.step_id)}</td></tr>`,
    `<tr><td style="padding:2px 8px 2px 0;font-weight:bold;">Scopes:</td><td>${escapeHtml(scopes)}</td></tr>`,
    `</table>`,
    `<p style="margin:8px 0 4px 0;">Reply with:</p>`,
    `<p style="margin:0;padding-left:16px;"><strong>1</strong> = Allow once<br/><strong>2</strong> = Allow session<br/><strong>3</strong> = Deny</p>`,
    `</div>`,
  ].join("\n");

  return { text, html };
}
