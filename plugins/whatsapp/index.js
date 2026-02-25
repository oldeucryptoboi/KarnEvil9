/**
 * WhatsApp Integration Plugin — bidirectional WhatsApp integration for KarnEvil9.
 *
 * Receives tasks via WhatsApp DMs (via Baileys/WhatsApp Web protocol),
 * posts progress as messages, handles text-based approval menus,
 * and exposes a send-whatsapp-message tool.
 */
import { WhatsAppClient } from "./whatsapp-client.js";
import { SessionBridge } from "./session-bridge.js";
import { JournalRelay } from "./journal-relay.js";
import { ApprovalHandler } from "./approval-handler.js";
import { CommandHandler } from "./command-handler.js";
import { AccessControl } from "./access-control.js";
import { sendWhatsAppMessageManifest, createSendWhatsAppMessageHandler } from "./send-tool.js";

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Check if WhatsApp is enabled ──
  const enabled = process.env.WHATSAPP_ENABLED ?? config.enabled;

  if (!enabled) {
    api.logger.warn("WHATSAPP_ENABLED not set — WhatsApp plugin will not connect (graceful degradation)");
    _registerStubs(api);
    return;
  }

  // ── Resolve runtime dependencies ──
  const sessionFactory = config.sessionFactory;
  const journal = config.journal;
  const apiBaseUrl = config.apiBaseUrl ?? "http://localhost:3100";
  const apiToken = config.apiToken;

  if (!sessionFactory) {
    api.logger.warn("No sessionFactory provided — WhatsApp will receive messages but cannot create sessions");
  }

  // ── Parse allowed numbers ──
  const allowedNumbersRaw = process.env.WHATSAPP_ALLOWED_NUMBERS ?? config.allowedNumbers ?? "";
  const allowedNumbers = typeof allowedNumbersRaw === "string"
    ? allowedNumbersRaw.split(",").map((n) => n.trim()).filter(Boolean)
    : allowedNumbersRaw;

  // ── Build components ──
  const authDir = process.env.WHATSAPP_AUTH_DIR ?? config.authDir ?? "./whatsapp-auth";
  const botName = process.env.WHATSAPP_BOT_NAME ?? config.botName ?? "Eddie";
  const maxSessions = parseInt(process.env.WHATSAPP_MAX_SESSIONS ?? config.maxConcurrentSessions ?? "10", 10);

  const whatsappClient = new WhatsAppClient({
    authDir,
    botName,
    logger: api.logger,
  });

  const accessControl = new AccessControl({ allowedNumbers });

  const sessionBridge = new SessionBridge({
    sessionFactory: sessionFactory ?? (() => { throw new Error("No sessionFactory configured"); }),
    maxConcurrentSessions: maxSessions,
    sessionTimeout: config.sessionTimeout ?? 300000,
  });

  const approvalHandler = new ApprovalHandler({
    whatsappClient,
    apiBaseUrl,
    apiToken,
    logger: api.logger,
  });

  const journalRelay = journal
    ? new JournalRelay({ journal, whatsappClient, sessionBridge, approvalHandler, logger: api.logger })
    : null;

  const commandHandler = new CommandHandler({
    whatsappClient,
    sessionBridge,
    logger: api.logger,
  });

  // ── Pending task confirmations (sender -> { taskText, expiresAt }) ──
  const pendingConfirmations = new Map();
  const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // ── Wire message handler ──
  whatsappClient.onMessage(async ({ sender, text }) => {
    // 1. Access control check
    if (!accessControl.isAllowed(sender)) {
      api.logger.warn("WhatsApp message rejected — sender not allowed", { sender });
      return;
    }

    // 2. Check for pending approval reply (1/2/3)
    if (approvalHandler.isPendingReply(sender, text)) {
      await approvalHandler.handleReply(sender, text);
      return;
    }

    // 3. Check for text commands (status/cancel/help)
    if (commandHandler.isCommand(text)) {
      await commandHandler.handle(sender, text);
      return;
    }

    // 4. Check if sender already has an active session
    if (sessionBridge.hasActiveSession(sender)) {
      await whatsappClient.sendMessage({
        jid: sender,
        message: "A session is already running. Send \"cancel\" to stop it, or \"status\" to check progress.",
      });
      return;
    }

    // 5. Check for confirmation of a pending task
    const pending = pendingConfirmations.get(sender);
    if (pending && Date.now() < pending.expiresAt) {
      const reply = text.trim().toLowerCase();
      if (reply === "yes" || reply === "y" || reply === "confirm") {
        pendingConfirmations.delete(sender);
        if (!sessionFactory) {
          await whatsappClient.sendMessage({ jid: sender, message: "\u26A0\uFE0F KarnEvil9 session factory not configured" });
          return;
        }
        try {
          await whatsappClient.sendTyping(sender);
          const result = await sessionBridge.createSession({ taskText: pending.taskText, sender });
          await whatsappClient.sendMessage({ jid: sender, message: `\u2705 Session ${result.session_id} started` });
        } catch (err) {
          api.logger.error("Failed to create session from WhatsApp", { error: err.message });
          await whatsappClient.sendMessage({ jid: sender, message: `\u274C Failed to start session: ${err.message}` });
        }
        return;
      } else if (reply === "no" || reply === "n" || reply === "cancel") {
        pendingConfirmations.delete(sender);
        await whatsappClient.sendMessage({ jid: sender, message: "Task cancelled." });
        return;
      }
      // Not yes/no — treat as new task request (fall through)
      pendingConfirmations.delete(sender);
    } else if (pending) {
      pendingConfirmations.delete(sender);
    }

    // 6. New task — require confirmation before creating session
    const taskText = text.trim();
    if (!taskText) return;

    pendingConfirmations.set(sender, {
      taskText,
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    });

    const preview = taskText.length > 200 ? taskText.substring(0, 200) + "..." : taskText;
    await whatsappClient.sendMessage({
      jid: sender,
      message: `\u2753 Run this task?\n\n"${preview}"\n\nReply *YES* to confirm or *NO* to cancel. (Expires in 5 min)`,
    });
  });

  // ── Register tool: send-whatsapp-message ──
  api.registerTool(sendWhatsAppMessageManifest, createSendWhatsAppMessageHandler(whatsappClient));

  // ── Register hook: after_session_end ──
  api.registerHook("after_session_end", async (context) => {
    if (context.session_id) {
      sessionBridge.removeSession(context.session_id);
    }
    return { action: "observe" };
  });

  // ── Register routes ──
  api.registerRoute("GET", "status", (req, res) => {
    res.json({
      connected: whatsappClient.connected,
      activeSessions: sessionBridge.activeCount,
      botName,
    });
  });

  api.registerRoute("GET", "conversations", (req, res) => {
    const sessions = sessionBridge.listSessions();
    res.json({
      activeSenders: [...new Set(sessions.map((s) => s.sender))],
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        sender: s.sender,
        elapsed: Math.round((Date.now() - s.startedAt) / 1000),
      })),
    });
  });

  // ── Register service: whatsapp-connection ──
  api.registerService({
    name: "whatsapp-connection",
    async start() {
      await whatsappClient.start();
      if (journalRelay) journalRelay.start();
      api.logger.info("WhatsApp connected via Baileys", { botName });
    },
    async stop() {
      if (journalRelay) journalRelay.stop();
      approvalHandler.dispose();
      await whatsappClient.stop();
      api.logger.info("WhatsApp disconnected");
    },
  });

  api.logger.info("WhatsApp plugin registered");
}

/**
 * Register stubs when WhatsApp is not enabled (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  api.registerTool(sendWhatsAppMessageManifest, async (input, mode) => {
    if (mode === "mock") return { ok: true, recipient: input.recipient ?? "+0000000000" };
    return { ok: false, error: "WhatsApp not connected" };
  });

  api.registerHook("after_session_end", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: false, activeSessions: 0, mode: "disabled" });
  });

  api.registerRoute("GET", "conversations", (_req, res) => {
    res.json({ activeSenders: [], sessions: [] });
  });

  api.registerService({
    name: "whatsapp-connection",
    async start() { api.logger.info("WhatsApp service stub — not enabled"); },
    async stop() {},
  });
}
