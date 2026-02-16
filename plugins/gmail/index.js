/**
 * Gmail Integration Plugin — bidirectional Gmail integration for KarnEvil9.
 *
 * Receives tasks via email, posts progress as in-thread replies,
 * handles text-based approval menus, and exposes a send-gmail-message tool.
 */
import { GmailClient } from "./gmail-client.js";
import { SessionBridge } from "./session-bridge.js";
import { JournalRelay } from "./journal-relay.js";
import { ApprovalHandler } from "./approval-handler.js";
import { CommandHandler } from "./command-handler.js";
import { AccessControl } from "./access-control.js";
import { sendGmailMessageManifest, createSendGmailMessageHandler } from "./send-tool.js";

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Resolve Gmail credentials (env vars with config fallback) ──
  const clientId = process.env.GMAIL_CLIENT_ID ?? config.clientId;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? config.clientSecret;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN ?? config.refreshToken;
  const pubsubProjectId = process.env.GMAIL_PUBSUB_PROJECT_ID ?? config.pubsubProjectId;
  const pubsubTopic = process.env.GMAIL_PUBSUB_TOPIC ?? config.pubsubTopic;
  const pubsubSubscription = process.env.GMAIL_PUBSUB_SUBSCRIPTION ?? config.pubsubSubscription;

  if (!clientId || !clientSecret || !refreshToken) {
    api.logger.warn("No GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN set — Gmail plugin will not connect (graceful degradation)");
    _registerStubs(api);
    return;
  }

  if (!pubsubProjectId || !pubsubTopic || !pubsubSubscription) {
    api.logger.warn("No GMAIL_PUBSUB_PROJECT_ID/TOPIC/SUBSCRIPTION set — Gmail plugin will not connect");
    _registerStubs(api);
    return;
  }

  // ── Resolve runtime dependencies ──
  const sessionFactory = config.sessionFactory;
  const journal = config.journal;
  const apiBaseUrl = config.apiBaseUrl ?? "http://localhost:3100";
  const apiToken = config.apiToken;

  if (!sessionFactory) {
    api.logger.warn("No sessionFactory provided — Gmail will receive messages but cannot create sessions");
  }

  // ── Parse allowed senders ──
  const allowedSendersRaw = process.env.GMAIL_ALLOWED_SENDERS ?? config.allowedSenders ?? "";
  const allowedSenders = typeof allowedSendersRaw === "string"
    ? allowedSendersRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : allowedSendersRaw;

  const labelFilter = process.env.GMAIL_LABEL_FILTER ?? config.labelFilter ?? "INBOX";

  // ── Build components ──
  const gmailClient = new GmailClient({
    clientId,
    clientSecret,
    refreshToken,
    pubsubProjectId,
    pubsubTopic,
    pubsubSubscription,
    labelFilter,
    logger: api.logger,
  });

  const accessControl = new AccessControl({ allowedSenders });

  const sessionBridge = new SessionBridge({
    sessionFactory: sessionFactory ?? (() => { throw new Error("No sessionFactory configured"); }),
    maxConcurrentSessions: config.maxConcurrentSessions ?? 10,
    sessionTimeout: config.sessionTimeout ?? 300000,
  });

  const approvalHandler = new ApprovalHandler({
    gmailClient,
    apiBaseUrl,
    apiToken,
    logger: api.logger,
  });

  const journalRelay = journal
    ? new JournalRelay({ journal, gmailClient, sessionBridge, approvalHandler, logger: api.logger })
    : null;

  const commandHandler = new CommandHandler({
    gmailClient,
    sessionBridge,
    logger: api.logger,
  });

  // ── Wire message handler ──
  gmailClient.onMessage(async ({ sender, text, subject, threadId }) => {
    // 1. Access control check
    if (!accessControl.isAllowed(sender)) {
      api.logger.warn("Gmail message rejected — sender not allowed", { sender });
      return;
    }

    // 2. Check for pending approval reply (1/2/3)
    if (approvalHandler.isPendingReply(sender, text)) {
      await approvalHandler.handleReply(sender, text);
      return;
    }

    // 3. Check for text commands (status/cancel/help)
    if (commandHandler.isCommand(text)) {
      await commandHandler.handle(sender, text, { threadId, subject });
      return;
    }

    // 4. Check if sender already has an active session
    if (sessionBridge.hasActiveSession(sender)) {
      await gmailClient.sendReply({
        to: sender,
        subject: `Re: ${subject}`,
        body: "A session is already running. Reply \"cancel\" to stop it, or \"status\" to check progress.",
        threadId,
      });
      return;
    }

    // 5. Create new session
    const taskText = text.trim();
    if (!taskText) return;

    if (!sessionFactory) {
      await gmailClient.sendReply({
        to: sender,
        subject: `Re: ${subject}`,
        body: "\u26A0\uFE0F KarnEvil9 session factory not configured",
        threadId,
      });
      return;
    }

    try {
      const result = await sessionBridge.createSession({ taskText, sender, threadId, subject });
      await gmailClient.sendReply({
        to: sender,
        subject: `Re: ${subject}`,
        body: `\u2705 Session ${result.session_id} started`,
        threadId,
      });
    } catch (err) {
      api.logger.error("Failed to create session from Gmail", { error: err.message });
      await gmailClient.sendReply({
        to: sender,
        subject: `Re: ${subject}`,
        body: `\u274C Failed to start session: ${err.message}`,
        threadId,
      });
    }
  });

  // ── Register tool: send-gmail-message ──
  api.registerTool(sendGmailMessageManifest, createSendGmailMessageHandler(gmailClient));

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
      connected: gmailClient.connected,
      activeSessions: sessionBridge.activeCount,
      email: gmailClient._myEmail,
    });
  });

  api.registerRoute("GET", "conversations", (req, res) => {
    const sessions = sessionBridge.listSessions();
    res.json({
      activeSenders: [...new Set(sessions.map((s) => s.sender))],
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        sender: s.sender,
        threadId: s.threadId,
        subject: s.subject,
        elapsed: Math.round((Date.now() - s.startedAt) / 1000),
      })),
    });
  });

  // ── Register service: gmail-connection ──
  api.registerService({
    name: "gmail-connection",
    async start() {
      await gmailClient.start();
      if (journalRelay) journalRelay.start();
      api.logger.info("Gmail connected", { email: gmailClient._myEmail });
    },
    async stop() {
      if (journalRelay) journalRelay.stop();
      approvalHandler.dispose();
      await gmailClient.stop();
      api.logger.info("Gmail disconnected");
    },
  });

  api.logger.info("Gmail plugin registered");
}

/**
 * Register stubs when Gmail credentials are missing (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  api.registerTool(sendGmailMessageManifest, async (input, mode) => {
    if (mode === "mock") return { ok: true, to: input.to ?? "mock@example.com", messageId: "mock-id" };
    return { ok: false, error: "Gmail not connected" };
  });

  api.registerHook("after_session_end", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: false, activeSessions: 0, email: null });
  });

  api.registerRoute("GET", "conversations", (_req, res) => {
    res.json({ activeSenders: [], sessions: [] });
  });

  api.registerService({
    name: "gmail-connection",
    async start() { api.logger.info("Gmail service stub — no credentials configured"); },
    async stop() {},
  });
}
