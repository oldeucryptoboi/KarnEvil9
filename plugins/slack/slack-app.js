/**
 * SlackApp — wraps @slack/bolt for Socket Mode or HTTP mode.
 */
export class SlackApp {
  /**
   * @param {object} opts
   * @param {string} opts.botToken - Slack bot token (xoxb-...)
   * @param {string} [opts.appToken] - Slack app-level token (xapp-...) for Socket Mode
   * @param {string} [opts.signingSecret] - Slack signing secret for HTTP mode
   * @param {"socket" | "http"} [opts.mode] - default: "socket"
   * @param {object} [opts.logger] - plugin logger
   */
  constructor({ botToken, appToken, signingSecret, mode = "socket", logger }) {
    this.mode = mode;
    this.logger = logger;
    this.connected = false;
    this.botUserId = null;
    this._app = null;
    this._botToken = botToken;
    this._appToken = appToken;
    this._signingSecret = signingSecret;
  }

  /**
   * Initialize the Bolt app (lazy — only called at start time).
   * @returns {Promise<void>}
   */
  async init() {
    // Dynamic import to avoid crashing when @slack/bolt is not installed
    const { App } = await import("@slack/bolt");

    const opts = {
      token: this._botToken,
      // Suppress default Bolt console logging
      logLevel: "ERROR",
    };

    if (this.mode === "socket") {
      opts.socketMode = true;
      opts.appToken = this._appToken;
    } else {
      opts.signingSecret = this._signingSecret;
    }

    this._app = new App(opts);
  }

  /**
   * Start the Slack app connection.
   * @returns {Promise<void>}
   */
  async start() {
    if (!this._app) throw new Error("SlackApp not initialized — call init() first");
    await this._app.start();
    this.connected = true;

    // Fetch bot user ID for mention stripping
    try {
      const result = await this._app.client.auth.test({ token: this._botToken });
      this.botUserId = result.user_id ?? null;
    } catch {
      this.logger?.warn("Could not fetch bot user ID");
    }
  }

  /**
   * Stop the Slack app.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._app) {
      await this._app.stop();
      this.connected = false;
    }
  }

  /**
   * Register a message event handler.
   * @param {Function} handler - (event, say) => Promise<void>
   */
  onMessage(handler) {
    if (!this._app) throw new Error("SlackApp not initialized");
    this._app.message(async ({ message, say }) => {
      try {
        await handler(message, say);
      } catch (err) {
        this.logger?.error("Message handler error", { error: err.message });
      }
    });
  }

  /**
   * Register an app_mention event handler.
   * @param {Function} handler - (event, say) => Promise<void>
   */
  onMention(handler) {
    if (!this._app) throw new Error("SlackApp not initialized");
    this._app.event("app_mention", async ({ event, say }) => {
      try {
        await handler(event, say);
      } catch (err) {
        this.logger?.error("Mention handler error", { error: err.message });
      }
    });
  }

  /**
   * Register an interactive action handler (for buttons).
   * @param {RegExp} actionPattern - regex to match action_id
   * @param {Function} handler - ({ action, body, ack, respond }) => Promise<void>
   */
  onAction(actionPattern, handler) {
    if (!this._app) throw new Error("SlackApp not initialized");
    this._app.action(actionPattern, async (args) => {
      try {
        await handler(args);
      } catch (err) {
        this.logger?.error("Action handler error", { error: err.message });
      }
    });
  }

  /**
   * Register a slash command handler.
   * @param {string} command - e.g. "/jarvis"
   * @param {Function} handler - ({ command, ack, respond }) => Promise<void>
   */
  onCommand(command, handler) {
    if (!this._app) throw new Error("SlackApp not initialized");
    this._app.command(command, async (args) => {
      try {
        await handler(args);
      } catch (err) {
        this.logger?.error("Command handler error", { error: err.message });
      }
    });
  }

  /**
   * Post a message to a channel/thread.
   * @param {object} opts
   * @param {string} opts.channel
   * @param {string} [opts.text]
   * @param {string} [opts.thread_ts]
   * @param {object[]} [opts.blocks]
   * @returns {Promise<object>}
   */
  async postMessage({ channel, text, thread_ts, blocks }) {
    if (!this._app) throw new Error("SlackApp not initialized");
    return this._app.client.chat.postMessage({
      token: this._botToken,
      channel,
      text: text ?? "",
      ...(thread_ts ? { thread_ts } : {}),
      ...(blocks ? { blocks } : {}),
    });
  }

  /**
   * Update an existing message.
   * @param {object} opts
   * @param {string} opts.channel
   * @param {string} opts.ts - message timestamp to update
   * @param {string} [opts.text]
   * @param {object[]} [opts.blocks]
   * @returns {Promise<object>}
   */
  async updateMessage({ channel, ts, text, blocks }) {
    if (!this._app) throw new Error("SlackApp not initialized");
    return this._app.client.chat.update({
      token: this._botToken,
      channel,
      ts,
      text: text ?? "",
      ...(blocks ? { blocks } : {}),
    });
  }
}
