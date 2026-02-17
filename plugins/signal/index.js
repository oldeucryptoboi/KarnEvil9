/**
 * Signal Integration Plugin — bidirectional Signal integration for KarnEvil9.
 *
 * Receives tasks via Signal DMs, posts progress as messages,
 * handles text-based approval menus, and exposes a send-signal-message tool.
 */
import { SignalClient } from "./signal-client.js";
import { SessionBridge } from "./session-bridge.js";
import { JournalRelay } from "./journal-relay.js";
import { ApprovalHandler } from "./approval-handler.js";
import { CommandHandler } from "./command-handler.js";
import { AccessControl } from "./access-control.js";
import { sendSignalMessageManifest, createSendSignalMessageHandler } from "./send-tool.js";

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Resolve Signal credentials (env vars with config fallback) ──
  const apiUrl = process.env.SIGNAL_CLI_API_URL ?? config.signalApiUrl;
  const phoneNumber = process.env.SIGNAL_PHONE_NUMBER ?? config.signalPhoneNumber;
  const mode = process.env.SIGNAL_MODE ?? config.mode ?? "native";

  if (!phoneNumber) {
    api.logger.warn("No SIGNAL_PHONE_NUMBER set — Signal plugin will not connect (graceful degradation)");
    _registerStubs(api);
    return;
  }

  if ((mode === "polling" || mode === "websocket") && !apiUrl) {
    api.logger.warn("No SIGNAL_CLI_API_URL set for REST API mode — Signal plugin will not connect");
    _registerStubs(api);
    return;
  }

  // ── Resolve runtime dependencies ──
  const sessionFactory = config.sessionFactory;
  const journal = config.journal;
  const apiBaseUrl = config.apiBaseUrl ?? "http://localhost:3100";
  const apiToken = config.apiToken;

  if (!sessionFactory) {
    api.logger.warn("No sessionFactory provided — Signal will receive messages but cannot create sessions");
  }

  // ── Parse allowed numbers ──
  const allowedNumbersRaw = process.env.SIGNAL_ALLOWED_NUMBERS ?? config.allowedNumbers ?? "";
  const allowedNumbers = typeof allowedNumbersRaw === "string"
    ? allowedNumbersRaw.split(",").map((n) => n.trim()).filter(Boolean)
    : allowedNumbersRaw;

  // ── Build components ──
  const signalClient = new SignalClient({
    apiUrl,
    phoneNumber,
    mode,
    logger: api.logger,
  });

  const accessControl = new AccessControl({ allowedNumbers });

  const sessionBridge = new SessionBridge({
    sessionFactory: sessionFactory ?? (() => { throw new Error("No sessionFactory configured"); }),
    maxConcurrentSessions: config.maxConcurrentSessions ?? 10,
    sessionTimeout: config.sessionTimeout ?? 300000,
  });

  const approvalHandler = new ApprovalHandler({
    signalClient,
    apiBaseUrl,
    apiToken,
    logger: api.logger,
  });

  const journalRelay = journal
    ? new JournalRelay({ journal, signalClient, sessionBridge, approvalHandler, logger: api.logger })
    : null;

  const commandHandler = new CommandHandler({
    signalClient,
    sessionBridge,
    logger: api.logger,
  });

  // ── Pending task confirmations (sender -> { taskText, expiresAt }) ──
  const pendingConfirmations = new Map();
  const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // ── Wire message handler ──
  signalClient.onMessage(async ({ sender, text }) => {
    // 1. Access control check
    if (!accessControl.isAllowed(sender)) {
      api.logger.warn("Signal message rejected — sender not allowed", { sender });
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
      await signalClient.sendMessage({
        recipient: sender,
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
          await signalClient.sendMessage({ recipient: sender, message: "\u26A0\uFE0F KarnEvil9 session factory not configured" });
          return;
        }
        try {
          await signalClient.sendTyping(sender);
          const result = await sessionBridge.createSession({ taskText: pending.taskText, sender });
          await signalClient.sendMessage({ recipient: sender, message: `\u2705 Session ${result.session_id} started` });
        } catch (err) {
          api.logger.error("Failed to create session from Signal", { error: err.message });
          await signalClient.sendMessage({ recipient: sender, message: `\u274C Failed to start session: ${err.message}` });
        }
        return;
      } else if (reply === "no" || reply === "n" || reply === "cancel") {
        pendingConfirmations.delete(sender);
        await signalClient.sendMessage({ recipient: sender, message: "Task cancelled." });
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
    await signalClient.sendMessage({
      recipient: sender,
      message: `\u2753 Run this task?\n\n"${preview}"\n\nReply YES to confirm or NO to cancel. (Expires in 5 min)`,
    });
  });

  // ── Register tool: send-signal-message ──
  api.registerTool(sendSignalMessageManifest, createSendSignalMessageHandler(signalClient));

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
      connected: signalClient.connected,
      activeSessions: sessionBridge.activeCount,
      mode,
      phoneNumber,
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

  // ── Register service: signal-connection ──
  api.registerService({
    name: "signal-connection",
    async start() {
      await signalClient.start();
      if (journalRelay) journalRelay.start();
      api.logger.info(`Signal connected (${mode} mode)`, { phoneNumber });
    },
    async stop() {
      if (journalRelay) journalRelay.stop();
      approvalHandler.dispose();
      await signalClient.stop();
      api.logger.info("Signal disconnected");
    },
  });

  api.logger.info("Signal plugin registered");
}

/**
 * Register stubs when Signal credentials are missing (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  api.registerTool(sendSignalMessageManifest, async (input, mode) => {
    if (mode === "mock") return { ok: true, recipient: input.recipient ?? "+0000000000" };
    return { ok: false, error: "Signal not connected" };
  });

  api.registerHook("after_session_end", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: false, activeSessions: 0, mode: "disabled" });
  });

  api.registerRoute("GET", "conversations", (_req, res) => {
    res.json({ activeSenders: [], sessions: [] });
  });

  api.registerService({
    name: "signal-connection",
    async start() { api.logger.info("Signal service stub — no credentials configured"); },
    async stop() {},
  });
}
