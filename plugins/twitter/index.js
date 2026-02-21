/**
 * X/Twitter Integration Plugin — bidirectional Twitter integration for KarnEvil9.
 *
 * Receives tasks via Twitter DMs (via Twitter API v2 polling),
 * posts progress as DMs, handles text-based approval menus,
 * and exposes post-tweet + send-twitter-dm tools.
 */
import { TwitterClient } from "./twitter-client.js";
import { SessionBridge } from "./session-bridge.js";
import { JournalRelay } from "./journal-relay.js";
import { ApprovalHandler } from "./approval-handler.js";
import { CommandHandler } from "./command-handler.js";
import { AccessControl } from "./access-control.js";
import {
  postTweetManifest, createPostTweetHandler,
  sendTwitterDmManifest, createSendTwitterDmHandler,
} from "./send-tool.js";

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Check if Twitter API key is set ──
  const apiKey = process.env.TWITTER_API_KEY ?? config.apiKey;

  if (!apiKey) {
    api.logger.warn("TWITTER_API_KEY not set — Twitter plugin will not connect (graceful degradation)");
    _registerStubs(api);
    return;
  }

  // ── Resolve runtime dependencies ──
  const sessionFactory = config.sessionFactory;
  const journal = config.journal;
  const apiBaseUrl = config.apiBaseUrl ?? "http://localhost:3100";
  const apiToken = config.apiToken;

  if (!sessionFactory) {
    api.logger.warn("No sessionFactory provided — Twitter will receive DMs but cannot create sessions");
  }

  // ── Parse allowed user IDs ──
  const allowedUserIdsRaw = process.env.TWITTER_ALLOWED_USER_IDS ?? config.allowedUserIds ?? "";
  const allowedUserIds = typeof allowedUserIdsRaw === "string"
    ? allowedUserIdsRaw.split(",").map((id) => id.trim()).filter(Boolean)
    : allowedUserIdsRaw;

  // ── Build components ──
  const apiSecret = process.env.TWITTER_API_SECRET ?? config.apiSecret;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN ?? config.accessToken;
  const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET ?? config.accessTokenSecret;
  const pollIntervalMs = parseInt(process.env.TWITTER_POLL_INTERVAL_MS ?? config.pollIntervalMs ?? "15000", 10);
  const maxSessions = parseInt(process.env.TWITTER_MAX_SESSIONS ?? config.maxConcurrentSessions ?? "10", 10);

  const twitterClient = new TwitterClient({
    apiKey,
    apiSecret,
    accessToken,
    accessTokenSecret,
    pollIntervalMs,
    logger: api.logger,
  });

  const accessControl = new AccessControl({ allowedUserIds });

  const sessionBridge = new SessionBridge({
    sessionFactory: sessionFactory ?? (() => { throw new Error("No sessionFactory configured"); }),
    maxConcurrentSessions: maxSessions,
    sessionTimeout: config.sessionTimeout ?? 300000,
  });

  const approvalHandler = new ApprovalHandler({
    twitterClient,
    apiBaseUrl,
    apiToken,
    logger: api.logger,
  });

  const journalRelay = journal
    ? new JournalRelay({ journal, twitterClient, sessionBridge, approvalHandler, logger: api.logger })
    : null;

  const commandHandler = new CommandHandler({
    twitterClient,
    sessionBridge,
    logger: api.logger,
  });

  // ── Pending task confirmations (senderId -> { taskText, expiresAt }) ──
  const pendingConfirmations = new Map();
  const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // ── Wire DM message handler ──
  twitterClient.onMessage(async ({ senderId, text }) => {
    // 1. Access control check
    if (!accessControl.isAllowed(senderId)) {
      api.logger.warn("Twitter DM rejected — sender not allowed", { senderId });
      return;
    }

    // 2. Check for pending approval reply (1/2/3)
    if (approvalHandler.isPendingReply(senderId, text)) {
      await approvalHandler.handleReply(senderId, text);
      return;
    }

    // 3. Check for text commands (status/cancel/help)
    if (commandHandler.isCommand(text)) {
      await commandHandler.handle(senderId, text);
      return;
    }

    // 4. Check if sender already has an active session
    if (sessionBridge.hasActiveSession(senderId)) {
      await twitterClient.sendDm({
        recipientId: senderId,
        text: "A session is already running. Send \"cancel\" to stop it, or \"status\" to check progress.",
      });
      return;
    }

    // 5. Check for confirmation of a pending task
    const pending = pendingConfirmations.get(senderId);
    if (pending && Date.now() < pending.expiresAt) {
      const reply = text.trim().toLowerCase();
      if (reply === "yes" || reply === "y" || reply === "confirm") {
        pendingConfirmations.delete(senderId);
        if (!sessionFactory) {
          await twitterClient.sendDm({ recipientId: senderId, text: "\u26A0\uFE0F KarnEvil9 session factory not configured" });
          return;
        }
        try {
          const result = await sessionBridge.createSession({ taskText: pending.taskText, sender: senderId });
          await twitterClient.sendDm({ recipientId: senderId, text: `\u2705 Session ${result.session_id} started` });
        } catch (err) {
          api.logger.error("Failed to create session from Twitter DM", { error: err.message });
          await twitterClient.sendDm({ recipientId: senderId, text: `\u274C Failed to start session: ${err.message}` });
        }
        return;
      } else if (reply === "no" || reply === "n" || reply === "cancel") {
        pendingConfirmations.delete(senderId);
        await twitterClient.sendDm({ recipientId: senderId, text: "Task cancelled." });
        return;
      }
      // Not yes/no — treat as new task request (fall through)
      pendingConfirmations.delete(senderId);
    } else if (pending) {
      pendingConfirmations.delete(senderId);
    }

    // 6. New task — require confirmation before creating session
    const taskText = text.trim();
    if (!taskText) return;

    pendingConfirmations.set(senderId, {
      taskText,
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    });

    const preview = taskText.length > 200 ? taskText.substring(0, 200) + "..." : taskText;
    await twitterClient.sendDm({
      recipientId: senderId,
      text: `\u2753 Run this task?\n\n"${preview}"\n\nReply YES to confirm or NO to cancel. (Expires in 5 min)`,
    });
  });

  // ── Register tools: post-tweet and send-twitter-dm ──
  api.registerTool(postTweetManifest, createPostTweetHandler(twitterClient));
  api.registerTool(sendTwitterDmManifest, createSendTwitterDmHandler(twitterClient));

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
      connected: twitterClient.connected,
      activeSessions: sessionBridge.activeCount,
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

  // ── Register service: twitter-connection ──
  api.registerService({
    name: "twitter-connection",
    async start() {
      await twitterClient.start();
      if (journalRelay) journalRelay.start();
      api.logger.info("Twitter connected via API v2");
    },
    async stop() {
      if (journalRelay) journalRelay.stop();
      approvalHandler.dispose();
      await twitterClient.stop();
      api.logger.info("Twitter disconnected");
    },
  });

  api.logger.info("Twitter plugin registered");
}

/**
 * Register stubs when Twitter is not enabled (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  api.registerTool(postTweetManifest, async (input, mode) => {
    if (mode === "mock") return { ok: true, tweet_id: "mock_tweet_id", text: input.text ?? "mock tweet" };
    return { ok: false, error: "Twitter not connected" };
  });

  api.registerTool(sendTwitterDmManifest, async (input, mode) => {
    if (mode === "mock") return { ok: true, dm_event_id: "mock_dm_id" };
    return { ok: false, error: "Twitter not connected" };
  });

  api.registerHook("after_session_end", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: false, activeSessions: 0, mode: "disabled" });
  });

  api.registerRoute("GET", "conversations", (_req, res) => {
    res.json({ activeSenders: [], sessions: [] });
  });

  api.registerService({
    name: "twitter-connection",
    async start() { api.logger.info("Twitter service stub — not enabled"); },
    async stop() {},
  });
}
