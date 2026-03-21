/**
 * CommandHandler — handles text commands sent via Telegram DMs.
 * Commands: status, cancel [id], help
 * Recognizes both "/status" (Telegram slash convention) and "status" (plain text).
 */
export class CommandHandler {
  /**
   * @param {object} opts
   * @param {import("./telegram-client.js").TelegramClient} opts.telegramClient
   * @param {import("./session-bridge.js").SessionBridge} opts.sessionBridge
   * @param {object} [opts.logger]
   */
  constructor({ telegramClient, sessionBridge, logger }) {
    this.telegramClient = telegramClient;
    this.sessionBridge = sessionBridge;
    this.logger = logger;
  }

  /**
   * Check if a message text is a recognized command.
   * Supports both "/command" and "command" forms.
   * @param {string} text
   * @returns {boolean}
   */
  isCommand(text) {
    const cmd = text.trim().toLowerCase().replace(/^\//, "").split(/\s+/)[0];
    return cmd === "status" || cmd === "cancel" || cmd === "help" || cmd === "start";
  }

  /**
   * Handle a command message.
   * @param {number} chatId - Telegram chat ID
   * @param {string} text - full message text
   * @returns {Promise<void>}
   */
  async handle(chatId, text) {
    const parts = text.trim().replace(/^\//, "").split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "status":
        await this._handleStatus(chatId);
        break;
      case "cancel":
        await this._handleCancel(chatId, parts[1]);
        break;
      case "help":
      case "start":
        await this._handleHelp(chatId);
        break;
    }
  }

  async _handleStatus(chatId) {
    const sessions = this.sessionBridge.listSessions();
    if (sessions.length === 0) {
      await this.telegramClient.sendMessage({ chatId, text: "No active sessions." });
      return;
    }

    const lines = sessions.map((s) => {
      const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
      return `\u2022 ${s.sessionId} (${elapsed}s)`;
    });
    await this.telegramClient.sendMessage({
      chatId,
      text: `Active sessions (${sessions.length}):\n${lines.join("\n")}`,
    });
  }

  async _handleCancel(chatId, sessionId) {
    if (!sessionId) {
      // Cancel the chat's own active session
      const activeSessionId = this.sessionBridge.getSessionIdForChat(chatId);
      if (!activeSessionId) {
        await this.telegramClient.sendMessage({ chatId, text: "No active session to cancel." });
        return;
      }
      sessionId = activeSessionId;
    }

    const info = this.sessionBridge.getSessionInfo(sessionId);
    if (!info) {
      await this.telegramClient.sendMessage({ chatId, text: `\u274C Session ${sessionId} not found.` });
      return;
    }

    this.sessionBridge.removeSession(sessionId);
    await this.telegramClient.sendMessage({
      chatId,
      text: `\u{1F6D1} Session ${sessionId} cancel requested.`,
    });
  }

  async _handleHelp(chatId) {
    await this.telegramClient.sendMessage({
      chatId,
      text: [
        "KarnEvil9 Telegram Commands:",
        "",
        "\u2022 Send any message \u2014 Start a new task",
        "\u2022 /status \u2014 Show active sessions",
        "\u2022 /cancel [id] \u2014 Cancel a session",
        "\u2022 /help \u2014 Show this message",
        "",
        "During approval requests, reply with:",
        "  1 = Allow once",
        "  2 = Allow session",
        "  3 = Deny",
      ].join("\n"),
    });
  }
}
