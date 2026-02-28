/**
 * WhatsAppClient — wraps @whiskeysockets/baileys for message send/receive.
 *
 * Uses the WhatsApp Web multi-device protocol via Baileys.
 * Auth state persisted to disk via useMultiFileAuthState.
 * QR code displayed in terminal for initial pairing.
 */
import { resolve } from "node:path";

const MAX_MESSAGE_LENGTH = 4000;
const CHUNK_DELAY_MS = 500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class WhatsAppClient {
  /**
   * @param {object} opts
   * @param {string} [opts.authDir] - Directory for Baileys auth state (default: "./whatsapp-auth")
   * @param {string} [opts.botName] - Bot display name (default: "Eddie")
   * @param {object} [opts.logger] - Plugin logger
   */
  constructor({ authDir = "./whatsapp-auth", botName = "Eddie", logger } = {}) {
    this.authDir = resolve(authDir);
    this.botName = botName;
    this.logger = logger;
    this.connected = false;
    this._sock = null;
    this._messageHandlers = [];
    this._reconnectAttempt = 0;
    this._stopping = false;
    this._baileys = null;
    this._qrTerminal = null;
    this._reconnectTimer = null;
  }

  /**
   * Register a message handler.
   * @param {(message: { sender: string, text: string, timestamp: number }) => Promise<void>} handler
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /**
   * Start the WhatsApp connection.
   * Displays QR code in terminal for first-time pairing.
   * @returns {Promise<void>}
   */
  async start() {
    this._stopping = false;

    // Dynamically import Baileys (optional dependency)
    try {
      this._baileys = await import("@whiskeysockets/baileys");
    } catch (err) {
      throw new Error(
        `@whiskeysockets/baileys not installed. Run: pnpm add @whiskeysockets/baileys @hapi/boom qrcode-terminal\n${err.message}`
      );
    }

    // Try to import qrcode-terminal (optional, falls back to raw QR string)
    try {
      this._qrTerminal = await import("qrcode-terminal");
    } catch {
      this.logger?.warn("qrcode-terminal not installed — QR codes will be printed as raw strings");
    }

    await this._connect();
  }

  /**
   * Stop the WhatsApp connection.
   * @returns {Promise<void>}
   */
  async stop() {
    this._stopping = true;
    this.connected = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._sock) {
      this._sock.end(undefined);
      this._sock = null;
    }
  }

  /**
   * Send a message to a WhatsApp JID.
   * @param {object} opts
   * @param {string} opts.jid - WhatsApp JID (e.g. "1234567890@s.whatsapp.net")
   * @param {string} opts.message - Message text
   * @returns {Promise<void>}
   */
  async sendMessage({ jid, message }) {
    if (!this._sock) {
      throw new Error("WhatsApp not connected");
    }
    await this._sock.sendMessage(jid, { text: message });
  }

  /**
   * Send a long message, splitting into chunks if needed.
   * @param {object} opts
   * @param {string} opts.jid - WhatsApp JID
   * @param {string} opts.message - Message text (may exceed limit)
   * @returns {Promise<void>}
   */
  async sendLongMessage({ jid, message }) {
    if (message.length <= MAX_MESSAGE_LENGTH) {
      await this.sendMessage({ jid, message });
      return;
    }

    const chunks = splitMessage(message, MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = `[${i + 1}/${chunks.length}] `;
      await this.sendMessage({ jid, message: prefix + chunks[i] });
      if (i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }
  }

  /**
   * Send a typing/composing indicator (best-effort).
   * @param {string} jid - WhatsApp JID
   * @returns {Promise<void>}
   */
  async sendTyping(jid) {
    try {
      if (this._sock) {
        await this._sock.sendPresenceUpdate("composing", jid);
      }
    } catch {
      // Typing indicator is best-effort
    }
  }

  // ── Internal: Baileys connection ──

  async _connect() {
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = this._baileys;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: this._createBaileysLogger(),
      browser: [this.botName, "Chrome", "120.0.0"],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    this._sock = sock;

    // Save credentials on update
    sock.ev.on("creds.update", saveCreds);

    // Connection state changes
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this._displayQR(qr);
      }

      if (connection === "open") {
        this.connected = true;
        this._reconnectAttempt = 0;
        this.logger?.info("WhatsApp connected");
      }

      if (connection === "close") {
        this.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.message ?? lastDisconnect?.error?.message ?? "unknown";

        this.logger?.warn("WhatsApp disconnected", { statusCode, reason });

        if (this._stopping) return;

        // If logged out, clear auth and require re-scan
        if (statusCode === DisconnectReason.loggedOut) {
          this.logger?.warn("WhatsApp logged out — clearing auth state. Restart to re-pair.");
          this._clearAuthState();
          return;
        }

        // Reconnect with exponential backoff
        this._scheduleReconnect();
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return; // Only process new messages, not history sync

      for (const msg of messages) {
        if (msg.key.fromMe) continue; // Ignore own messages
        const sender = msg.key.remoteJid;
        if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast") continue; // Skip groups & status

        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          "";
        if (!text) continue; // Skip non-text messages (images, etc.)

        const timestamp = typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp * 1000
          : Date.now();

        const parsed = { sender, text, timestamp };

        for (const handler of this._messageHandlers) {
          handler(parsed).catch((err) => {
            this.logger?.error("WhatsApp message handler error", { error: err.message });
          });
        }
      }
    });
  }

  /**
   * Display QR code for pairing.
   * @param {string} qr - QR string from Baileys
   */
  _displayQR(qr) {
    this.logger?.info("Scan the QR code below with WhatsApp to pair:");

    if (this._qrTerminal?.generate) {
      this._qrTerminal.generate(qr, { small: true });
    } else if (this._qrTerminal?.default?.generate) {
      this._qrTerminal.default.generate(qr, { small: true });
    } else {
      // Fallback: print raw QR string
      console.log("\nWhatsApp QR Code (install qrcode-terminal for visual display):");
      console.log(qr);
      console.log("");
    }
  }

  /**
   * Schedule a reconnect with exponential backoff.
   */
  _scheduleReconnect() {
    this._reconnectAttempt++;
    const baseDelay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt - 1), RECONNECT_MAX_MS);
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = baseDelay + jitter;
    this.logger?.info(`WhatsApp reconnecting in ${Math.round(delay)}ms (attempt ${this._reconnectAttempt})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopping) {
        this._connect().catch((err) => {
          this.logger?.error("WhatsApp reconnect failed", { error: err.message });
          this._scheduleReconnect();
        });
      }
    }, delay);
  }

  /**
   * Clear auth state directory (after logout).
   */
  async _clearAuthState() {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(this.authDir, { recursive: true, force: true });
      this.logger?.info("WhatsApp auth state cleared");
    } catch (err) {
      this.logger?.error("Failed to clear WhatsApp auth state", { error: err.message });
    }
  }

  /**
   * Create a pino-compatible logger for Baileys (silences verbose output).
   * @returns {object}
   */
  _createBaileysLogger() {
    const noop = () => {};
    return {
      level: "silent",
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      child: () => this._createBaileysLogger(),
    };
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
