/**
 * Grok X Search Plugin — search and analyze X/Twitter posts via the xAI Grok Responses API.
 *
 * Follows the Claude Code/OpenAI Codex plugin pattern: tool registration, before_plan hook
 * for planner awareness, journal progress streaming, graceful degradation, and status routes.
 */
import {
  searchXManifest,
  analyzeXThreadManifest,
  createSearchXHandler,
  createAnalyzeXThreadHandler,
  abortSessionSearches,
  getActiveCount,
} from "./tool.js";

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Resolve API key (XAI_API_KEY or XAI_KEY, with config fallback) ──
  const apiKey = process.env.XAI_API_KEY ?? process.env.XAI_KEY ?? config.apiKey;
  const model = config.model ?? process.env.KARNEVIL9_GROK_MODEL;
  const journal = config.journal;

  if (!apiKey) {
    api.logger.warn("No XAI_API_KEY / XAI_KEY set — Grok Search plugin will register stubs (graceful degradation)");
    _registerStubs(api);
    return;
  }

  // ── Register tools ──
  const searchHandler = createSearchXHandler({ journal, apiKey, model });
  api.registerTool(searchXManifest, searchHandler);

  const analyzeHandler = createAnalyzeXThreadHandler({ journal, apiKey, model });
  api.registerTool(analyzeXThreadManifest, analyzeHandler);

  // ── Register hooks ──

  // before_plan: inform planner that Grok X search is available
  api.registerHook("before_plan", async () => {
    return {
      action: "modify",
      data: {
        grok_search_context: {
          available: true,
          hint: "You can use the search-x tool to search X/Twitter posts and the analyze-x-thread tool to analyze specific X posts/threads. Both use Grok with real-time X data access.",
          model: model ?? "grok-4-1-fast-reasoning",
        },
      },
    };
  });

  // before_tool_call: inject session/invocation IDs into both tool calls
  api.registerHook("before_tool_call", async (context) => {
    if (context.tool_name === "search-x" || context.tool_name === "analyze-x-thread") {
      return {
        action: "modify",
        data: {
          _session_id: context.session_id,
          _invocation_id: `${context.session_id}:${context.step_id}`,
        },
      };
    }
    return { action: "continue" };
  });

  // after_session_end: abort active searches when session is aborted
  api.registerHook("after_session_end", async (context) => {
    if (context.status === "aborted") {
      const aborted = abortSessionSearches(context.session_id);
      if (aborted > 0) {
        api.logger.info(`Aborted ${aborted} active Grok search(es) for session ${context.session_id}`);
      }
    }
    return { action: "observe" };
  });

  // ── Register routes ──
  api.registerRoute("GET", "status", (_req, res) => {
    res.json({
      available: true,
      model: model ?? "grok-4-1-fast-reasoning",
      active_searches: getActiveCount(),
    });
  });

  // ── Register service ──
  api.registerService({
    name: "grok-search",
    async start() {
      api.logger.info("Grok Search service ready", { model: model ?? "grok-4-1-fast-reasoning" });
    },
    async stop() {
      api.logger.info("Grok Search service stopped");
    },
    async health() {
      return {
        ok: true,
        detail: `API key configured, ${getActiveCount()} active search(es)`,
      };
    },
  });

  api.logger.info("Grok Search plugin registered");
}

/**
 * Register stubs when API key is missing (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  api.registerTool(searchXManifest, async (input, mode) => {
    if (mode === "mock") {
      return {
        status: "completed",
        result: `[mock] Grok would search X for: ${input.query}`,
        citations: [],
        search_calls: 0,
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    return {
      status: "failed",
      result: "Grok Search not configured — XAI_API_KEY not set",
      citations: [],
      search_calls: 0,
      is_error: true,
      duration_ms: 0,
      usage: {},
    };
  });

  api.registerTool(analyzeXThreadManifest, async (input, mode) => {
    if (mode === "mock") {
      return {
        status: "completed",
        result: `[mock] Grok would analyze X thread: ${input.url}`,
        citations: [],
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    return {
      status: "failed",
      result: "Grok Search not configured — XAI_API_KEY not set",
      citations: [],
      is_error: true,
      duration_ms: 0,
      usage: {},
    };
  });

  api.registerHook("before_plan", async () => ({ action: "continue" }));
  api.registerHook("before_tool_call", async () => ({ action: "continue" }));
  api.registerHook("after_session_end", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ available: false, reason: "XAI_API_KEY not set" });
  });

  api.registerService({
    name: "grok-search",
    async start() { api.logger.info("Grok Search stub — no API key configured"); },
    async stop() {},
    async health() { return { ok: false, detail: "Not configured" }; },
  });
}
