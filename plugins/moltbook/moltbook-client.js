/**
 * MoltbookClient — HTTP client for Moltbook API v1.
 *
 * Bearer-token auth, verification challenge solver, advisory rate-limit tracking.
 * Zero external dependencies.
 */

const API_BASE = "https://www.moltbook.com/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;

export class MoltbookClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey - Moltbook API key (moltbook_sk_...)
   * @param {string} [opts.agentName] - Agent name on Moltbook
   * @param {object} [opts.logger] - Plugin logger
   */
  constructor({ apiKey, agentName, logger } = {}) {
    this.apiKey = apiKey;
    this.agentName = agentName ?? null;
    this.logger = logger;
    this.profile = null;
    this.connected = false;

    // Advisory rate-limit tracking (real enforcement is server-side)
    this._lastPostAt = 0;
    this._lastCommentAt = 0;
  }

  /**
   * Verify credentials and cache agent profile.
   */
  async init() {
    const res = await this._apiRequest("GET", "/agents/me");
    this.profile = res;
    this.agentName = res.name ?? res.agent?.name ?? this.agentName;
    this.connected = true;
    this.logger?.info("Moltbook connected", { agent: this.agentName });
    return res;
  }

  // ── Posts ──

  /**
   * Create a post, auto-solving the verification challenge.
   * @param {object} opts
   * @param {string} opts.submolt - Submolt name
   * @param {string} opts.title - Post title
   * @param {string} [opts.content] - Post body text
   * @param {string} [opts.url] - Link URL (for link posts)
   * @returns {Promise<object>} Created post
   */
  async createPost({ submolt, title, content, url }) {
    const body = { submolt, title };
    if (content) body.content = content;
    if (url) body.url = url;

    const res = await this._apiRequest("POST", "/posts", body);
    this._lastPostAt = Date.now();

    // Auto-solve verification if present
    if (res.post?.verification) {
      await this._solveVerification(res.post.verification);
    }

    return res;
  }

  // ── Comments ──

  /**
   * Create a comment on a post, auto-solving verification.
   * @param {object} opts
   * @param {string} opts.postId - Post ID
   * @param {string} opts.content - Comment text
   * @param {string} [opts.parentId] - Parent comment ID (for threaded replies)
   * @returns {Promise<object>} Created comment
   */
  async createComment({ postId, content, parentId }) {
    const body = { content };
    if (parentId) body.parent_id = parentId;

    const res = await this._apiRequest("POST", `/posts/${postId}/comments`, body);
    this._lastCommentAt = Date.now();

    // Auto-solve verification if present
    const comment = res.comment ?? res;
    if (comment?.verification) {
      await this._solveVerification(comment.verification);
    }

    return res;
  }

  // ── Votes ──

  /**
   * Upvote or downvote a post or comment.
   * @param {object} opts
   * @param {"post"|"comment"} opts.targetType
   * @param {string} opts.targetId
   * @param {"up"|"down"} opts.direction
   * @returns {Promise<object>}
   */
  async vote({ targetType, targetId, direction }) {
    const action = direction === "up" ? "upvote" : "downvote";

    if (targetType === "post") {
      return this._apiRequest("POST", `/posts/${targetId}/${action}`);
    } else {
      return this._apiRequest("POST", `/comments/${targetId}/${action}`);
    }
  }

  // ── Feeds ──

  /**
   * Get a feed of posts.
   * @param {object} [opts]
   * @param {"home"|"submolt"|"global"} [opts.source] - Feed source (default: home)
   * @param {string} [opts.submolt] - Submolt name (required if source=submolt)
   * @param {"hot"|"new"|"top"|"rising"} [opts.sort]
   * @param {number} [opts.limit]
   * @param {string} [opts.cursor]
   * @returns {Promise<object>}
   */
  async getFeed({ source = "home", submolt, sort, limit, cursor } = {}) {
    const queryParams = {};
    if (sort) queryParams.sort = sort;
    if (limit) queryParams.limit = String(limit);
    if (cursor) queryParams.cursor = cursor;

    if (source === "submolt" && submolt) {
      return this._apiRequest("GET", `/submolts/${submolt}/feed`, null, queryParams);
    } else if (source === "global") {
      return this._apiRequest("GET", "/posts", null, queryParams);
    } else {
      // home feed
      return this._apiRequest("GET", "/feed", null, queryParams);
    }
  }

  // ── Search ──

  /**
   * Search posts and comments.
   * @param {object} opts
   * @param {string} opts.query - Search query (natural language, max 500 chars)
   * @param {"posts"|"comments"|"all"} [opts.type]
   * @param {number} [opts.limit]
   * @returns {Promise<object>}
   */
  async search({ query, type, limit }) {
    const queryParams = { q: query };
    if (type) queryParams.type = type;
    if (limit) queryParams.limit = String(limit);

    return this._apiRequest("GET", "/search", null, queryParams);
  }

  // ── Home (heartbeat) ──

  /**
   * Get home dashboard — used as heartbeat.
   * @returns {Promise<object>}
   */
  async getHome() {
    return this._apiRequest("GET", "/home");
  }

  // ── Advisory rate-limit helpers ──

  /**
   * Advisory check: can we post? (30 min cooldown)
   */
  canPost() {
    return Date.now() - this._lastPostAt >= 30 * 60 * 1000;
  }

  /**
   * Advisory check: can we comment? (20 sec cooldown)
   */
  canComment() {
    return Date.now() - this._lastCommentAt >= 20 * 1000;
  }

  // ── Verification Solver ──

  /**
   * Solve a Moltbook verification challenge.
   * Parses the math expression from challenge_text, computes the answer
   * with safe arithmetic (no eval), and submits it.
   *
   * @param {object} verification
   * @param {string} verification.verification_code
   * @param {string} verification.challenge_text
   */
  async _solveVerification(verification) {
    const { verification_code, challenge_text } = verification;

    if (!verification_code || !challenge_text) {
      this.logger?.warn("Verification challenge missing code or text", { verification });
      return;
    }

    const answer = solveMathChallenge(challenge_text);
    if (answer === null) {
      this.logger?.error("Failed to solve verification challenge", { challenge_text });
      return;
    }

    const formatted = answer.toFixed(2);
    this.logger?.info("Solving verification", { verification_code, answer: formatted });

    try {
      const res = await this._apiRequest("POST", "/verify", {
        verification_code,
        answer: formatted,
      });
      this.logger?.info("Verification solved", { res });
      return res;
    } catch (err) {
      this.logger?.error("Verification submission failed", { error: err.message });
      throw err;
    }
  }

  // ── HTTP ──

  /**
   * Make an authenticated API request.
   * @param {string} method - HTTP method
   * @param {string} path - API path (e.g. "/posts")
   * @param {object} [body] - JSON body
   * @param {object} [queryParams] - URL query parameters
   * @returns {Promise<object>}
   */
  async _apiRequest(method, path, body = null, queryParams = {}) {
    let url = `${API_BASE}${path}`;

    const queryEntries = Object.entries(queryParams).filter(([, v]) => v != null);
    if (queryEntries.length > 0) {
      const qs = queryEntries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      url += `?${qs}`;
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    const fetchOpts = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    if (body) {
      headers["Content-Type"] = "application/json";
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOpts);

    // Handle rate limiting
    if (res.status === 429) {
      const errorBody = await res.json().catch(() => ({}));
      const retryAfter = errorBody.retry_after_minutes ?? errorBody.retry_after_seconds ?? null;
      const err = new Error(
        `Moltbook rate limit hit: ${method} ${path} — retry after ${retryAfter ?? "unknown"}`
      );
      err.status = 429;
      err.retryAfter = retryAfter;
      err.body = errorBody;
      throw err;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Moltbook API ${method} ${path} failed (${res.status}): ${text}`);
    }

    if (res.status === 204) return {};

    return await res.json();
  }
}

// ── Safe math challenge solver ──

/**
 * Parse and solve a math expression from a verification challenge.
 * Supports +, -, *, / and parentheses. Uses a simple recursive-descent parser
 * instead of eval() for safety.
 *
 * @param {string} challengeText - The challenge_text from the verification object
 * @returns {number|null} The computed answer, or null if parsing failed
 */
export function solveMathChallenge(challengeText) {
  // Extract the math expression — look for patterns like "What is 3 + 4 * 2?"
  // or "Calculate: (10 + 5) / 3" or just a raw expression
  const cleaned = challengeText
    .replace(/what\s+is/gi, "")
    .replace(/calculate:?/gi, "")
    .replace(/solve:?/gi, "")
    .replace(/compute:?/gi, "")
    .replace(/\?/g, "")
    .trim();

  // Extract just the math part: numbers, operators, parentheses, decimal points, spaces
  const mathMatch = cleaned.match(/[\d+\-*/().×÷\s]+/);
  if (!mathMatch) return null;

  let expr = mathMatch[0]
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/\s+/g, "")
    .trim();

  if (!expr) return null;

  try {
    return parseExpression(expr);
  } catch {
    return null;
  }
}

/**
 * Recursive-descent parser for arithmetic expressions.
 * Grammar:
 *   expr   = term (('+' | '-') term)*
 *   term   = factor (('*' | '/') factor)*
 *   factor = '-' factor | '(' expr ')' | number
 */
function parseExpression(str) {
  let pos = 0;

  function parseExpr() {
    let left = parseTerm();
    while (pos < str.length && (str[pos] === "+" || str[pos] === "-")) {
      const op = str[pos++];
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (pos < str.length && (str[pos] === "*" || str[pos] === "/")) {
      const op = str[pos++];
      const right = parseFactor();
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseFactor() {
    // Unary minus
    if (str[pos] === "-") {
      pos++;
      return -parseFactor();
    }

    // Parenthesized expression
    if (str[pos] === "(") {
      pos++; // skip '('
      const val = parseExpr();
      if (str[pos] === ")") pos++; // skip ')'
      return val;
    }

    // Number (integer or decimal)
    const start = pos;
    while (pos < str.length && (str[pos] >= "0" && str[pos] <= "9" || str[pos] === ".")) {
      pos++;
    }
    if (pos === start) {
      throw new Error(`Unexpected character at position ${pos}: '${str[pos]}'`);
    }
    return parseFloat(str.slice(start, pos));
  }

  const result = parseExpr();

  if (pos < str.length) {
    throw new Error(`Unexpected character at position ${pos}: '${str[pos]}'`);
  }

  return result;
}
