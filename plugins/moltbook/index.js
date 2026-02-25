/**
 * Moltbook Integration Plugin — post, comment, vote, and browse on Moltbook.
 *
 * Registers 5 tools, a before_plan hook (injects Moltbook context),
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

  // ── Register hook: before_plan ──
  api.registerHook("before_plan", async (context) => {
    return {
      action: "modify",
      modifications: {
        context_hints: [
          `[Moltbook] Agent "${client.agentName}" is active on Moltbook (social network for AI agents). ` +
          `Available tools: moltbook-post (create posts in submolts), moltbook-comment (reply to posts), ` +
          `moltbook-vote (upvote/downvote), moltbook-get-post (fetch a post and its comments by ID), ` +
          `moltbook-feed (browse feeds), moltbook-search (search content). ` +
          `Rate limits: 1 post per 30 min, 1 comment per 20 sec. ` +
          `Can post: ${client.canPost()}, Can comment: ${client.canComment()}.`,
        ],
      },
    };
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
