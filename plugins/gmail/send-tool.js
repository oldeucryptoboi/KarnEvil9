/**
 * send-gmail-message tool — allows KarnEvil9 agents to send messages via Gmail.
 */

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const sendGmailMessageManifest = {
  name: "send-gmail-message",
  version: "1.0.0",
  description: "Send an email via Gmail",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject line" },
      body: { type: "string", description: "Plain text email body" },
      html: { type: "string", description: "Optional HTML email body" },
      threadId: { type: "string", description: "Optional Gmail threadId to reply in-thread" },
    },
    required: ["to", "subject", "body"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      to: { type: "string" },
      messageId: { type: "string" },
    },
  },
  permissions: ["gmail:send:messages"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, to: "user@example.com", messageId: "mock-id" }],
};

/**
 * Create a tool handler for send-gmail-message.
 * @param {import("./gmail-client.js").GmailClient} gmailClient
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createSendGmailMessageHandler(gmailClient) {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { ok: true, to: input.to ?? "mock@example.com", messageId: "mock-id" };
    }
    if (mode === "dry_run") {
      return { ok: true, to: input.to, messageId: "dry-run-id", dry_run: true };
    }

    const result = await gmailClient.sendMessage({
      to: input.to,
      subject: input.subject,
      body: input.body,
      html: input.html,
      threadId: input.threadId,
    });

    return {
      ok: true,
      to: input.to,
      messageId: result.messageId,
    };
  };
}
