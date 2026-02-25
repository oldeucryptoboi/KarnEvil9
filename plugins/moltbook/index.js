/**
 * Moltbook Integration Plugin — post, comment, vote, browse, DM, follow, and
 * manage notifications on Moltbook.
 *
 * Registers 9 tools, a before_plan hook (injects Moltbook context),
 * a GET status route, and a heartbeat service.
 */
import { MoltbookClient } from "./moltbook-client.js";
import { HeartbeatService } from "./heartbeat-service.js";
import {
  moltbookPostManifest, createPostHandler,
  moltbookCommentManifest, createCommentHandler,
  moltbookVoteManifest, createVoteHandler,
  moltbookGetPostManifest, createGetPostHandler,
  moltbookFeedManifest, createFeedHandler,
  moltbookSearchManifest, createSearchHandler,
  moltbookDmManifest, createDmHandler,
  moltbookFollowManifest, createFollowHandler,
  moltbookNotificationsManifest, createNotificationsHandler,
  allManifests,
} from "./tools.js";

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Resolve credentials ──
  const apiKey = process.env.MOLTBOOK_API_KEY ?? config.apiKey;

  if (!apiKey) {
    api.logger.warn("MOLTBOOK_API_KEY not set — Moltbook plugin will not connect (graceful degradation)");
    _registerStubs(api);
    return;
  }

  const agentName = process.env.MOLTBOOK_AGENT_NAME ?? config.agentName;

  // ── Build client and init ──
  const client = new MoltbookClient({
    apiKey,
    agentName,
    logger: api.logger,
  });

  try {
    await client.init();
  } catch (err) {
    api.logger.error("Moltbook init failed — registering stubs", { error: err.message });
    _registerStubs(api);
    return;
  }

  // ── Build heartbeat service ──
  const heartbeat = new HeartbeatService({ client, logger: api.logger });

  // ── Register tools ──
  api.registerTool(moltbookPostManifest, createPostHandler(client));
  api.registerTool(moltbookCommentManifest, createCommentHandler(client));
  api.registerTool(moltbookVoteManifest, createVoteHandler(client));
  api.registerTool(moltbookGetPostManifest, createGetPostHandler(client));
  api.registerTool(moltbookFeedManifest, createFeedHandler(client));
  api.registerTool(moltbookSearchManifest, createSearchHandler(client));
  api.registerTool(moltbookDmManifest, createDmHandler(client));
  api.registerTool(moltbookFollowManifest, createFollowHandler(client));
  api.registerTool(moltbookNotificationsManifest, createNotificationsHandler(client));

  // ── Register hook: before_plan ──
  api.registerHook("before_plan", async (context) => {
    const hb = heartbeat.health();
    const karma = hb.lastResponse?.your_account?.karma ?? "unknown";
    const unread = hb.lastResponse?.your_account?.unread_notification_count ?? 0;

    const hints = [
      // Identity & status
      `[Moltbook] You are Eddie (E.D.D.I.E.), posting as "${client.agentName}" on Moltbook (social network for AI agents). ` +
      `Karma: ${karma}. Unread notifications: ${unread}. ` +
      `Can post: ${client.canPost()}, Can comment: ${client.canComment()}.`,

      // Engagement strategy
      `[Moltbook Strategy] When engaging on Moltbook:\n` +
      `- Before replying to a post/comment, ALWAYS read it first with moltbook-get-post to understand the full context.\n` +
      `- When browsing, use moltbook-feed to see what's active, then moltbook-get-post for posts you want to engage with.\n` +
      `- For research-then-post tasks: gather information first (read-file, claude-code), then compose and post in a later iteration.\n` +
      `- Write substantive, technically accurate content. Be direct and confident — avoid hedging or filler.\n` +
      `- When replying, reference specific points from the post/comment you're responding to.\n` +
      `- Don't force engagement — if nothing is interesting or you have nothing meaningful to add, do nothing.`,

      // DM strategy
      `[Moltbook DMs] You can manage direct messages with moltbook-dm:\n` +
      `- list_requests: See pending DM requests from other agents.\n` +
      `- approve / reject: Accept or decline DM requests (use reject with block:true for spam).\n` +
      `- list_conversations: See all active DM threads.\n` +
      `- get_conversation: Read messages in a specific thread.\n` +
      `- send: Reply in a conversation.\n` +
      `Approach DMs conversationally — these are 1-on-1 dialogues, not public broadcasts. ` +
      `Be genuine, ask follow-up questions, and engage with what the other agent is saying.`,

      // Follow strategy
      `[Moltbook Follows] Use moltbook-follow to follow/unfollow agents.\n` +
      `- Follow agents who consistently post quality content or engage in interesting discussions.\n` +
      `- Following builds your home feed — follow agents whose content you want to see regularly.\n` +
      `- Don't mass-follow; be selective and intentional.`,

      // Notification strategy
      `[Moltbook Notifications] Use moltbook-notifications to manage notifications:\n` +
      `- list: See all unread notifications (replies, mentions, follows, votes).\n` +
      `- mark_read: Mark all notifications as read after processing them.\n` +
      `- mark_post_read: Mark notifications for a specific post as read.\n` +
      `Prioritize replying to direct replies and mentions. Votes and new followers are informational only.`,
    ];

    // Contextual notification urgency
    if (unread > 0) {
      hints.push(
        `[Moltbook] You have ${unread} unread notification(s). ` +
        `Use moltbook-notifications (list) to see what needs attention, then act on anything requiring a response.`
      );
    }

    return { action: "modify", data: { hints } };
  });

  // ── Register route: GET status ──
  api.registerRoute("GET", "status", (_req, res) => {
    const hb = heartbeat.health();
    res.json({
      connected: client.connected,
      agent: client.agentName,
      canPost: client.canPost(),
      canComment: client.canComment(),
      heartbeat: {
        ok: hb.ok,
        lastCheckedAt: hb.lastCheckedAt,
        errorCount: hb.errorCount,
      },
      karma: hb.lastResponse?.your_account?.karma ?? null,
      unreadNotifications: hb.lastResponse?.your_account?.unread_notification_count ?? 0,
    });
  });

  // ── Register service: moltbook-heartbeat ──
  api.registerService({
    name: "moltbook-heartbeat",
    async start() {
      heartbeat.start();
      api.logger.info("Moltbook heartbeat service started");
    },
    async stop() {
      heartbeat.stop();
      api.logger.info("Moltbook heartbeat service stopped");
    },
  });

  // ── Auto-schedule default Moltbook tasks ──
  if (config.autoSchedule && config.scheduler) {
    const { defaultSchedules } = await import("./schedules.js");
    for (const sched of defaultSchedules) {
      try {
        const exists = config.scheduler.getSchedule?.(sched.name);
        if (!exists) {
          config.scheduler.createSchedule(sched);
          api.logger.info(`Moltbook schedule created: ${sched.name}`);
        }
      } catch (err) {
        api.logger.warn(`Failed to create schedule ${sched.name}`, { error: err.message });
      }
    }
  }

  api.logger.info("Moltbook plugin registered", { agent: client.agentName });
}

/**
 * Register stubs when Moltbook is not enabled (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  for (const manifest of allManifests) {
    api.registerTool(manifest, async (input, mode) => {
      if (mode === "mock") return { ok: true, ...(manifest.mock_responses?.[0] ?? {}) };
      return { ok: false, error: "Moltbook not connected" };
    });
  }

  api.registerHook("before_plan", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: false, agent: null, mode: "disabled" });
  });

  api.registerService({
    name: "moltbook-heartbeat",
    async start() { api.logger.info("Moltbook heartbeat stub — not enabled"); },
    async stop() {},
  });
}
