/**
 * SlashCommand — handles /jarvis slash command.
 */
export class SlashCommand {
  /**
   * @param {object} opts
   * @param {import("./slack-app.js").SlackApp} opts.slackApp
   * @param {import("./session-bridge.js").SessionBridge} opts.sessionBridge
   * @param {object} [opts.logger]
   */
  constructor({ slackApp, sessionBridge, logger }) {
    this.slackApp = slackApp;
    this.sessionBridge = sessionBridge;
    this.logger = logger;
  }

  /**
   * Register the /jarvis command handler.
   */
  register() {
    this.slackApp.onCommand("/jarvis", async ({ command, ack, respond }) => {
      await ack();
      await this._handle(command, respond);
    });
  }

  /**
   * @param {object} command - Slack slash command payload
   * @param {Function} respond
   */
  async _handle(command, respond) {
    const text = (command.text ?? "").trim();
    const parts = text.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? "help";

    switch (subcommand) {
      case "run":
        await this._handleRun(parts.slice(1).join(" "), command, respond);
        break;
      case "status":
        await this._handleStatus(respond);
        break;
      case "cancel":
        await this._handleCancel(parts[1], respond);
        break;
      case "help":
      default:
        await this._handleHelp(respond);
        break;
    }
  }

  async _handleRun(taskText, command, respond) {
    if (!taskText) {
      await respond({ text: "Usage: `/jarvis run <task description>`", response_type: "ephemeral" });
      return;
    }

    try {
      // Post an anchor message in the channel to start a thread
      const anchor = await this.slackApp.postMessage({
        channel: command.channel_id,
        text: `:robot_face: Starting task: ${taskText}`,
      });

      const result = await this.sessionBridge.createSession({
        taskText,
        channel: command.channel_id,
        threadTs: anchor.ts,
        userId: command.user_id,
      });

      await this.slackApp.postMessage({
        channel: command.channel_id,
        thread_ts: anchor.ts,
        text: `:white_check_mark: Session \`${result.session_id}\` started`,
      });

      await respond({ text: `Session \`${result.session_id}\` started — see thread for progress`, response_type: "ephemeral" });
    } catch (err) {
      this.logger?.error("Slash command run failed", { error: err.message });
      await respond({ text: `:x: Failed to start session: ${err.message}`, response_type: "ephemeral" });
    }
  }

  async _handleStatus(respond) {
    const sessions = this.sessionBridge.listSessions();
    if (sessions.length === 0) {
      await respond({ text: "No active sessions", response_type: "ephemeral" });
      return;
    }

    const lines = sessions.map((s) => {
      const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
      return `- \`${s.sessionId}\` in <#${s.channel}> (${elapsed}s)`;
    });
    await respond({
      text: `*Active sessions (${sessions.length}):*\n${lines.join("\n")}`,
      response_type: "ephemeral",
    });
  }

  async _handleCancel(sessionId, respond) {
    if (!sessionId) {
      await respond({ text: "Usage: `/jarvis cancel <session_id>`", response_type: "ephemeral" });
      return;
    }

    const threadInfo = this.sessionBridge.getSessionThread(sessionId);
    if (!threadInfo) {
      await respond({ text: `:x: Session \`${sessionId}\` not found`, response_type: "ephemeral" });
      return;
    }

    // Remove from bridge (kernel abort is handled upstream)
    this.sessionBridge.removeSession(sessionId);
    await respond({ text: `:stop_sign: Session \`${sessionId}\` cancel requested`, response_type: "ephemeral" });
  }

  async _handleHelp(respond) {
    await respond({
      text: [
        "*Jarvis Slack Commands:*",
        "`/jarvis run <task>` — Start a new task",
        "`/jarvis status` — Show active sessions",
        "`/jarvis cancel <session_id>` — Cancel a session",
        "`/jarvis help` — Show this message",
      ].join("\n"),
      response_type: "ephemeral",
    });
  }
}
