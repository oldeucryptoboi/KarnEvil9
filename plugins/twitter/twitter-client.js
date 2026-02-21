/**
 * TwitterClient — wraps Twitter API v2 for DM polling, tweet posting, and DM sending.
 *
 * Uses OAuth 1.0a HMAC-SHA1 signing via built-in node:crypto.
 * Zero external dependencies.
 */
import { createHmac, randomBytes } from "node:crypto";

const API_BASE = "https://api.x.com/2";
const MAX_DM_LENGTH = 10000;
const CHUNK_DELAY_MS = 500;

export class TwitterClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey - Twitter API key (consumer key)
   * @param {string} opts.apiSecret - Twitter API secret (consumer secret)
   * @param {string} opts.accessToken - User access token
   * @param {string} opts.accessTokenSecret - User access token secret
   * @param {number} [opts.pollIntervalMs] - DM polling interval (default: 15000)
   * @param {object} [opts.logger] - Plugin logger
   */
  constructor({ apiKey, apiSecret, accessToken, accessTokenSecret, pollIntervalMs = 15000, logger } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.accessToken = accessToken;
    this.accessTokenSecret = accessTokenSecret;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.connected = false;
    this._messageHandlers = [];
    this._pollTimer = null;
    this._stopping = false;
    this._seenDmIds = new Set();
    this._paginationToken = null;
    this._myUserId = null;
  }

  /**
   * Register a DM message handler.
   * @param {(message: { senderId: string, senderUsername: string, text: string, dmConversationId: string }) => Promise<void>} handler
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /**
   * Start the Twitter client — verify credentials and begin DM polling.
   * @returns {Promise<void>}
   */
  async start() {
    this._stopping = false;

    // Verify credentials
    const me = await this.getMe();
    this._myUserId = me.id;
    this.connected = true;
    this.logger?.info("Twitter connected", { userId: me.id, username: me.username });

    // Start DM polling
    this._schedulePoll();
  }

  /**
   * Stop DM polling.
   * @returns {Promise<void>}
   */
  async stop() {
    this._stopping = true;
    this.connected = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Get authenticated user info.
   * @returns {Promise<{ id: string, username: string, name: string }>}
   */
  async getMe() {
    const res = await this._apiRequest("GET", "/users/me");
    if (!res.data) {
      throw new Error(`Twitter API /users/me failed: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  /**
   * Post a tweet.
   * @param {string} text - Tweet text (max 280 chars)
   * @returns {Promise<{ id: string, text: string }>}
   */
  async postTweet(text) {
    if (text.length > 280) {
      throw new Error(`Tweet exceeds 280 character limit (${text.length} chars)`);
    }
    const res = await this._apiRequest("POST", "/tweets", { text });
    if (!res.data) {
      throw new Error(`Twitter API /tweets failed: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  /**
   * Send a DM to a user.
   * @param {object} opts
   * @param {string} opts.recipientId - Twitter user ID
   * @param {string} opts.text - Message text (max 10K chars)
   * @returns {Promise<{ dm_event_id: string }>}
   */
  async sendDm({ recipientId, text }) {
    if (text.length > MAX_DM_LENGTH) {
      throw new Error(`DM exceeds ${MAX_DM_LENGTH} character limit (${text.length} chars)`);
    }
    const res = await this._apiRequest(
      "POST",
      `/dm_conversations/with/${recipientId}/messages`,
      { text }
    );
    if (!res.data) {
      throw new Error(`Twitter API DM send failed: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  /**
   * Send a long DM, splitting into chunks if needed.
   * @param {object} opts
   * @param {string} opts.recipientId - Twitter user ID
   * @param {string} opts.text - Message text (may exceed limit)
   * @returns {Promise<void>}
   */
  async sendLongDm({ recipientId, text }) {
    if (text.length <= MAX_DM_LENGTH) {
      await this.sendDm({ recipientId, text });
      return;
    }

    const chunks = splitMessage(text, MAX_DM_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = `[${i + 1}/${chunks.length}] `;
      await this.sendDm({ recipientId, text: prefix + chunks[i] });
      if (i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }
  }

  // ── OAuth 1.0a Signing ──

  /**
   * Generate OAuth 1.0a Authorization header.
   * @param {string} method - HTTP method
   * @param {string} url - Full URL
   * @param {object} [params] - Query/body params (for signature base)
   * @returns {string} - Authorization header value
   */
  _sign(method, url, params = {}) {
    const oauthParams = {
      oauth_consumer_key: this.apiKey,
      oauth_nonce: randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: this.accessToken,
      oauth_version: "1.0",
    };

    // Combine all params for signature base string
    const allParams = { ...params, ...oauthParams };
    const sortedKeys = Object.keys(allParams).sort();
    const paramString = sortedKeys
      .map((k) => `${percentEncode(k)}=${percentEncode(String(allParams[k]))}`)
      .join("&");

    const signatureBase = [
      method.toUpperCase(),
      percentEncode(url),
      percentEncode(paramString),
    ].join("&");

    const signingKey = `${percentEncode(this.apiSecret)}&${percentEncode(this.accessTokenSecret)}`;
    const signature = createHmac("sha1", signingKey)
      .update(signatureBase)
      .digest("base64");

    oauthParams.oauth_signature = signature;

    const authHeader = "OAuth " + Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(", ");

    return authHeader;
  }

  /**
   * Make an authenticated API request.
   * @param {string} method - HTTP method
   * @param {string} path - API path (e.g. "/tweets")
   * @param {object} [body] - JSON body (for POST)
   * @param {object} [queryParams] - URL query parameters
   * @returns {Promise<object>}
   */
  async _apiRequest(method, path, body = null, queryParams = {}) {
    let url = `${API_BASE}${path}`;

    // Build query string
    const queryEntries = Object.entries(queryParams).filter(([, v]) => v != null);
    if (queryEntries.length > 0) {
      const qs = queryEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      url += `?${qs}`;
    }

    // For OAuth signature, use base URL without query params for POST with JSON body,
    // but include query params for GET requests
    const signatureUrl = `${API_BASE}${path}`;
    const signatureParams = method === "GET" ? { ...queryParams } : {};

    const authHeader = this._sign(method, signatureUrl, signatureParams);

    const headers = {
      Authorization: authHeader,
    };

    const fetchOpts = { method, headers };

    if (body) {
      headers["Content-Type"] = "application/json";
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOpts);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twitter API ${method} ${path} failed (${res.status}): ${text}`);
    }

    // Some endpoints return 204 No Content
    if (res.status === 204) return {};

    return await res.json();
  }

  // ── DM Polling ──

  /**
   * Schedule the next DM poll.
   */
  _schedulePoll() {
    if (this._stopping) return;
    this._pollTimer = setTimeout(async () => {
      try {
        await this._pollDMs();
      } catch (err) {
        this.logger?.error("Twitter DM poll error", { error: err.message });
      }
      this._schedulePoll();
    }, this.pollIntervalMs);
  }

  /**
   * Poll for new DMs.
   */
  async _pollDMs() {
    const queryParams = {
      event_types: "MessageCreate",
      "dm_event.fields": "dm_conversation_id,sender_id,text,created_at",
    };
    if (this._paginationToken) {
      queryParams.pagination_token = this._paginationToken;
    }

    const res = await this._apiRequest("GET", "/dm_events", null, queryParams);

    // Update pagination token for next poll
    if (res.meta?.next_token) {
      this._paginationToken = res.meta.next_token;
    }

    if (!res.data || res.data.length === 0) return;

    for (const event of res.data) {
      // Skip own messages
      if (event.sender_id === this._myUserId) continue;

      // Deduplicate
      if (this._seenDmIds.has(event.id)) continue;
      this._seenDmIds.add(event.id);

      // Cap seen IDs to prevent unbounded growth
      if (this._seenDmIds.size > 10000) {
        const idsArray = [...this._seenDmIds];
        this._seenDmIds = new Set(idsArray.slice(-5000));
      }

      const text = event.text ?? "";
      if (!text) continue;

      const parsed = {
        senderId: event.sender_id,
        senderUsername: event.sender_id, // Username not available in DM events
        text,
        dmConversationId: event.dm_conversation_id,
      };

      for (const handler of this._messageHandlers) {
        handler(parsed).catch((err) => {
          this.logger?.error("Twitter DM handler error", { error: err.message });
        });
      }
    }
  }
}

/**
 * RFC 3986 percent-encode.
 * @param {string} str
 * @returns {string}
 */
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
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
