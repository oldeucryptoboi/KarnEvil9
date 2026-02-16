/**
 * GmailClient — wraps googleapis + @google-cloud/pubsub for Gmail send/receive.
 *
 * Flow:
 *   1. gmail.users.watch() registers Pub/Sub push for new emails
 *   2. Pub/Sub PULL subscription receives notifications (no public URL needed)
 *   3. Notification contains { emailAddress, historyId }
 *   4. history.list(startHistoryId) gets new message IDs
 *   5. messages.get(messageId) fetches full email content
 *   6. Reply via messages.send() with same threadId for in-thread replies
 *   7. Watch auto-renews every 24 hours (expires after 7 days)
 */

const WATCH_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class GmailClient {
  /**
   * @param {object} opts
   * @param {string} opts.clientId - OAuth2 client ID
   * @param {string} opts.clientSecret - OAuth2 client secret
   * @param {string} opts.refreshToken - OAuth2 refresh token
   * @param {string} opts.pubsubProjectId - Google Cloud project ID
   * @param {string} opts.pubsubTopic - Pub/Sub topic (e.g. projects/{id}/topics/karnevil9-gmail)
   * @param {string} opts.pubsubSubscription - Pub/Sub subscription name
   * @param {string} [opts.labelFilter] - Label IDs to watch (default: "INBOX")
   * @param {object} [opts.logger]
   */
  constructor({
    clientId,
    clientSecret,
    refreshToken,
    pubsubProjectId,
    pubsubTopic,
    pubsubSubscription,
    labelFilter = "INBOX",
    logger,
  }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.pubsubProjectId = pubsubProjectId;
    this.pubsubTopic = pubsubTopic;
    this.pubsubSubscription = pubsubSubscription;
    this.labelFilter = labelFilter.split(",").map((l) => l.trim()).filter(Boolean);
    this.logger = logger;

    this.connected = false;
    this._gmail = null;
    this._auth = null;
    this._subscription = null;
    this._messageHandlers = [];
    this._watchTimer = null;
    this._lastHistoryId = null;
    this._myEmail = null;
    this._stopping = false;
  }

  /**
   * Register a message handler.
   * @param {(message: { sender: string, text: string, subject: string, threadId: string, messageId: string }) => Promise<void>} handler
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /**
   * Start the Gmail client: authenticate, set up watch, start Pub/Sub pull.
   * @returns {Promise<void>}
   */
  async start() {
    this._stopping = false;

    // Dynamic imports — googleapis and @google-cloud/pubsub are root deps
    const { google } = await import("googleapis");
    const { PubSub } = await import("@google-cloud/pubsub");

    // Set up OAuth2
    this._auth = new google.auth.OAuth2(this.clientId, this.clientSecret);
    this._auth.setCredentials({ refresh_token: this.refreshToken });
    this._gmail = google.gmail({ version: "v1", auth: this._auth });

    // Get our own email address
    const profile = await this._gmail.users.getProfile({ userId: "me" });
    this._myEmail = profile.data.emailAddress;
    this.logger?.info("Gmail authenticated", { email: this._myEmail });

    // Set up Gmail watch
    await this._setupWatch();

    // Set up Pub/Sub pull subscription
    const pubsub = new PubSub({ projectId: this.pubsubProjectId });
    this._subscription = pubsub.subscription(this.pubsubSubscription);

    this._subscription.on("message", (message) => {
      void this._handlePubSubMessage(message).catch((err) => {
        this.logger?.error("Pub/Sub message handling error", { error: err.message });
      });
    });

    this._subscription.on("error", (err) => {
      this.logger?.error("Pub/Sub subscription error", { error: err.message });
    });

    // Auto-renew watch every 24 hours
    this._watchTimer = setInterval(() => {
      this._setupWatch().catch((err) => {
        this.logger?.error("Watch renewal failed", { error: err.message });
      });
    }, WATCH_RENEWAL_INTERVAL_MS);

    this.connected = true;
    this.logger?.info("Gmail client started", { email: this._myEmail, topic: this.pubsubTopic });
  }

  /**
   * Stop the Gmail client.
   * @returns {Promise<void>}
   */
  async stop() {
    this._stopping = true;
    this.connected = false;

    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }

    if (this._subscription) {
      this._subscription.removeAllListeners();
      await this._subscription.close().catch(() => {});
      this._subscription = null;
    }

    // Stop Gmail watch
    if (this._gmail) {
      try {
        await this._gmail.users.stop({ userId: "me" });
      } catch {
        // Best effort
      }
    }

    this._gmail = null;
    this._auth = null;
  }

  /**
   * Set up Gmail watch on the inbox.
   * @returns {Promise<void>}
   */
  async _setupWatch() {
    const res = await this._gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: this.pubsubTopic,
        labelIds: this.labelFilter,
      },
    });
    this._lastHistoryId = res.data.historyId;
    this.logger?.info("Gmail watch registered", { historyId: this._lastHistoryId, expiration: res.data.expiration });
  }

  /**
   * Handle a Pub/Sub notification message.
   * @param {object} message - Pub/Sub message
   */
  async _handlePubSubMessage(message) {
    // Always ack to prevent redelivery
    message.ack();

    if (this._stopping) return;

    let data;
    try {
      data = JSON.parse(Buffer.from(message.data, "base64").toString());
    } catch {
      this.logger?.error("Failed to parse Pub/Sub message data");
      return;
    }

    const { historyId } = data;
    if (!historyId) return;

    // Fetch new messages since last known historyId
    try {
      await this._processHistory(historyId);
    } catch (err) {
      if (err.code === 404) {
        // History ID expired — restart watch
        this.logger?.warn("History ID expired, restarting watch");
        await this._setupWatch();
      } else {
        throw err;
      }
    }
  }

  /**
   * Process history changes since the last known historyId.
   * @param {string} notifiedHistoryId
   */
  async _processHistory(notifiedHistoryId) {
    if (!this._lastHistoryId) return;

    const res = await this._gmail.users.history.list({
      userId: "me",
      startHistoryId: this._lastHistoryId,
      historyTypes: ["messageAdded"],
      labelId: this.labelFilter[0] ?? "INBOX",
    });

    // Update history ID for next call
    this._lastHistoryId = notifiedHistoryId;

    const histories = res.data.history;
    if (!histories || histories.length === 0) return;

    // Collect unique new message IDs
    const messageIds = new Set();
    for (const history of histories) {
      if (history.messagesAdded) {
        for (const added of history.messagesAdded) {
          if (added.message?.id) {
            messageIds.add(added.message.id);
          }
        }
      }
    }

    // Fetch and process each new message
    for (const msgId of messageIds) {
      try {
        await this._fetchAndProcessMessage(msgId);
      } catch (err) {
        this.logger?.error("Failed to process message", { messageId: msgId, error: err.message });
      }
    }
  }

  /**
   * Fetch a full message and dispatch to handlers.
   * @param {string} messageId
   */
  async _fetchAndProcessMessage(messageId) {
    const res = await this._gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const msg = res.data;
    const headers = msg.payload?.headers ?? [];

    const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
    const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
    const threadId = msg.threadId;

    // Extract sender email from "Name <email>" format
    const sender = extractEmail(from);
    if (!sender) return;

    // Skip our own sent messages
    if (sender.toLowerCase() === this._myEmail?.toLowerCase()) return;

    // Extract body text
    const body = extractBody(msg.payload);
    if (!body) return;

    // Extract just the new reply text (strip quoted content)
    const text = extractReplyText(body);
    if (!text.trim()) return;

    const parsed = { sender, text, subject, threadId, messageId };

    for (const handler of this._messageHandlers) {
      handler(parsed).catch((err) => {
        this.logger?.error("Gmail message handler error", { error: err.message });
      });
    }
  }

  /**
   * Send a reply in an existing thread.
   * @param {object} opts
   * @param {string} opts.to - Recipient email
   * @param {string} opts.subject - Email subject
   * @param {string} opts.body - Plain text body
   * @param {string} [opts.html] - Optional HTML body
   * @param {string} [opts.threadId] - Gmail threadId for in-thread reply
   * @returns {Promise<{ messageId: string }>}
   */
  async sendReply({ to, subject, body, html, threadId }) {
    return this.sendMessage({ to, subject, body, html, threadId });
  }

  /**
   * Send an email message.
   * @param {object} opts
   * @param {string} opts.to - Recipient email
   * @param {string} opts.subject - Email subject
   * @param {string} opts.body - Plain text body
   * @param {string} [opts.html] - Optional HTML body
   * @param {string} [opts.threadId] - Optional threadId
   * @returns {Promise<{ messageId: string }>}
   */
  async sendMessage({ to, subject, body, html, threadId }) {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const mimeLines = [
      `From: me`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
    ];

    if (html) {
      mimeLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, ``);
      mimeLines.push(`--${boundary}`);
      mimeLines.push(`Content-Type: text/plain; charset="UTF-8"`, ``);
      mimeLines.push(body, ``);
      mimeLines.push(`--${boundary}`);
      mimeLines.push(`Content-Type: text/html; charset="UTF-8"`, ``);
      mimeLines.push(html, ``);
      mimeLines.push(`--${boundary}--`);
    } else {
      mimeLines.push(`Content-Type: text/plain; charset="UTF-8"`, ``);
      mimeLines.push(body);
    }

    const raw = Buffer.from(mimeLines.join("\r\n")).toString("base64url");

    const sendOpts = {
      userId: "me",
      requestBody: { raw },
    };

    if (threadId) {
      sendOpts.requestBody.threadId = threadId;
    }

    const res = await this._gmail.users.messages.send(sendOpts);
    return { messageId: res.data.id };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract email address from "Name <email>" or bare "email" format.
 * @param {string} from
 * @returns {string | null}
 */
function extractEmail(from) {
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1];
  // Bare email
  if (from.includes("@")) return from.trim();
  return null;
}

/**
 * Extract plain text body from a Gmail message payload.
 * Prefers text/plain, falls back to text/html with tag stripping.
 * @param {object} payload
 * @returns {string}
 */
function extractBody(payload) {
  if (!payload) return "";

  // Simple single-part message
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Multipart — look for text/plain first
  if (payload.parts) {
    const plainPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plainPart?.body?.data) {
      return Buffer.from(plainPart.body.data, "base64url").toString("utf-8");
    }

    // Fall back to text/html
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
      return stripHtml(html);
    }

    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  // Single-part HTML fallback
  if (payload.mimeType === "text/html" && payload.body?.data) {
    const html = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    return stripHtml(html);
  }

  return "";
}

/**
 * Strip HTML tags and decode entities.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract only the new reply text from an email body, stripping quoted content.
 * Email reply chains contain quoted text that we don't want to process.
 * @param {string} body
 * @returns {string}
 */
export function extractReplyText(body) {
  const lines = body.split("\n");
  const result = [];

  for (const line of lines) {
    // Stop at "On DATE, NAME <email> wrote:" pattern
    if (/^On .+wrote:\s*$/i.test(line)) break;

    // Stop at signature markers
    if (/^--\s*$/.test(line)) break;

    // Stop at common mobile signatures
    if (/^Sent from my (iPhone|iPad|Galaxy|Android|Samsung)/i.test(line)) break;
    if (/^Get Outlook for/i.test(line)) break;

    // Skip lines beginning with > (standard quoting)
    if (/^>/.test(line)) continue;

    result.push(line);
  }

  return result.join("\n").trim();
}
