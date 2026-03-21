/**
 * Telegram Integration Plugin — bidirectional Telegram integration for KarnEvil9.
 *
 * Receives tasks via Telegram DMs, posts progress as messages,
 * handles text-based approval menus, and exposes a send-telegram-message tool.
 *
 * ── Setup ──────────────────────────────────────────────────────────────────
 *
 * 1. Create a bot with BotFather:
 *    - Open @BotFather in Telegram, send /newbot, follow prompts
 *    - Copy the bot token (looks like 123456:ABC-DEF...)
 *
 * 2. Find your Telegram user ID:
 *    - Message @userinfobot in Telegram — it replies with your numeric ID
 *
 * 3. Environment variables:
 *    - TELEGRAM_BOT_TOKEN        (required) Bot API token from BotFather
 *    - TELEGRAM_ALLOWED_USERS    (optional) Comma-separated numeric user IDs
 *    - TELEGRAM_DM_POLICY        (optional) "allowlist" or "pairing"
 *      Defaults: "allowlist" if TELEGRAM_ALLOWED_USERS is set, "pairing" if empty
 *
 * ───────────────────────────────────────────────────────────────────────────
 */
import { TelegramClient } from "./telegram-client.js";
import { SessionBridge } from "./session-bridge.js";
import { JournalRelay } from "./journal-relay.js";
import { ApprovalHandler } from "./approval-handler.js";
import { CommandHandler } from "./command-handler.js";
import { AccessControl } from "./access-control.js";
import { PairingHandler } from "./pairing-handler.js";
import { sendTelegramMessageManifest, createSendTelegramMessageHandler } from "./send-tool.js";

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Resolve Telegram credentials (env vars with config fallback) ──
  const token = process.env.TELEGRAM_BOT_TOKEN ?? config.telegramBotToken;

  if (!token) {
    api.logger.warn("No TELEGRAM_BOT_TOKEN set — Telegram plugin will not connect (graceful degradation)");
    _registerStubs(api);
    return;
  }

  // ── Resolve runtime dependencies ──
  const sessionFactory = config.sessionFactory;
  const journal = config.journal;
  const apiBaseUrl = config.apiBaseUrl ?? "http://localhost:3100";
  const apiToken = config.apiToken;

  if (!sessionFactory) {
    api.logger.warn("No sessionFactory provided — Telegram will receive messages but cannot create sessions");
  }

  // ── Parse allowed users ──
  const allowedUsersRaw = process.env.TELEGRAM_ALLOWED_USERS ?? config.allowedUsers ?? "";
  const allowedUsers = typeof allowedUsersRaw === "string"
    ? allowedUsersRaw.split(",").map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id))
    : allowedUsersRaw;

  // ── Resolve DM policy ──
  const hasAllowedUsers = allowedUsers.length > 0;
  const dmPolicyRaw = process.env.TELEGRAM_DM_POLICY ?? config.dmPolicy;
  const dmPolicy = dmPolicyRaw === "allowlist" || dmPolicyRaw === "pairing"
    ? dmPolicyRaw
    : hasAllowedUsers ? "allowlist" : "pairing";

  // ── Build components ──
  const telegramClient = new TelegramClient({
    token,
    logger: api.logger,
  });

  const accessControl = new AccessControl({ allowedUsers, mode: dmPolicy });

  const pairingHandler = new PairingHandler();

  const sessionBridge = new SessionBridge({
    sessionFactory: sessionFactory ?? (() => { throw new Error("No sessionFactory configured"); }),
    maxConcurrentSessions: config.maxConcurrentSessions ?? 10,
    sessionTimeout: config.sessionTimeout ?? 300000,
  });

  const approvalHandler = new ApprovalHandler({
    telegramClient,
    apiBaseUrl,
    apiToken,
    logger: api.logger,
  });

  const journalRelay = journal
    ? new JournalRelay({ journal, telegramClient, sessionBridge, approvalHandler, logger: api.logger })
    : null;

  const commandHandler = new CommandHandler({
    telegramClient,
    sessionBridge,
    logger: api.logger,
  });

  // ── Wire message handler ──
  telegramClient.onMessage(async ({ chatId, userId, text }) => {
    // 1. Access control check
    if (!accessControl.isAllowed(userId)) {
      // In pairing mode, generate a code for unknown users
      if (accessControl.isPairingMode) {
        const code = pairingHandler.createPairingCode(userId, chatId);
        await telegramClient.sendMessage({
          chatId,
          text: `\uD83D\uDD10 You're not yet authorized.\n\nYour pairing code: ${code}\n\nShare this code with the admin to get approved. It expires in 1 hour.`,
        });
      } else {
        api.logger.warn("Telegram message rejected — user not allowed", { userId });
      }
      return;
    }

    // 2. Check for pending approval reply (1/2/3)
    if (approvalHandler.isPendingReply(chatId, text)) {
      await approvalHandler.handleReply(chatId, text);
      return;
    }

    // 3. Check for text commands (/status, /cancel, /help)
    if (commandHandler.isCommand(text)) {
      await commandHandler.handle(chatId, text);
      return;
    }

    // 4. Check if chat already has an active session
    if (sessionBridge.hasActiveSession(chatId)) {
      await telegramClient.sendMessage({
        chatId,
        text: "A session is already running. Send /cancel to stop it, or /status to check progress.",
      });
      return;
    }

    // 5. Create session directly — user is on the allowlist, no confirmation needed
    const taskText = text.trim();
    if (!taskText) return;

    if (!sessionFactory) {
      await telegramClient.sendMessage({ chatId, text: "\u26A0\uFE0F KarnEvil9 session factory not configured" });
      return;
    }

    try {
      await telegramClient.sendTyping(chatId);
      const result = await sessionBridge.createSession({ taskText, chatId });
      await telegramClient.sendMessage({ chatId, text: `\u2705 Session ${result.session_id} started` });
    } catch (err) {
      api.logger.error("Failed to create session from Telegram", { error: err.message });
      await telegramClient.sendMessage({ chatId, text: `\u274C Failed to start session: ${err.message}` });
    }
  });

  // ── Register tool: send-telegram-message ──
  api.registerTool(sendTelegramMessageManifest, createSendTelegramMessageHandler(telegramClient));

  // ── Register hook: before_plan (inject Telegram chat context) ──
  api.registerHook("before_plan", async (context) => {
    const chatId = sessionBridge.getChatIdForSession(context.session_id);
    if (chatId === undefined) return { action: "continue" };
    return {
      action: "modify",
      data: {
        hints: [
          `[Telegram] This task was sent from Telegram chat_id ${chatId}. ` +
          `The user is on Telegram and can only see output from the respond tool. ` +
          `After gathering data, always use respond to deliver results to the user. ` +
          `For proactive/out-of-band messages, use send-telegram-message with chat_id: ${chatId}.`,
        ],
      },
    };
  });

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
      connected: telegramClient.connected,
      activeSessions: sessionBridge.activeCount,
      mode: "polling",
      dmPolicy,
      pendingPairings: pairingHandler.pendingCount,
    });
  });

  api.registerRoute("GET", "conversations", (req, res) => {
    const sessions = sessionBridge.listSessions();
    res.json({
      activeChats: [...new Set(sessions.map((s) => s.chatId))],
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        chatId: s.chatId,
        elapsed: Math.round((Date.now() - s.startedAt) / 1000),
      })),
    });
  });

  api.registerRoute("GET", "pairing", (req, res) => {
    res.json({ pending: pairingHandler.listPending() });
  });

  api.registerRoute("POST", "pairing/:code/approve", async (req, res) => {
    const { code } = req.params;
    const result = pairingHandler.approve(code);
    if (!result) {
      res.status(404).json({ error: "Pairing code not found or expired" });
      return;
    }
    accessControl.addUser(result.userId);
    // Notify user via Telegram (best-effort)
    try {
      await telegramClient.sendMessage({
        chatId: result.chatId,
        text: "\u2705 You've been approved! You can now send tasks to this bot.",
      });
    } catch (err) {
      api.logger.warn("Failed to notify approved user", { error: err.message });
    }
    res.json({ ok: true, userId: result.userId });
  });

  api.registerRoute("POST", "pairing/:code/deny", async (req, res) => {
    const { code } = req.params;
    const result = pairingHandler.deny(code);
    if (!result) {
      res.status(404).json({ error: "Pairing code not found or expired" });
      return;
    }
    // Notify user via Telegram (best-effort)
    try {
      await telegramClient.sendMessage({
        chatId: result.chatId,
        text: "\u274C Your pairing request was denied.",
      });
    } catch (err) {
      api.logger.warn("Failed to notify denied user", { error: err.message });
    }
    res.json({ ok: true, userId: result.userId });
  });

  // ── Register service: telegram-connection ──
  api.registerService({
    name: "telegram-connection",
    async start() {
      await telegramClient.start();
      if (journalRelay) journalRelay.start();
      api.logger.info("Telegram connected (polling mode)");
    },
    async stop() {
      if (journalRelay) journalRelay.stop();
      approvalHandler.dispose();
      await telegramClient.stop();
      api.logger.info("Telegram disconnected");
    },
  });

  api.logger.info(`Telegram plugin registered (dmPolicy=${dmPolicy})`);
}

/**
 * Register stubs when Telegram credentials are missing (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  api.registerTool(sendTelegramMessageManifest, async (input, mode) => {
    if (mode === "mock") return { ok: true, chat_id: input.chat_id ?? 0 };
    return { ok: false, error: "Telegram not connected" };
  });

  api.registerHook("after_session_end", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: false, activeSessions: 0, mode: "disabled" });
  });

  api.registerRoute("GET", "conversations", (_req, res) => {
    res.json({ activeChats: [], sessions: [] });
  });

  api.registerRoute("GET", "pairing", (_req, res) => {
    res.json({ pending: [] });
  });

  api.registerRoute("POST", "pairing/:code/approve", (_req, res) => {
    res.status(503).json({ error: "Telegram not connected" });
  });

  api.registerRoute("POST", "pairing/:code/deny", (_req, res) => {
    res.status(503).json({ error: "Telegram not connected" });
  });

  api.registerService({
    name: "telegram-connection",
    async start() { api.logger.info("Telegram service stub — no credentials configured"); },
    async stop() {},
  });
}
