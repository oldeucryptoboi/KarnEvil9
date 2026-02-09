/**
 * send-slack-message tool — allows Jarvis agents to post messages to Slack.
 */

/** @type {import("@jarvis/schemas").ToolManifest} */
export const sendSlackMessageManifest = {
  name: "send-slack-message",
  version: "1.0.0",
  description: "Send a message to a Slack channel or thread",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Slack channel ID" },
      text: { type: "string", description: "Message text" },
      thread_ts: { type: "string", description: "Thread timestamp (optional — reply in thread)" },
      blocks: {
        type: "array",
        description: "Slack Block Kit blocks (optional)",
        items: { type: "object" },
      },
    },
    required: ["channel", "text"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      ts: { type: "string" },
      channel: { type: "string" },
    },
  },
  permissions: ["slack:send:messages"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, ts: "1234567890.123456", channel: "C_MOCK" }],
};

/**
 * Create a tool handler for send-slack-message.
 * @param {import("./slack-app.js").SlackApp} slackApp
 * @returns {import("@jarvis/schemas").ToolHandler}
 */
export function createSendSlackMessageHandler(slackApp) {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { ok: true, ts: "mock-ts", channel: input.channel ?? "C_MOCK" };
    }
    if (mode === "dry_run") {
      return { ok: true, ts: "dry-run-ts", channel: input.channel, dry_run: true };
    }

    const result = await slackApp.postMessage({
      channel: input.channel,
      text: input.text,
      thread_ts: input.thread_ts,
      blocks: input.blocks,
    });

    return {
      ok: result.ok ?? true,
      ts: result.ts,
      channel: result.channel ?? input.channel,
    };
  };
}
