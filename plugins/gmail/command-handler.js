/**
 * CommandHandler — handles text commands sent via Gmail.
 * Commands: status, cancel [id], help
 */
export class CommandHandler {
  /**
   * @param {object} opts
   * @param {import("./gmail-client.js").GmailClient} opts.gmailClient
   * @param {import("./session-bridge.js").SessionBridge} opts.sessionBridge
   * @param {object} [opts.logger]
   */
  constructor({ gmailClient, sessionBridge, logger }) {
    this.gmailClient = gmailClient;
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
   * @param {string} sender - email address
   * @param {string} text - full message text
   * @param {{ threadId?: string, subject?: string }} [context] - reply context
   * @returns {Promise<void>}
   */
  async handle(sender, text, context = {}) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "status":
        await this._handleStatus(sender, context);
        break;
      case "cancel":
        await this._handleCancel(sender, parts[1], context);
        break;
      case "help":
        await this._handleHelp(sender, context);
        break;
    }
  }

  async _handleStatus(sender, context) {
    const sessions = this.sessionBridge.listSessions();
    if (sessions.length === 0) {
      await this.gmailClient.sendReply({
        to: sender,
        subject: context.subject ?? "Re: KarnEvil9 Status",
        body: "No active sessions.",
        threadId: context.threadId,
      });
      return;
    }

    const lines = sessions.map((s) => {
      const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
      return `\u2022 ${s.sessionId} (${elapsed}s)`;
    });
    await this.gmailClient.sendReply({
      to: sender,
      subject: context.subject ?? "Re: KarnEvil9 Status",
      body: `Active sessions (${sessions.length}):\n${lines.join("\n")}`,
      threadId: context.threadId,
    });
  }

  async _handleCancel(sender, sessionId, context) {
    if (!sessionId) {
      // Cancel the sender's own active session
      const activeSessionId = this.sessionBridge.getSessionIdForSender(sender);
      if (!activeSessionId) {
        await this.gmailClient.sendReply({
          to: sender,
          subject: context.subject ?? "Re: KarnEvil9",
          body: "No active session to cancel.",
          threadId: context.threadId,
        });
        return;
      }
      sessionId = activeSessionId;
    }

    const info = this.sessionBridge.getSessionInfo(sessionId);
    if (!info) {
      await this.gmailClient.sendReply({
        to: sender,
        subject: context.subject ?? "Re: KarnEvil9",
        body: `\u274C Session ${sessionId} not found.`,
        threadId: context.threadId,
      });
      return;
    }

    this.sessionBridge.removeSession(sessionId);
    await this.gmailClient.sendReply({
      to: sender,
      subject: context.subject ?? "Re: KarnEvil9",
      body: `\uD83D\uDED1 Session ${sessionId} cancel requested.`,
      threadId: context.threadId,
    });
  }

  async _handleHelp(sender, context) {
    const body = [
      "KarnEvil9 Gmail Commands:",
      "",
      "\u2022 Send any email \u2014 Start a new task",
      "\u2022 status \u2014 Show active sessions",
      "\u2022 cancel [id] \u2014 Cancel a session",
      "\u2022 help \u2014 Show this message",
      "",
      "During approval requests, reply with:",
      "  1 = Allow once",
      "  2 = Allow session",
      "  3 = Deny",
    ].join("\n");

    const html = [
      `<h3>KarnEvil9 Gmail Commands</h3>`,
      `<ul>`,
      `<li><strong>Send any email</strong> \u2014 Start a new task</li>`,
      `<li><strong>status</strong> \u2014 Show active sessions</li>`,
      `<li><strong>cancel [id]</strong> \u2014 Cancel a session</li>`,
      `<li><strong>help</strong> \u2014 Show this message</li>`,
      `</ul>`,
      `<p>During approval requests, reply with:</p>`,
      `<p style="padding-left:16px;"><strong>1</strong> = Allow once<br/><strong>2</strong> = Allow session<br/><strong>3</strong> = Deny</p>`,
    ].join("\n");

    await this.gmailClient.sendReply({
      to: sender,
      subject: context.subject ?? "Re: KarnEvil9 Help",
      body,
      html,
      threadId: context.threadId,
    });
  }
}
