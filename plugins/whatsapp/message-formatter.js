/**
 * MessageFormatter — formats journal events as plain text for WhatsApp.
 * WhatsApp natively supports *bold*, _italic_, ~strikethrough~, and ```monospace```.
 */

const MAX_TEXT_LENGTH = 4000;

function truncate(text, max = MAX_TEXT_LENGTH) {
  if (typeof text !== "string") text = JSON.stringify(text, null, 2) ?? "";
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + "\n...(truncated)";
}

/**
 * Format a journal event into plain text for WhatsApp.
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
 * Format a permission request as a numbered text menu for WhatsApp.
 * @param {object} request - Permission request
 * @param {string} requestId - Unique request ID
 * @returns {string}
 */
export function formatApprovalRequest(request, requestId) {
  const scopes = request.permissions?.map((p) => p.scope).join(", ") ?? "unknown";
  return [
    `\uD83D\uDD12 *Permission requested*`,
    `*Tool:* ${request.tool_name}`,
    `*Step:* ${request.step_id}`,
    `*Scopes:* ${scopes}`,
    ``,
    `Reply with:`,
    `  1 = Allow once`,
    `  2 = Allow session`,
    `  3 = Deny`,
  ].join("\n");
}
