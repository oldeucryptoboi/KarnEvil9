/**
 * TelegramClient — wraps grammY Bot for message send/receive via long polling.
 */

const MAX_MESSAGE_LENGTH = 4000;
const CHUNK_DELAY_MS = 500;

export class TelegramClient {
  /**
   * @param {object} opts
   * @param {string} opts.token - Telegram Bot API token from BotFather
   * @param {object} [opts.logger] - plugin logger
   */
  constructor({ token, logger }) {
    this.token = token;
    this.logger = logger;
    this.connected = false;
    this._bot = null;
    this._messageHandlers = [];
  }

  /**
   * Register a message handler.
   * @param {(message: { chatId: number, userId: number, text: string, timestamp: number }) => Promise<void>} handler
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /**
   * Start receiving messages via long polling.
   * Sets up bot command menu (best-effort).
   * @returns {Promise<void>}
   */
  async start() {
    const { Bot } = await import("grammy");
    this._bot = new Bot(this.token);

    // Register bot command menu (best-effort, don't block startup)
    try {
      await this._bot.api.setMyCommands([
        { command: "status", description: "Show active sessions" },
        { command: "cancel", description: "Cancel current session" },
        { command: "help", description: "Show available commands" },
      ]);
    } catch (err) {
      this.logger?.warn("Failed to set bot commands", { error: err.message });
    }

    this._bot.on("message:text", async (ctx) => {
      const msg = {
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        text: ctx.message.text,
        timestamp: ctx.message.date * 1000, // Telegram uses seconds
      };

      for (const handler of this._messageHandlers) {
        handler(msg).catch((err) => {
          this.logger?.error("Telegram message handler error", { error: err.message });
        });
      }
    });

    this._bot.catch((err) => {
      this.logger?.error("Telegram bot error", { error: err.message });
    });

    // Start long polling (non-blocking)
    this._bot.start();
    this.connected = true;
  }

  /**
   * Stop receiving messages.
   * @returns {Promise<void>}
   */
  async stop() {
    this.connected = false;
    if (this._bot) {
      await this._bot.stop();
      this._bot = null;
    }
  }

  /**
   * Send a message to a chat.
   * @param {object} opts
   * @param {number} opts.chatId - Telegram chat ID
   * @param {string} opts.text - Message text
   * @param {string} [opts.parseMode] - Optional parse mode ("HTML" | "MarkdownV2")
   * @returns {Promise<number>} message_id of the sent message
   */
  async sendMessage({ chatId, text, parseMode }) {
    if (!this._bot) throw new Error("Telegram bot not started");
    const opts = parseMode ? { parse_mode: parseMode } : {};
    const result = await this._bot.api.sendMessage(chatId, text, opts);
    return result.message_id;
  }

  /**
   * Edit an existing message.
   * @param {object} opts
   * @param {number} opts.chatId - Telegram chat ID
   * @param {number} opts.messageId - ID of the message to edit
   * @param {string} opts.text - New text content
   * @param {string} [opts.parseMode] - Optional parse mode
   * @returns {Promise<void>}
   */
  async editMessage({ chatId, messageId, text, parseMode }) {
    if (!this._bot) throw new Error("Telegram bot not started");
    const opts = parseMode ? { parse_mode: parseMode } : {};
    await this._bot.api.editMessageText(chatId, messageId, text, opts);
  }

  /**
   * Send a long message, splitting into chunks if needed.
   * @param {object} opts
   * @param {number} opts.chatId - Telegram chat ID
   * @param {string} opts.text - Message text (may exceed limit)
   * @param {string} [opts.parseMode] - Optional parse mode
   * @returns {Promise<void>}
   */
  async sendLongMessage({ chatId, text, parseMode }) {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await this.sendMessage({ chatId, text, parseMode });
      return;
    }

    const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = `[${i + 1}/${chunks.length}] `;
      await this.sendMessage({ chatId, text: prefix + chunks[i], parseMode });
      if (i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }
  }

  /**
   * Send a typing indicator (best-effort).
   * @param {number} chatId - Telegram chat ID
   * @returns {Promise<void>}
   */
  async sendTyping(chatId) {
    if (!this._bot) return;
    try {
      await this._bot.api.sendChatAction(chatId, "typing");
    } catch {
      // Typing indicator is best-effort
    }
  }
}

/**
 * Split a long message into chunks at paragraph > line > hard boundaries.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitMessage(text, maxLen) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = -1;

    const paraIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (paraIdx > maxLen * 0.3) {
      splitAt = paraIdx + 2;
    }

    if (splitAt === -1) {
      const lineIdx = remaining.lastIndexOf("\n", maxLen);
      if (lineIdx > maxLen * 0.3) {
        splitAt = lineIdx + 1;
      }
    }

    if (splitAt === -1) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
