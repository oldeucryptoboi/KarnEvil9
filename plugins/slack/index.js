/**
 * Slack Integration Plugin — bidirectional Slack integration for Jarvis.
 *
 * Receives tasks via Slack messages/mentions, posts progress in threads,
 * handles interactive approval buttons, and exposes a send-slack-message tool.
 */
import { SlackApp } from "./slack-app.js";
import { SessionBridge } from "./session-bridge.js";
import { JournalRelay } from "./journal-relay.js";
import { ApprovalHandler } from "./approval-handler.js";
import { SlashCommand } from "./slash-command.js";
import { AccessControl } from "./access-control.js";
import { sendSlackMessageManifest, createSendSlackMessageHandler } from "./send-tool.js";

/**
 * @param {import("@jarvis/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Resolve Slack credentials (env vars with config fallback) ──
  const botToken = process.env.SLACK_BOT_TOKEN ?? config.slackBotToken;
  const appToken = process.env.SLACK_APP_TOKEN ?? config.slackAppToken;
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? config.slackSigningSecret;
  const mode = config.mode ?? "socket";

  if (!botToken) {
    api.logger.warn("No SLACK_BOT_TOKEN set — Slack plugin will not connect (graceful degradation)");
    // Still register tool/hooks/routes so plugin loads without crash
    _registerStubs(api);
    return;
  }

  if (mode === "socket" && !appToken) {
    api.logger.warn("Socket mode requires SLACK_APP_TOKEN — Slack plugin will not connect");
    _registerStubs(api);
    return;
  }

  if (mode === "http" && !signingSecret) {
    api.logger.warn("HTTP mode requires SLACK_SIGNING_SECRET — Slack plugin will not connect");
    _registerStubs(api);
    return;
  }

  // ── Resolve runtime dependencies ──
  const sessionFactory = config.sessionFactory;
  const journal = config.journal;
  const apiBaseUrl = config.apiBaseUrl ?? "http://localhost:3100";
  const apiToken = config.apiToken;

  if (!sessionFactory) {
    api.logger.warn("No sessionFactory provided — Slack will receive messages but cannot create sessions");
  }

  // ── Build components ──
  const slackApp = new SlackApp({
    botToken,
    appToken,
    signingSecret,
    mode,
    logger: api.logger,
  });

  const accessControl = new AccessControl({
    defaultRequireMention: config.defaultRequireMention ?? true,
    channelOverrides: config.channelOverrides ?? {},
  });

  const sessionBridge = new SessionBridge({
    sessionFactory: sessionFactory ?? (() => { throw new Error("No sessionFactory configured"); }),
    maxConcurrentSessions: config.maxConcurrentSessions ?? 10,
    sessionTimeout: config.sessionTimeout ?? 300000,
  });

  const approvalHandler = new ApprovalHandler({
    slackApp,
    apiBaseUrl,
    apiToken,
    logger: api.logger,
  });

  const journalRelay = journal
    ? new JournalRelay({ journal, slackApp, sessionBridge, approvalHandler, logger: api.logger })
    : null;

  const slashCommand = new SlashCommand({
    slackApp,
    sessionBridge,
    logger: api.logger,
  });

  // ── Initialize Slack app (must happen before registering handlers) ──
  await slackApp.init();

  // ── Wire message handlers ──
  const handleIncoming = async (event, say) => {
    // Skip bot messages
    if (event.bot_id || event.subtype === "bot_message") return;

    // Skip if message is in an existing session thread
    const threadTs = event.thread_ts ?? event.ts;
    if (event.thread_ts && sessionBridge.hasActiveSession(event.thread_ts)) return;

    const channelId = event.channel;
    const requireMention = accessControl.requiresMention(channelId);

    // For app_mention events, mention is always satisfied
    const isMention = event.type === "app_mention";
    if (requireMention && !isMention) return;

    // Strip mention from text
    let taskText = event.text ?? "";
    if (slackApp.botUserId) {
      taskText = accessControl.stripMention(taskText, slackApp.botUserId);
    }
    taskText = taskText.trim();
    if (!taskText) return;

    if (!sessionFactory) {
      await say({ text: ":warning: Jarvis session factory not configured", thread_ts: event.ts });
      return;
    }

    try {
      const result = await sessionBridge.createSession({
        taskText,
        channel: channelId,
        threadTs: event.ts,
        userId: event.user,
      });

      await say({
        text: `:white_check_mark: Session \`${result.session_id}\` started`,
        thread_ts: event.ts,
      });
    } catch (err) {
      api.logger.error("Failed to create session from Slack", { error: err.message });
      await say({
        text: `:x: Failed to start session: ${err.message}`,
        thread_ts: event.ts,
      });
    }
  };

  slackApp.onMention(handleIncoming);
  slackApp.onMessage(handleIncoming);

  // ── Register approval button handlers ──
  approvalHandler.registerActions();

  // ── Register slash command ──
  slashCommand.register();

  // ── Register tool: send-slack-message ──
  api.registerTool(sendSlackMessageManifest, createSendSlackMessageHandler(slackApp));

  // ── Register hook: after_session_end ──
  api.registerHook("after_session_end", async (context) => {
    // Clean up session mapping on session end (backup — journalRelay also handles this)
    if (context.session_id) {
      sessionBridge.removeSession(context.session_id);
    }
    return { action: "observe" };
  });

  // ── Register routes ──
  api.registerRoute("GET", "status", (req, res) => {
    res.json({
      connected: slackApp.connected,
      activeSessions: sessionBridge.activeCount,
      mode,
      botUserId: slackApp.botUserId,
    });
  });

  api.registerRoute("GET", "channels", (req, res) => {
    const sessions = sessionBridge.listSessions();
    const channels = [...new Set(sessions.map((s) => s.channel))];
    res.json({
      activeChannels: channels,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        channel: s.channel,
        userId: s.userId,
        elapsed: Math.round((Date.now() - s.startedAt) / 1000),
      })),
    });
  });

  // ── Register service: slack-connection ──
  api.registerService({
    name: "slack-connection",
    async start() {
      await slackApp.start();
      if (journalRelay) journalRelay.start();
      api.logger.info(`Slack connected (${mode} mode)`, { botUserId: slackApp.botUserId });
    },
    async stop() {
      if (journalRelay) journalRelay.stop();
      await slackApp.stop();
      api.logger.info("Slack disconnected");
    },
  });

  api.logger.info("Slack plugin registered");
}

/**
 * Register stubs when Slack tokens are missing (so plugin manifest validates).
 * @param {import("@jarvis/schemas").PluginApi} api
 */
function _registerStubs(api) {
  api.registerTool(sendSlackMessageManifest, async (input, mode) => {
    if (mode === "mock") return { ok: true, ts: "mock-ts", channel: input.channel ?? "C_MOCK" };
    return { ok: false, error: "Slack not connected" };
  });

  api.registerHook("after_session_end", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: false, activeSessions: 0, mode: "disabled" });
  });

  api.registerRoute("GET", "channels", (_req, res) => {
    res.json({ activeChannels: [], sessions: [] });
  });

  api.registerService({
    name: "slack-connection",
    async start() { api.logger.info("Slack service stub — no tokens configured"); },
    async stop() {},
  });
}
