/**
 * CommandHandler — handles text commands sent via Twitter DMs.
 * Commands: status, cancel [id], help
 */
export class CommandHandler {
  /**
   * @param {object} opts
   * @param {import("./twitter-client.js").TwitterClient} opts.twitterClient
   * @param {import("./session-bridge.js").SessionBridge} opts.sessionBridge
   * @param {object} [opts.logger]
   */
  constructor({ twitterClient, sessionBridge, logger }) {
    this.twitterClient = twitterClient;
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
   * @param {string} senderId - Twitter user ID
   * @param {string} text - full message text
   * @returns {Promise<void>}
   */
  async handle(senderId, text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "status":
        await this._handleStatus(senderId);
        break;
      case "cancel":
        await this._handleCancel(senderId, parts[1]);
        break;
      case "help":
        await this._handleHelp(senderId);
        break;
    }
  }

  async _handleStatus(senderId) {
    const sessions = this.sessionBridge.listSessions();
    if (sessions.length === 0) {
      await this.twitterClient.sendDm({ recipientId: senderId, text: "No active sessions." });
      return;
    }

    const lines = sessions.map((s) => {
      const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
      return `\u2022 ${s.sessionId} (${elapsed}s)`;
    });
    await this.twitterClient.sendDm({
      recipientId: senderId,
      text: `Active sessions (${sessions.length}):\n${lines.join("\n")}`,
    });
  }

  async _handleCancel(senderId, sessionId) {
    if (!sessionId) {
      // Cancel the sender's own active session
      const activeSessionId = this.sessionBridge.getSessionIdForSender(senderId);
      if (!activeSessionId) {
        await this.twitterClient.sendDm({ recipientId: senderId, text: "No active session to cancel." });
        return;
      }
      sessionId = activeSessionId;
    }

    const info = this.sessionBridge.getSessionInfo(sessionId);
    if (!info) {
      await this.twitterClient.sendDm({ recipientId: senderId, text: `\u274C Session ${sessionId} not found.` });
      return;
    }

    this.sessionBridge.removeSession(sessionId);
    await this.twitterClient.sendDm({
      recipientId: senderId,
      text: `\uD83D\uDED1 Session ${sessionId} cancel requested.`,
    });
  }

  async _handleHelp(senderId) {
    await this.twitterClient.sendDm({
      recipientId: senderId,
      text: [
        "KarnEvil9 Twitter Commands:",
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
