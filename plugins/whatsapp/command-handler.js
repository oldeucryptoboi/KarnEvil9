/**
 * CommandHandler — handles text commands sent via WhatsApp DMs.
 * Commands: status, cancel [id], help
 */
export class CommandHandler {
  /**
   * @param {object} opts
   * @param {import("./whatsapp-client.js").WhatsAppClient} opts.whatsappClient
   * @param {import("./session-bridge.js").SessionBridge} opts.sessionBridge
   * @param {object} [opts.logger]
   */
  constructor({ whatsappClient, sessionBridge, logger }) {
    this.whatsappClient = whatsappClient;
    this.sessionBridge = sessionBridge;
    this.logger = logger;
  }

  /**
   * Check if a message text is a recognized command.
   * @param {string} text
   * @returns {boolean}
   */
  isCommand(text) {
    const cmd = text.trim().toLowerCase().split(/\s+/)[0];
    return cmd === "status" || cmd === "cancel" || cmd === "help";
  }

  /**
   * Handle a command message.
   * @param {string} sender - WhatsApp JID
   * @param {string} text - full message text
   * @returns {Promise<void>}
   */
  async handle(sender, text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "status":
        await this._handleStatus(sender);
        break;
      case "cancel":
        await this._handleCancel(sender, parts[1]);
        break;
      case "help":
        await this._handleHelp(sender);
        break;
    }
  }

  async _handleStatus(sender) {
    const sessions = this.sessionBridge.listSessions();
    if (sessions.length === 0) {
      await this.whatsappClient.sendMessage({ jid: sender, message: "No active sessions." });
      return;
    }

    const lines = sessions.map((s) => {
      const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
      return `\u2022 ${s.sessionId} (${elapsed}s)`;
    });
    await this.whatsappClient.sendMessage({
      jid: sender,
      message: `*Active sessions* (${sessions.length}):\n${lines.join("\n")}`,
    });
  }

  async _handleCancel(sender, sessionId) {
    if (!sessionId) {
      // Cancel the sender's own active session
      const activeSessionId = this.sessionBridge.getSessionIdForSender(sender);
      if (!activeSessionId) {
        await this.whatsappClient.sendMessage({ jid: sender, message: "No active session to cancel." });
        return;
      }
      sessionId = activeSessionId;
    }

    const info = this.sessionBridge.getSessionInfo(sessionId);
    if (!info) {
      await this.whatsappClient.sendMessage({ jid: sender, message: `\u274C Session ${sessionId} not found.` });
      return;
    }

    this.sessionBridge.removeSession(sessionId);
    await this.whatsappClient.sendMessage({
      jid: sender,
      message: `\uD83D\uDED1 Session ${sessionId} cancel requested.`,
    });
  }

  async _handleHelp(sender) {
    await this.whatsappClient.sendMessage({
      jid: sender,
      message: [
        "*KarnEvil9 WhatsApp Commands:*",
        "",
        "\u2022 Send any message \u2014 Start a new task",
        "\u2022 status \u2014 Show active sessions",
        "\u2022 cancel [id] \u2014 Cancel a session",
        "\u2022 help \u2014 Show this message",
        "",
        "During approval requests, reply with:",
        "  1 = Allow once",
        "  2 = Allow session",
        "  3 = Deny",
      ].join("\n"),
    });
  }
}
