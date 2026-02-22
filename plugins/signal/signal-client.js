/**
 * SignalClient — wraps signal-cli for message send/receive.
 *
 * Modes:
 *   - "native"    — calls signal-cli binary directly via subprocess (default)
 *   - "polling"   — polls signal-cli-rest-api HTTP endpoint
 *   - "websocket" — WebSocket to signal-cli-rest-api
 */
import { spawn, execFile } from "node:child_process";

const MAX_MESSAGE_LENGTH = 5500;
const CHUNK_DELAY_MS = 500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class SignalClient {
  /**
   * @param {object} opts
   * @param {string} opts.phoneNumber - Registered Signal number in E.164 format
   * @param {string} [opts.apiUrl] - signal-cli-rest-api base URL (for polling/websocket modes)
   * @param {"native" | "polling" | "websocket"} [opts.mode] - default: "native"
   * @param {number} [opts.pollIntervalMs] - polling/native receive interval (default: 2000)
   * @param {string} [opts.signalCliBin] - path to signal-cli binary (default: "signal-cli")
   * @param {object} [opts.logger] - plugin logger
   */
  constructor({ phoneNumber, apiUrl, mode = "native", pollIntervalMs = 2000, signalCliBin = "signal-cli", logger }) {
    this.phoneNumber = phoneNumber;
    this.apiUrl = apiUrl?.replace(/\/$/, "");
    this.mode = mode;
    this.pollIntervalMs = pollIntervalMs;
    this.signalCliBin = signalCliBin;
    this.logger = logger;
    this.connected = false;
    this._ws = null;
    this._pollTimer = null;
    this._nativeProcess = null;
    this._messageHandlers = [];
    this._reconnectAttempt = 0;
    this._stopping = false;
  }

  /**
   * Register a message handler.
   * @param {(message: { sender: string, text: string, timestamp: number }) => Promise<void>} handler
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /**
   * Start receiving messages.
   * @returns {Promise<void>}
   */
  async start() {
    this._stopping = false;
    if (this.mode === "native") {
      this._startNativeReceive();
    } else if (this.mode === "websocket") {
      await this._connectWebSocket();
    } else {
      this._startPolling();
    }
    this.connected = true;
  }

  /**
   * Stop receiving messages.
   * @returns {Promise<void>}
   */
  async stop() {
    this._stopping = true;
    this.connected = false;
    if (this._nativeProcess) {
      this._nativeProcess.kill();
      this._nativeProcess = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Send a message to a recipient.
   * @param {object} opts
   * @param {string} opts.recipient - E.164 phone number
   * @param {string} opts.message - Message text
   * @returns {Promise<void>}
   */
  async sendMessage({ recipient, message }) {
    if (this.mode === "native") {
      return this._nativeSend(recipient, message);
    }
    const url = `${this.apiUrl}/v2/send`;
    const body = {
      message,
      number: this.phoneNumber,
      recipients: [recipient],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Signal send failed (HTTP ${res.status}): ${text}`);
    }
  }

  /**
   * Send a message via native signal-cli binary.
   * @param {string} recipient
   * @param {string} message
   * @returns {Promise<void>}
   */
  _nativeSend(recipient, message) {
    return new Promise((resolve, reject) => {
      execFile(this.signalCliBin, [
        "-a", this.phoneNumber,
        "send", "-m", message, recipient,
      ], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`signal-cli send failed: ${stderr || err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Send a long message, splitting into chunks if needed.
   * @param {object} opts
   * @param {string} opts.recipient - E.164 phone number
   * @param {string} opts.message - Message text (may exceed limit)
   * @returns {Promise<void>}
   */
  async sendLongMessage({ recipient, message }) {
    if (message.length <= MAX_MESSAGE_LENGTH) {
      await this.sendMessage({ recipient, message });
      return;
    }

    const chunks = splitMessage(message, MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = `[${i + 1}/${chunks.length}] `;
      await this.sendMessage({ recipient, message: prefix + chunks[i] });
      if (i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }
  }

  /**
   * Send a typing indicator (best-effort, native mode is a no-op).
   * @param {string} recipient - E.164 phone number
   * @returns {Promise<void>}
   */
  async sendTyping(recipient) {
    if (this.mode === "native") return; // signal-cli doesn't support typing indicators easily
    try {
      const url = `${this.apiUrl}/v1/typing-indicator/${this.phoneNumber}`;
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient }),
      });
    } catch {
      // Typing indicator is best-effort
    }
  }

  // ── Native mode: signal-cli receive via JSON subprocess ──

  /**
   * Start receiving via `signal-cli receive --json` in a loop.
   */
  _startNativeReceive() {
    this.connected = true;
    this._nativePoll();
  }

  /**
   * Poll for messages using signal-cli receive --json --timeout 1.
   */
  _nativePoll() {
    if (this._stopping) return;

    const child = spawn(this.signalCliBin, [
      "-a", this.phoneNumber,
      "--output=json",
      "receive",
      "--timeout", "5",
    ]);
    this._nativeProcess = child;

    child.on("error", (err) => {
      this.logger?.error("signal-cli spawn error — disabling native receive", { error: err.message });
      this._nativeProcess = null;
      this.connected = false;
      this._stopping = true; // Stop the retry loop — binary is missing
    });

    let buffer = "";
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const envelope = JSON.parse(line);
          this.logger?.info("Signal native received envelope");
          this._processNativeEnvelope(envelope);
        } catch (err) {
          this.logger?.error("Failed to parse signal-cli JSON", { error: err.message, line: line.slice(0, 200) });
        }
      }
    });

    child.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes("INFO")) {
        this.logger?.error("signal-cli stderr", { message: msg });
      }
    });

    child.on("close", () => {
      this._nativeProcess = null;
      if (!this._stopping) {
        // Schedule next poll
        setTimeout(() => this._nativePoll(), this.pollIntervalMs);
      }
    });
  }

  /**
   * Process a native signal-cli JSON envelope.
   * @param {object} envelope
   */
  _processNativeEnvelope(envelope) {
    // Native signal-cli JSON format:
    // Direct message: { "envelope": { "source": "+1...", "dataMessage": { "message": "..." } } }
    // Sync (Note to Self / linked device): { "envelope": { "source": "+1...", "syncMessage": { "sentMessage": { "message": "...", "destination": "+1..." } } } }
    const env = envelope.envelope;
    if (!env) return;

    let sender = env.source ?? env.sourceNumber;
    let text = null;
    let timestamp = null;

    // Try dataMessage first (direct incoming DM)
    if (env.dataMessage?.message) {
      text = env.dataMessage.message;
      timestamp = env.dataMessage.timestamp;
    }
    // Try syncMessage.sentMessage (Note to Self or linked device sync)
    else if (env.syncMessage?.sentMessage?.message) {
      text = env.syncMessage.sentMessage.message;
      timestamp = env.syncMessage.sentMessage.timestamp;
      // For sync messages, the sender is us — use destination as context
      // but keep sender as the source so session maps to this number
    }

    if (!text || !sender) return;

    if (sender === this.phoneNumber) return;

    const msg = {
      sender,
      text,
      timestamp: timestamp ?? Date.now(),
    };

    for (const handler of this._messageHandlers) {
      handler(msg).catch((err) => {
        this.logger?.error("Signal message handler error", { error: err.message });
      });
    }
  }

  // ── REST API modes ──

  /**
   * Connect via WebSocket for real-time message receive.
   * @returns {Promise<void>}
   */
  async _connectWebSocket() {
    const wsUrl = `${this.apiUrl.replace(/^http/, "ws")}/v1/receive/${this.phoneNumber}`;

    return new Promise((resolve, reject) => {
      import("ws").then(({ default: WebSocket }) => {
        const ws = new WebSocket(wsUrl);
        this._ws = ws;

        ws.on("open", () => {
          this._reconnectAttempt = 0;
          this.connected = true;
          this.logger?.info("Signal WebSocket connected");
          resolve();
        });

        ws.on("message", (data) => {
          try {
            const envelope = JSON.parse(data.toString());
            this._processEnvelope(envelope);
          } catch (err) {
            this.logger?.error("Failed to parse Signal message", { error: err.message });
          }
        });

        ws.on("close", () => {
          this.connected = false;
          if (!this._stopping) {
            this._scheduleReconnect();
          }
        });

        ws.on("error", (err) => {
          this.logger?.error("Signal WebSocket error", { error: err.message });
          if (!this.connected) {
            reject(err);
          }
        });
      }).catch(reject);
    });
  }

  _scheduleReconnect() {
    this._reconnectAttempt++;
    const baseDelay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt - 1), RECONNECT_MAX_MS);
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = baseDelay + jitter;
    this.logger?.info(`Signal reconnecting in ${Math.round(delay)}ms (attempt ${this._reconnectAttempt})`);
    setTimeout(() => {
      if (!this._stopping) {
        this._connectWebSocket().catch((err) => {
          this.logger?.error("Signal reconnect failed", { error: err.message });
        });
      }
    }, delay);
  }

  /**
   * Start HTTP polling for messages (REST API mode).
   */
  _startPolling() {
    this.connected = true;
    this._pollTimer = setInterval(async () => {
      try {
        const url = `${this.apiUrl}/v1/receive/${this.phoneNumber}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const envelopes = await res.json();
        if (Array.isArray(envelopes) && envelopes.length > 0) {
          this.logger?.info("Signal poll received", { count: envelopes.length });
          for (const envelope of envelopes) {
            this._processEnvelope(envelope);
          }
        }
      } catch (err) {
        this.logger?.error("Signal poll error", { error: err.message });
      }
    }, this.pollIntervalMs);
  }

  /**
   * Process a REST API envelope.
   * @param {object} envelope
   */
  _processEnvelope(envelope) {
    const dataMessage = envelope.envelope?.dataMessage;
    if (!dataMessage || !dataMessage.message) return;

    const sender = envelope.envelope.source;
    if (!sender) return;

    if (sender === this.phoneNumber) return;

    const msg = {
      sender,
      text: dataMessage.message,
      timestamp: dataMessage.timestamp ?? Date.now(),
    };

    for (const handler of this._messageHandlers) {
      handler(msg).catch((err) => {
        this.logger?.error("Signal message handler error", { error: err.message });
      });
    }
  }
}

/**
 * Split a long message into chunks at paragraph → line → hard boundaries.
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
