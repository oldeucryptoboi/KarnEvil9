/**
 * MessageFormatter — formats journal events into Slack Block Kit messages.
 */

const MAX_TEXT_LENGTH = 4000;

function truncate(text, max = MAX_TEXT_LENGTH) {
  if (typeof text !== "string") text = JSON.stringify(text, null, 2) ?? "";
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + "\n...(truncated)";
}

/**
 * Format a journal event into Slack Block Kit blocks.
 * @param {object} event - Journal event
 * @returns {{ text: string, blocks: object[] } | null} - null if event should be skipped
 */
export function formatJournalEvent(event) {
  switch (event.type) {
    case "plan.accepted": {
      const stepCount = event.payload.step_count ?? event.payload.steps?.length ?? "?";
      return {
        text: `Plan accepted — ${stepCount} steps`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:clipboard: *Plan accepted* — ${stepCount} steps` } },
        ],
      };
    }

    case "step.started": {
      const tool = event.payload.tool_name ?? event.payload.step_id ?? "unknown";
      return {
        text: `Step started: ${tool}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:gear: Running *${tool}*` } },
        ],
      };
    }

    case "step.succeeded": {
      const stepId = event.payload.step_id ?? "step";
      const output = event.payload.output;
      const outputText = output ? truncate(typeof output === "string" ? output : JSON.stringify(output, null, 2)) : "";
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: `:white_check_mark: *${stepId}* succeeded` } },
      ];
      if (outputText) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: "```\n" + truncate(outputText, 2900) + "\n```" } });
      }
      return { text: `Step ${stepId} succeeded`, blocks };
    }

    case "step.failed": {
      const stepId = event.payload.step_id ?? "step";
      const err = event.payload.error;
      const errMsg = err ? `${err.code ?? "ERROR"}: ${err.message ?? "unknown"}` : "unknown error";
      return {
        text: `Step ${stepId} failed: ${errMsg}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:x: *${stepId}* failed — ${truncate(errMsg, 2900)}` } },
        ],
      };
    }

    case "session.completed":
      return {
        text: "Session completed",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:tada: *Session completed*` } },
        ],
      };

    case "session.failed": {
      const reason = event.payload.error ?? event.payload.reason ?? "unknown";
      return {
        text: `Session failed: ${reason}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:rotating_light: *Session failed* — ${truncate(String(reason), 2900)}` } },
        ],
      };
    }

    case "session.aborted": {
      const reason = event.payload.reason ?? "user requested";
      return {
        text: `Session aborted: ${reason}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:stop_sign: *Session aborted* — ${reason}` } },
        ],
      };
    }

    case "futility.detected":
      return {
        text: "Futility detected — session may be stuck",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:warning: *Futility detected* — the session appears stuck` } },
        ],
      };

    case "limit.exceeded": {
      const limit = event.payload.limit ?? "unknown";
      return {
        text: `Limit exceeded: ${limit}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:no_entry: *Limit exceeded* — ${limit}` } },
        ],
      };
    }

    default:
      return null;
  }
}

/**
 * Format a permission request into Slack Block Kit with approval buttons.
 * @param {object} request - Permission request
 * @param {string} requestId - Unique request ID
 * @returns {{ text: string, blocks: object[] }}
 */
export function formatApprovalRequest(request, requestId) {
  const scopes = request.permissions?.map((p) => p.scope).join(", ") ?? "unknown";
  return {
    text: `Permission requested: ${request.tool_name} (${scopes})`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:lock: *Permission requested*\n*Tool:* ${request.tool_name}\n*Step:* ${request.step_id}\n*Scopes:* ${scopes}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Allow Once" },
            style: "primary",
            action_id: `jarvis_approval_${requestId}_allow_once`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Allow Session" },
            action_id: `jarvis_approval_${requestId}_allow_session`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
            action_id: `jarvis_approval_${requestId}_deny`,
          },
        ],
      },
    ],
  };
}
