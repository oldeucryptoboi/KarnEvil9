/**
 * Grok X Search tools — manifests and handler factories.
 *
 * Uses the xAI Grok Responses API (POST https://api.x.ai/v1/responses)
 * with server-side x_search and web_search tools.
 *
 * Patterns adopted from warmlink/smokeshop:
 * - Post ID extraction from URL for more reliable fetching
 * - Structured JSON prompts for deterministic parsing
 * - Retry with exponential backoff on transient errors
 * - JSON response parsing that handles markdown fences and broken control chars
 * - XAI_KEY env var fallback (smokeshop convention)
 */
import { emitSearchEvent } from "./progress.js";

const GROK_API_URL = "https://api.x.ai/v1/responses";
const DEFAULT_MODEL = "grok-4-1-fast-reasoning";
const MAX_RETRY_ATTEMPTS = 3;

/** @type {Map<string, AbortController>} Active search invocations keyed by invocation ID */
const _activeSearches = new Map();

// ─── Retry & Parsing Utilities ────────────────────────────────────

/**
 * Check if an error is transient and worth retrying.
 * Matches the smokeshop pattern: network errors, rate limits, 5xx.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function _isTransientError(err) {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Network / fetch failures
  if (msg.includes("fetch failed") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) return true;
  // HTTP 429 (rate limit) and 5xx (server errors)
  if (/Grok API (429|5\d\d)/.test(msg)) return true;
  return false;
}

/**
 * Retry a function on transient errors with exponential backoff (2^attempt seconds).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number; label?: string }} opts
 * @returns {Promise<T>}
 */
async function _retryOnTransient(fn, { maxAttempts = MAX_RETRY_ATTEMPTS, label = "API call" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!_isTransientError(err)) throw err;
      lastErr = err;
      if (attempt + 1 < maxAttempts) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Parse JSON from Grok response, handling markdown fences and broken control chars.
 * Adopted from smokeshop's _parse_json_response.
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function _parseJsonResponse(text) {
  if (!text) return null;

  // Try markdown code fence first
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : text;

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Fix literal control chars that break JSON parsing
    let fixed = jsonStr;
    fixed = fixed.replace(/(?<!\\)\n/g, "\\n");
    fixed = fixed.replace(/\r/g, "\\r");
    fixed = fixed.replace(/\t/g, "\\t");
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

/**
 * Extract post ID from an X/Twitter URL.
 *
 * @param {string} url
 * @returns {string | null}
 */
function _extractPostId(url) {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Resolve the xAI API key from multiple sources (XAI_API_KEY, XAI_KEY, config).
 *
 * @param {string | undefined} configKey
 * @returns {string | undefined}
 */
function _resolveApiKey(configKey) {
  return configKey ?? process.env.XAI_API_KEY ?? process.env.XAI_KEY;
}

// ─── Tool Manifests ───────────────────────────────────────────────

export const searchXManifest = {
  name: "search-x",
  version: "1.0.0",
  description: "Search X/Twitter posts using Grok. Returns analysis and citations.",
  runner: "internal",
  timeout_ms: 120000,
  input_schema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search query for X posts" },
      handles: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "X handles to restrict search to (without @)",
      },
      excluded_handles: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "X handles to exclude from search (without @)",
      },
      from_date: { type: "string", description: "Start date filter (YYYY-MM-DD)" },
      to_date: { type: "string", description: "End date filter (YYYY-MM-DD)" },
      include_web: { type: "boolean", description: "Also search the web (default: false)" },
      _session_id: { type: "string", description: "Auto-injected by before_tool_call hook" },
      _invocation_id: { type: "string", description: "Auto-injected by before_tool_call hook" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "failed"] },
      result: { type: "string" },
      citations: { type: "array", items: { type: "object" } },
      search_calls: { type: "number" },
      is_error: { type: "boolean" },
      duration_ms: { type: "number" },
      usage: { type: "object" },
    },
  },
  permissions: ["search:read:x_posts"],
  supports: { mock: true, dry_run: true },
};

export const analyzeXThreadManifest = {
  name: "analyze-x-thread",
  version: "1.0.0",
  description: "Analyze a specific X/Twitter post or thread. Provide a post URL and optional question.",
  runner: "internal",
  timeout_ms: 120000,
  input_schema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", description: "X post URL (e.g. https://x.com/user/status/123)" },
      question: { type: "string", description: "Optional question to answer about the post/thread" },
      _session_id: { type: "string", description: "Auto-injected by before_tool_call hook" },
      _invocation_id: { type: "string", description: "Auto-injected by before_tool_call hook" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "failed"] },
      result: { type: "string" },
      structured: { type: "object", description: "Parsed JSON data when available" },
      citations: { type: "array", items: { type: "object" } },
      is_error: { type: "boolean" },
      duration_ms: { type: "number" },
      usage: { type: "object" },
    },
  },
  permissions: ["search:read:x_posts"],
  supports: { mock: true, dry_run: true },
};

// ─── Shared API Helper ────────────────────────────────────────────

/**
 * Call the xAI Grok Responses API with retry on transient errors.
 *
 * @param {{ apiKey: string; model: string; input: Array<{role: string; content: string}>; tools: Array<Record<string, unknown>>; signal?: AbortSignal }} opts
 * @returns {Promise<{ result: string; citations: Array<Record<string, unknown>>; search_calls: number; usage: Record<string, unknown> }>}
 */
async function _callGrokResponses({ apiKey, model, input, tools, signal }) {
  const doFetch = async () => {
    const response = await fetch(GROK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input, tools }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Grok API ${response.status}: ${errorText || response.statusText}`);
    }

    return response.json();
  };

  const data = await _retryOnTransient(doFetch, { label: "Grok Responses API" });

  // Extract result text and citations from output array
  let result = "";
  /** @type {Array<Record<string, unknown>>} */
  const citations = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const block of item.content) {
          // Grok Responses API uses "output_text" for content blocks
          if ((block.type === "output_text" || block.type === "text") && block.text) {
            result += block.text;
          }
          // Citations are in annotations within content blocks
          if (Array.isArray(block.annotations)) {
            for (const ann of block.annotations) {
              citations.push(ann);
            }
          }
        }
      } else if (item.type === "message" && typeof item.content === "string") {
        result += item.content;
      }
    }
  }

  // Also check top-level citations (fallback)
  if (citations.length === 0 && Array.isArray(data.citations)) {
    citations.push(...data.citations);
  }

  // Extract search call count from usage.server_side_tool_usage_details or top-level
  let searchCalls = 0;
  const toolUsage = data.usage?.server_side_tool_usage_details ?? data.server_side_tool_usage;
  if (toolUsage) {
    searchCalls = (toolUsage.x_search_calls ?? 0) + (toolUsage.web_search_calls ?? 0);
  }

  // Extract usage
  const usage = data.usage ?? {};

  return { result, citations, search_calls: searchCalls, usage };
}

// ─── Handler Factories ────────────────────────────────────────────

/**
 * Create a search-x tool handler.
 *
 * @param {{ journal: import("@karnevil9/journal").Journal; apiKey?: string; model?: string }} opts
 * @returns {(input: Record<string, unknown>, mode: string) => Promise<Record<string, unknown>>}
 */
export function createSearchXHandler({ journal, apiKey, model }) {
  const resolvedApiKey = _resolveApiKey(apiKey);
  const resolvedModel = model ?? process.env.KARNEVIL9_GROK_MODEL ?? DEFAULT_MODEL;

  return async (input, mode) => {
    const query = /** @type {string} */ (input.query);
    const sessionId = /** @type {string} */ (input._session_id ?? "unknown");
    const invocationId = /** @type {string} */ (input._invocation_id ?? `${sessionId}:${Date.now()}`);

    // Mock mode
    if (mode === "mock") {
      return {
        status: "completed",
        result: `[mock] Grok would search X for: ${query}`,
        citations: [],
        search_calls: 0,
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    // Dry-run mode
    if (mode === "dry_run") {
      return {
        status: "completed",
        result: `[dry_run] Would search X via Grok (model: ${resolvedModel}): ${query}`,
        citations: [],
        search_calls: 0,
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    // Real mode
    if (!resolvedApiKey) {
      return {
        status: "failed",
        result: "XAI_API_KEY / XAI_KEY not set — cannot invoke Grok search",
        citations: [],
        search_calls: 0,
        is_error: true,
        duration_ms: 0,
        usage: {},
      };
    }

    const startTime = Date.now();
    const ac = new AbortController();
    _activeSearches.set(invocationId, ac);

    // Internal timeout (slightly under tool timeout for clean shutdown)
    const internalTimeout = setTimeout(() => ac.abort(), 110000);

    try {
      await emitSearchEvent(journal, sessionId, "agent.started", {
        agent_type: "grok-search",
        tool: "search-x",
        query,
        model: resolvedModel,
        invocation_id: invocationId,
      });

      // Build x_search tool config
      /** @type {Record<string, unknown>} */
      const xSearchTool = { type: "x_search" };
      if (input.handles && /** @type {string[]} */ (input.handles).length > 0) {
        xSearchTool.allowed_x_handles = input.handles;
      }
      if (input.excluded_handles && /** @type {string[]} */ (input.excluded_handles).length > 0) {
        xSearchTool.excluded_x_handles = input.excluded_handles;
      }
      if (input.from_date) xSearchTool.from_date = input.from_date;
      if (input.to_date) xSearchTool.to_date = input.to_date;

      const tools = [xSearchTool];
      if (input.include_web) {
        tools.push({ type: "web_search" });
      }

      const apiResult = await _callGrokResponses({
        apiKey: resolvedApiKey,
        model: resolvedModel,
        input: [{ role: "user", content: query }],
        tools,
        signal: ac.signal,
      });

      const duration = Date.now() - startTime;

      await emitSearchEvent(journal, sessionId, "agent.completed", {
        agent_type: "grok-search",
        tool: "search-x",
        invocation_id: invocationId,
        duration_ms: duration,
        search_calls: apiResult.search_calls,
        citations_count: apiResult.citations.length,
      });

      return {
        status: "completed",
        result: apiResult.result,
        citations: apiResult.citations,
        search_calls: apiResult.search_calls,
        is_error: false,
        duration_ms: duration,
        usage: apiResult.usage,
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (ac.signal.aborted) {
        await emitSearchEvent(journal, sessionId, "agent.aborted", {
          agent_type: "grok-search",
          tool: "search-x",
          invocation_id: invocationId,
          duration_ms: duration,
        });
        return {
          status: "failed",
          result: "Search was aborted",
          citations: [],
          search_calls: 0,
          is_error: true,
          duration_ms: duration,
          usage: {},
        };
      }

      await emitSearchEvent(journal, sessionId, "agent.failed", {
        agent_type: "grok-search",
        tool: "search-x",
        invocation_id: invocationId,
        error: errorMessage,
        duration_ms: duration,
      });

      return {
        status: "failed",
        result: errorMessage,
        citations: [],
        search_calls: 0,
        is_error: true,
        duration_ms: duration,
        usage: {},
      };
    } finally {
      clearTimeout(internalTimeout);
      _activeSearches.delete(invocationId);
    }
  };
}

/**
 * Create an analyze-x-thread tool handler.
 *
 * Uses structured JSON prompts with post ID extraction (adopted from smokeshop).
 * When no question is provided, asks Grok for structured JSON with specific fields.
 *
 * @param {{ journal: import("@karnevil9/journal").Journal; apiKey?: string; model?: string }} opts
 * @returns {(input: Record<string, unknown>, mode: string) => Promise<Record<string, unknown>>}
 */
export function createAnalyzeXThreadHandler({ journal, apiKey, model }) {
  const resolvedApiKey = _resolveApiKey(apiKey);
  const resolvedModel = model ?? process.env.KARNEVIL9_GROK_MODEL ?? DEFAULT_MODEL;

  return async (input, mode) => {
    const url = /** @type {string} */ (input.url);
    const question = /** @type {string|undefined} */ (input.question);
    const sessionId = /** @type {string} */ (input._session_id ?? "unknown");
    const invocationId = /** @type {string} */ (input._invocation_id ?? `${sessionId}:${Date.now()}`);

    // Mock mode
    if (mode === "mock") {
      return {
        status: "completed",
        result: `[mock] Grok would analyze X thread: ${url}`,
        structured: null,
        citations: [],
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    // Dry-run mode
    if (mode === "dry_run") {
      return {
        status: "completed",
        result: `[dry_run] Would analyze X thread via Grok (model: ${resolvedModel}): ${url}`,
        structured: null,
        citations: [],
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    // Real mode
    if (!resolvedApiKey) {
      return {
        status: "failed",
        result: "XAI_API_KEY / XAI_KEY not set — cannot invoke Grok search",
        structured: null,
        citations: [],
        is_error: true,
        duration_ms: 0,
        usage: {},
      };
    }

    const startTime = Date.now();
    const ac = new AbortController();
    _activeSearches.set(invocationId, ac);

    const internalTimeout = setTimeout(() => ac.abort(), 110000);

    try {
      await emitSearchEvent(journal, sessionId, "agent.started", {
        agent_type: "grok-search",
        tool: "analyze-x-thread",
        url,
        model: resolvedModel,
        invocation_id: invocationId,
      });

      // Extract post ID from URL for more direct fetching (adopted from smokeshop)
      const postId = _extractPostId(url);

      let prompt;
      if (question) {
        // Free-form question mode — let Grok answer naturally
        prompt = postId
          ? `Find tweet/post with ID ${postId} and top 5 replies. `
            + `Also look up the post author's profile bio and follower count. `
            + `Then answer this question about the post: ${question}`
          : `Analyze this X post/thread and answer the following question: ${question}\n\nPost URL: ${url}`;
      } else {
        // Structured mode — request specific JSON fields (adopted from smokeshop)
        prompt = postId
          ? `Find tweet/post with ID ${postId} and top 5 replies. `
            + `Also look up the post author's profile bio and follower count. `
            + `If the author has no bio set, write a brief 1-2 sentence description of who they are. `
            + `Return complete valid JSON with fields: `
            + `author ({display_name, username, bio, followers}), text, created_at, `
            + `likes, retweets, replies_count, `
            + `replies (array of {author: {display_name, username}, text, likes}).`
          : `Analyze this X post/thread in detail. Summarize the content, key points, engagement, `
            + `and any notable replies or context.\n\nPost URL: ${url}`;
      }

      const apiResult = await _callGrokResponses({
        apiKey: resolvedApiKey,
        model: resolvedModel,
        input: [{ role: "user", content: prompt }],
        tools: [{ type: "x_search" }],
        signal: ac.signal,
      });

      const duration = Date.now() - startTime;

      // Try to parse structured JSON from the response (smokeshop pattern)
      const structured = _parseJsonResponse(apiResult.result);

      await emitSearchEvent(journal, sessionId, "agent.completed", {
        agent_type: "grok-search",
        tool: "analyze-x-thread",
        invocation_id: invocationId,
        duration_ms: duration,
        citations_count: apiResult.citations.length,
        has_structured: structured !== null,
      });

      return {
        status: "completed",
        result: apiResult.result,
        structured,
        citations: apiResult.citations,
        is_error: false,
        duration_ms: duration,
        usage: apiResult.usage,
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (ac.signal.aborted) {
        await emitSearchEvent(journal, sessionId, "agent.aborted", {
          agent_type: "grok-search",
          tool: "analyze-x-thread",
          invocation_id: invocationId,
          duration_ms: duration,
        });
        return {
          status: "failed",
          result: "Analysis was aborted",
          structured: null,
          citations: [],
          is_error: true,
          duration_ms: duration,
          usage: {},
        };
      }

      await emitSearchEvent(journal, sessionId, "agent.failed", {
        agent_type: "grok-search",
        tool: "analyze-x-thread",
        invocation_id: invocationId,
        error: errorMessage,
        duration_ms: duration,
      });

      return {
        status: "failed",
        result: errorMessage,
        structured: null,
        citations: [],
        is_error: true,
        duration_ms: duration,
        usage: {},
      };
    } finally {
      clearTimeout(internalTimeout);
      _activeSearches.delete(invocationId);
    }
  };
}

/**
 * Abort all active Grok searches for a session.
 * @param {string} sessionId
 * @returns {number} Number of searches aborted
 */
export function abortSessionSearches(sessionId) {
  let count = 0;
  for (const [id, ac] of _activeSearches) {
    if (id.startsWith(sessionId + ":")) {
      ac.abort();
      count++;
    }
  }
  return count;
}

/**
 * Get count of active search invocations.
 * @returns {number}
 */
export function getActiveCount() {
  return _activeSearches.size;
}
