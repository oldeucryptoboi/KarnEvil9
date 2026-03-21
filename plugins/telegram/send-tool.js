/**
 * send-telegram-message tool — allows KarnEvil9 agents to send messages via Telegram.
 */

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const sendTelegramMessageManifest = {
  name: "send-telegram-message",
  version: "1.0.0",
  description: "Send a message to a Telegram chat",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      chat_id: { type: "number", description: "Telegram chat ID" },
      text: { type: "string", description: "Message text" },
      parse_mode: { type: "string", description: "Optional parse mode (HTML or MarkdownV2)", enum: ["HTML", "MarkdownV2"] },
    },
    required: ["chat_id", "text"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      chat_id: { type: "number" },
    },
  },
  permissions: ["telegram:send:messages"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, chat_id: 123456789 }],
};

/**
 * Create a tool handler for send-telegram-message.
 * @param {import("./telegram-client.js").TelegramClient} telegramClient
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createSendTelegramMessageHandler(telegramClient) {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { ok: true, chat_id: input.chat_id ?? 0 };
    }
    if (mode === "dry_run") {
      return { ok: true, chat_id: input.chat_id, dry_run: true };
    }

    await telegramClient.sendLongMessage({
      chatId: input.chat_id,
      text: input.text,
      parseMode: input.parse_mode,
    });

    return {
      ok: true,
      chat_id: input.chat_id,
    };
  };
}
