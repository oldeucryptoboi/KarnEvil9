/**
 * MoltbookClient — HTTP client for Moltbook API v1.
 *
 * Bearer-token auth, verification challenge solver (deterministic + LLM fallback),
 * SQLite challenge corpus for regression testing, advisory rate-limit tracking.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const API_BASE = process.env.MOLTBOOK_API_BASE_URL || "https://www.moltbook.com/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const _require = createRequire(import.meta.url);

/** Lazy-require better-sqlite3 — returns constructor or null if not installed. */
function _requireBetterSqlite3() {
  try {
    return _require("better-sqlite3");
  } catch {
    return null;
  }
}

export class MoltbookClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey - Moltbook API key (moltbook_sk_...)
   * @param {string} [opts.agentName] - Agent name on Moltbook
   * @param {object} [opts.logger] - Plugin logger
   * @param {((prompt: string) => Promise<string>)|null} [opts.llmCall] - LLM fallback for verification solver
   * @param {string} [opts.dataDir] - Directory for challenge corpus DB
   */
  constructor({ apiKey, agentName, logger, llmCall, dataDir } = {}) {
    this.apiKey = apiKey;
    this.agentName = agentName ?? null;
    this.logger = logger;
    this.profile = null;
    this.connected = false;

    // LLM fallback for verification challenges
    this._llmCall = llmCall ?? null;
    // SQLite challenge corpus (lazy-initialized)
    this._dataDir = dataDir ?? tmpdir();
    this._corpus = null;

    // Advisory rate-limit tracking (real enforcement is server-side)
    this._lastPostAt = 0;
    this._lastCommentAt = 0;
    // Dedup guard: track recent comments to prevent parallel duplicates
    this._recentComments = new Map(); // key: "postId:contentPrefix" → timestamp
    // Verification failure tracking (capped at 20, process lifetime)
    this._failedVerifications = []; // { type, id, challenge_text, error, timestamp }
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
    const body = { submolt_name: submolt, title };
    if (content) body.content = content;
    if (url) body.url = url;

    const res = await this._apiRequest("POST", "/posts", body);
    this._lastPostAt = Date.now();

    // Auto-solve verification if present
    let verificationResult = null;
    if (res.post?.verification) {
      verificationResult = await this._solveVerification(
        res.post.verification,
        { type: "post", id: res.post?.id ?? "unknown" }
      );
    }
    res._verificationResult = verificationResult;

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
    // Dedup guard: reject if same post+content was commented in the last 60s
    const dedupKey = `${postId}:${content.slice(0, 80)}`;
    const lastTime = this._recentComments.get(dedupKey);
    if (lastTime && Date.now() - lastTime < 60000) {
      this.logger?.warn("Duplicate comment suppressed", { postId, dedupKey });
      return { comment: { id: "duplicate_suppressed" }, duplicate: true };
    }
    this._recentComments.set(dedupKey, Date.now());

    const body = { content };
    if (parentId) body.parent_id = parentId;

    const res = await this._apiRequest("POST", `/posts/${postId}/comments`, body);
    this._lastCommentAt = Date.now();

    // Auto-solve verification if present
    const comment = res.comment ?? res;
    let verificationResult = null;
    if (comment?.verification) {
      verificationResult = await this._solveVerification(
        comment.verification,
        { type: "comment", id: comment?.id ?? "unknown" }
      );
    }
    res._verificationResult = verificationResult;

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

  // ── Get Post ──

  /**
   * Get a single post by ID, optionally with its comments.
   * @param {string} postId - Post ID
   * @param {object} [opts]
   * @param {boolean} [opts.includeComments] - Also fetch comments (default: true)
   * @returns {Promise<{ post: object, comments?: object[] }>}
   */
  async getPost(postId, { includeComments = true } = {}) {
    const post = await this._apiRequest("GET", `/posts/${postId}`);
    if (!includeComments) return { post };

    const commentsRes = await this._apiRequest("GET", `/posts/${postId}/comments`);
    const comments = commentsRes.comments ?? commentsRes.data ?? commentsRes;
    return { post, comments: Array.isArray(comments) ? comments : [] };
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

  // ── Direct Messages ──

  /**
   * Get pending DM requests.
   * @returns {Promise<object>}
   */
  async getDmRequests() {
    return this._apiRequest("GET", "/agents/dm/requests");
  }

  /**
   * Get all DM conversations.
   * @returns {Promise<object>}
   */
  async getDmConversations() {
    return this._apiRequest("GET", "/agents/dm/conversations");
  }

  /**
   * Get a single DM conversation by ID.
   * @param {string} conversationId
   * @returns {Promise<object>}
   */
  async getDmConversation(conversationId) {
    return this._apiRequest("GET", `/agents/dm/conversations/${conversationId}`);
  }

  /**
   * Approve a pending DM request.
   * @param {string} conversationId
   * @returns {Promise<object>}
   */
  async approveDmRequest(conversationId) {
    return this._apiRequest("POST", `/agents/dm/requests/${conversationId}/approve`);
  }

  /**
   * Reject a pending DM request, optionally blocking the sender.
   * @param {string} conversationId
   * @param {object} [opts]
   * @param {boolean} [opts.block] - Also block the sender
   * @returns {Promise<object>}
   */
  async rejectDmRequest(conversationId, { block } = {}) {
    const body = block ? { block: true } : undefined;
    return this._apiRequest("POST", `/agents/dm/requests/${conversationId}/reject`, body);
  }

  /**
   * Send a direct message in an existing conversation.
   * @param {string} conversationId
   * @param {string} content - Message text
   * @returns {Promise<object>}
   */
  async sendDm(conversationId, content) {
    return this._apiRequest("POST", `/agents/dm/conversations/${conversationId}/send`, { content });
  }

  // ── Follows ──

  /**
   * Follow an agent.
   * @param {string} agentName
   * @returns {Promise<object>}
   */
  async follow(agentName) {
    return this._apiRequest("POST", `/agents/${agentName}/follow`);
  }

  /**
   * Unfollow an agent.
   * @param {string} agentName
   * @returns {Promise<object>}
   */
  async unfollow(agentName) {
    return this._apiRequest("POST", `/agents/${agentName}/unfollow`);
  }

  // ── Notifications ──

  /**
   * Get notifications (slimmed — strips embedded post/comment bodies to stay
   * within LLM context limits; the raw API response can exceed 150 KB).
   * @returns {Promise<object>}
   */
  async getNotifications() {
    const res = await this._apiRequest("GET", "/notifications");
    const notifications = res.notifications ?? res.data ?? (Array.isArray(res) ? res : []);
    return {
      ...res,
      notifications: notifications.map(n => ({
        id: n.id,
        type: n.type,
        content: n.content,
        isRead: n.isRead,
        createdAt: n.createdAt,
        relatedPostId: n.relatedPostId ?? undefined,
        relatedCommentId: n.relatedCommentId ?? undefined,
        // Keep post title but drop full content/tsv
        ...(n.post ? { post_title: n.post.title, post_id: n.post.id, submolt: n.post.submolt?.name ?? n.post.submoltId } : {}),
        // Keep comment preview but drop full tree
        ...(n.comment ? { comment_preview: (n.comment.content ?? "").slice(0, 200), commenter: n.comment.author?.name ?? n.comment.authorId } : {}),
      })),
    };
  }

  /**
   * Mark all notifications as read.
   * @returns {Promise<object>}
   */
  async markNotificationsRead() {
    return this._apiRequest("POST", "/notifications/read-all");
  }

  /**
   * Mark notifications for a specific post as read.
   * @param {string} postId
   * @returns {Promise<object>}
   */
  async markPostNotificationsRead(postId) {
    return this._apiRequest("POST", `/notifications/read-by-post/${postId}`);
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
   * Track a failed verification for planner visibility.
   * @param {object} meta - { type, id }
   * @param {string} challengeText
   * @param {string} error
   */
  _trackFailedVerification(meta, challengeText, error) {
    this._failedVerifications.push({
      type: meta?.type ?? "unknown",
      id: meta?.id ?? "unknown",
      challenge_text: challengeText.slice(0, 100),
      error,
      timestamp: new Date().toISOString(),
    });
    if (this._failedVerifications.length > 20) {
      this._failedVerifications = this._failedVerifications.slice(-20);
    }
  }

  /**
   * Get recent failed verifications (for planner hints / status route).
   * @returns {Array<{ type: string, id: string, challenge_text: string, error: string, timestamp: string }>}
   */
  getFailedVerifications() {
    return this._failedVerifications;
  }

  // ── Challenge Corpus (SQLite) ──

  /**
   * Lazy-init the SQLite challenge corpus. Stores every verification challenge
   * for regression testing and solver improvement.
   */
  _initCorpus() {
    if (this._corpus) return;
    try {
      // better-sqlite3 is a synchronous, native SQLite binding
      const Database = _requireBetterSqlite3();
      if (!Database) {
        this.logger?.warn("better-sqlite3 not available — challenge corpus disabled");
        return;
      }
      const dbPath = join(this._dataDir, "challenges.db");
      this._corpus = new Database(dbPath);
      this._corpus.pragma("journal_mode = WAL");
      this._corpus.exec(`
        CREATE TABLE IF NOT EXISTS challenges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          challenge_text TEXT NOT NULL,
          answer REAL,
          method TEXT NOT NULL,
          verified INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.logger?.info("Challenge corpus initialized", { dbPath });
    } catch (err) {
      this.logger?.warn("Failed to init challenge corpus", { error: err.message });
      this._corpus = null;
    }
  }

  /**
   * Record a challenge attempt in the corpus.
   * @param {string} challengeText
   * @param {number|null} answer
   * @param {"deterministic"|"llm"|"failed"} method
   * @param {boolean} verified - whether the server accepted the answer
   */
  _recordChallenge(challengeText, answer, method, verified) {
    this._initCorpus();
    if (!this._corpus) return;
    try {
      this._corpus.prepare(
        "INSERT INTO challenges (challenge_text, answer, method, verified) VALUES (?, ?, ?, ?)"
      ).run(challengeText, answer, method, verified ? 1 : 0);
    } catch (err) {
      this.logger?.warn("Failed to record challenge", { error: err.message });
    }
  }

  /**
   * Get all verified challenges (for regression testing).
   * @returns {Array<{ challenge_text: string, answer: number }>}
   */
  getVerifiedChallenges() {
    this._initCorpus();
    if (!this._corpus) return [];
    try {
      return this._corpus.prepare(
        "SELECT challenge_text, answer FROM challenges WHERE verified = 1 ORDER BY id"
      ).all();
    } catch {
      return [];
    }
  }

  /**
   * Get corpus stats.
   */
  getCorpusStats() {
    this._initCorpus();
    if (!this._corpus) return { total: 0, verified: 0, failed: 0, llm_solved: 0 };
    try {
      const row = this._corpus.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(verified) as verified,
          SUM(CASE WHEN method = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN method = 'llm' THEN 1 ELSE 0 END) as llm_solved
        FROM challenges
      `).get();
      return row;
    } catch {
      return { total: 0, verified: 0, failed: 0, llm_solved: 0 };
    }
  }

  // ── LLM Fallback ──

  /**
   * Try solving a math challenge via the configured LLM.
   * @param {string} challengeText
   * @returns {Promise<number|null>}
   */
  async _solveWithLLM(challengeText) {
    if (!this._llmCall) return null;
    try {
      this.logger?.info("Attempting LLM fallback for verification challenge");
      const response = await this._llmCall(challengeText);
      // Extract the first number from the response
      const match = response.match(/-?\d+(\.\d+)?/);
      if (match) {
        const answer = parseFloat(match[0]);
        if (isFinite(answer)) {
          this.logger?.info("LLM fallback solved challenge", { answer, response: response.slice(0, 50) });
          return answer;
        }
      }
      this.logger?.warn("LLM fallback returned non-numeric response", { response: response.slice(0, 100) });
      return null;
    } catch (err) {
      this.logger?.warn("LLM fallback failed", { error: err.message });
      return null;
    }
  }

  /**
   * Solve a Moltbook verification challenge.
   * Tries deterministic solver first, then LLM fallback.
   * Records every challenge in the corpus.
   * Returns { solved, error? } — NEVER throws, because the content has already
   * been created by the time verification runs.
   *
   * @param {object} verification
   * @param {string} verification.verification_code
   * @param {string} verification.challenge_text
   * @param {object} [meta] - { type, id } for failure tracking
   * @returns {Promise<{ solved: boolean, error?: string }>}
   */
  async _solveVerification(verification, meta) {
    const { verification_code, challenge_text } = verification;

    if (!verification_code || !challenge_text) {
      this.logger?.warn("Verification challenge missing code or text", { verification });
      return { solved: false, error: "missing_code_or_text", challenge_text: challenge_text ?? null };
    }

    // Try deterministic solver first
    let answer = solveMathChallenge(challenge_text);
    let method = "deterministic";

    // If deterministic fails, try LLM fallback
    if (answer === null) {
      this.logger?.warn("Deterministic solver failed, trying LLM fallback", { challenge_text });
      answer = await this._solveWithLLM(challenge_text);
      method = answer !== null ? "llm" : "failed";
    }

    if (answer === null) {
      this.logger?.error("All solvers failed for verification challenge", { challenge_text });
      this._trackFailedVerification(meta, challenge_text, "solver_failed");
      this._recordChallenge(challenge_text, null, "failed", false);
      return { solved: false, error: "solver_failed", challenge_text };
    }

    const formatted = answer.toFixed(2);
    this.logger?.info("Solving verification", { verification_code, answer: formatted, method, challenge_text });

    try {
      const res = await this._apiRequest("POST", "/verify", {
        verification_code,
        answer: formatted,
      });
      this.logger?.info("Verification solved", { res, method });
      this._recordChallenge(challenge_text, answer, method, true);
      return { solved: true };
    } catch (err) {
      const error = err.message ?? "submission_failed";
      this.logger?.error("Verification submission failed", { error, challenge_text, method });
      this._trackFailedVerification(meta, challenge_text, error);
      this._recordChallenge(challenge_text, answer, method, false);
      return { solved: false, error, challenge_text };
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
  async _apiRequest(method, path, body = null, queryParams = {}, opts = {}) {
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

    // Handle rate limiting — single automatic retry with server-specified wait
    if (res.status === 429) {
      const errorBody = await res.json().catch(() => ({}));
      const waitSec = errorBody.retry_after_seconds
        ?? (errorBody.retry_after_minutes ? errorBody.retry_after_minutes * 60 : null);
      if (waitSec && waitSec <= 120 && !opts._retried) {
        this.logger?.info("Rate limited, retrying after wait", { method, path, waitSec });
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        return this._apiRequest(method, path, body, queryParams, { _retried: true });
      }
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

// ── Verification challenge solver ──

/**
 * Solve a Moltbook verification challenge.
 *
 * Challenges are obfuscated word problems like:
 *   "T]hIs LoOo bS-tEr SwImS^ aT/ tW eN tY tH rEe MeT/eRs PeR SeCoNd, Um/ aNd GaInS] sEvEn~, WhAtS^ tHe NeW- VeLoO cItY?"
 *
 * Strategy:
 *   1. Strip decoration (random case, inserted punctuation/symbols)
 *   2. Parse word-form numbers (e.g. "twenty three" → 23)
 *   3. Detect the operation from context words (gains/adds → +, loses/minus → -, times/multiplied → *, divided → /)
 *   4. Compute and return the result
 *   5. Falls back to numeric expression parsing if word parsing fails
 *
 * @param {string} challengeText
 * @returns {number|null}
 */
export function solveMathChallenge(challengeText) {
  // Step 1: Strip obfuscation — remove decorative chars, collapse whitespace, lowercase
  const clean = challengeText
    .replace(/[^a-zA-Z0-9\s.+\-*/()]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

  // Step 2: If it looks like a pure numeric expression, try that first
  const strippedAlpha = clean.replace(/[a-z\s]/g, "");
  if (strippedAlpha.length > 0 && /^[\d+\-*/().]+$/.test(strippedAlpha)) {
    try {
      const result = parseArithmeticExpr(strippedAlpha);
      if (result !== null && isFinite(result)) return result;
    } catch { /* fall through */ }
  }

  // Step 3: Deobfuscate — merge fragmented tokens into recognized words
  const deobfuscated = deobfuscate(clean);

  // Step 4: Try word-problem approach
  const wordResult = solveWordProblem(deobfuscated);
  if (wordResult !== null) return wordResult;

  // Step 5: Final fallback — try numeric expression
  const numericResult = solveNumericExpression(clean);
  if (numericResult !== null) return numericResult;

  return null;
}

// ── Deobfuscation ──

// All words the solver needs to recognize (number words + operation/context words)
const KNOWN_WORDS = [
  // numbers — longest first for greedy matching
  "seventeen", "thirteen", "fourteen", "fifteen", "sixteen", "eighteen", "nineteen",
  "seventy", "eighty", "ninety", "twenty", "thirty", "forty", "fifty", "sixty",
  "eleven", "twelve", "seven", "eight", "three", "four", "five", "nine",
  "thousand", "hundred", "million", "billion",
  "zero", "one", "two", "six", "ten",
  // operations
  "multiplied", "multiplies", "multiply", "increased", "increases", "decreased", "decreases",
  "additional", "combined", "together",
  "subtract", "subtracts", "quadrupled", "tripled", "doubled",
  "divided", "divide", "halved", "split",
  "gains", "gain", "loses", "lose", "adds", "add", "plus", "minus",
  "times", "drops", "drop", "falls", "fell", "slows", "slow", "more", "less", "fewer",
  "reduces", "reduce", "product",
  // operations (must also be in KNOWN_WORDS so deobfuscator extracts them)
  "accelerates", "accelerate", "decelerates", "decelerate",
  "speeds",  // "speeds up" = addition
  // context
  "lobster", "lobsters", "another", "centimeters", "centimeter", "kilometers", "kilometer",
  "temperature", "distance", "newtons", "newton", "degrees",
  "celsius", "fahrenheit", "meters", "kilograms", "kilogram", "seconds", "minutes",
  "weight", "height", "force", "power", "energy", "exerts", "strikes",
  "speed", "velocity", "second", "total", "whats", "what", "other",
  "swimming", "swims", "swim", "runs", "run", "moves", "move",
  "stretches", "stretch", "mechanics", "dominance", "social", "territorial", "bump",
  "after", "but", "its", "reduces",
  "new", "per", "and", "the", "has", "how", "many", "at", "is", "um", "umm", "ehh", "uh", "err", "a",
  "up", "by",
  "point", "negative", "claw", "claws", "sum",
];

// Sort by length descending for greedy matching
const SORTED_KNOWN = [...KNOWN_WORDS].sort((a, b) => b.length - a.length);

/**
 * Match a known word against a buffer that may have duplicated characters.
 * E.g. "twenntyy" matches "twenty" by consuming repeated chars.
 * Returns number of chars consumed from buffer, or null if no match.
 */
function matchStretched(buffer, word) {
  let bi = 0;
  for (let wi = 0; wi < word.length; wi++) {
    if (bi >= buffer.length || buffer[bi] !== word[wi]) return null;
    bi++; // consume exactly one
    // Consume extra repeated chars ONLY if next word char is different
    // (preserves chars needed for consecutive identical letters like 'ee' in "three")
    if (wi + 1 >= word.length || word[wi + 1] !== word[wi]) {
      while (bi < buffer.length && buffer[bi] === word[wi]) bi++;
    }
  }
  return bi;
}

/**
 * Deobfuscate text using a two-phase approach.
 *
 * Phase 1: Match individual tokens against known words (preserves word boundaries).
 * Phase 2: Concatenate consecutive unmatched token fragments and greedily extract
 *          known words from the combined buffer (handles split words like "tw en ty").
 *
 * This prevents greedy char consumption from stealing characters across word boundaries
 * (e.g. "at" + "twenty" → "att..." where matchStretched eats both t's for "at").
 */
function deobfuscate(cleanText) {
  const tokens = cleanText.split(/\s+/);

  // Build list of { type, value } entries — 'pass' for digits/operators, 'alpha' for text
  const entries = [];
  for (const tok of tokens) {
    if (/^\d+(\.\d+)?$/.test(tok) || /^[+\-*/()]+$/.test(tok)) {
      entries.push({ type: "pass", value: tok });
    } else {
      const alphaOnly = tok.replace(/[+\-*/()]/g, "");
      if (alphaOnly) entries.push({ type: "alpha", value: alphaOnly });
    }
  }

  // Phase 1: Try to match each alpha token individually against known words
  for (const entry of entries) {
    if (entry.type !== "alpha") continue;
    for (const word of SORTED_KNOWN) {
      const consumed = matchStretched(entry.value, word);
      if (consumed !== null && consumed === entry.value.length) {
        // Entire token matches a known word
        entry.resolved = word;
        break;
      }
    }
  }

  // Phase 2: Group consecutive unresolved alpha entries, concatenate, and greedily extract
  const resultWords = [];
  let unresolved = [];

  function flushUnresolved() {
    if (unresolved.length === 0) return;
    const buffer = unresolved.map(e => e.value).join("");
    unresolved = [];
    _extractFromBuffer(buffer, resultWords);
  }

  for (const entry of entries) {
    if (entry.type === "pass") {
      flushUnresolved();
      resultWords.push(entry.value);
    } else if (entry.resolved) {
      flushUnresolved();
      resultWords.push(entry.resolved);
    } else {
      unresolved.push(entry);
    }
  }
  flushUnresolved();

  return resultWords.join(" ");
}

/**
 * Greedily extract known words from an alpha buffer using matchStretched.
 */
function _extractFromBuffer(buffer, resultWords) {
  let remaining = buffer;
  while (remaining.length > 0) {
    let matched = false;
    for (const word of SORTED_KNOWN) {
      const consumed = matchStretched(remaining, word);
      if (consumed !== null) {
        resultWords.push(word);
        remaining = remaining.slice(consumed);
        matched = true;
        break;
      }
    }
    if (!matched) {
      remaining = remaining.slice(1);
    }
  }
}

// ── Word number parsing ──

const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

const MAGNITUDES = {
  hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000,
};

/**
 * Parse a number from word tokens starting at position i.
 * Returns { value, nextIndex } or null.
 */
function parseWordNumber(tokens, startIdx) {
  let i = startIdx;
  let total = 0;
  let current = 0;
  let found = false;

  while (i < tokens.length) {
    const tok = tokens[i];

    // Plain digit
    if (/^\d+(\.\d+)?$/.test(tok)) {
      current += parseFloat(tok);
      found = true;
      i++;
      continue;
    }

    if (tok === "and") { i++; continue; }
    if (tok === "a" && i + 1 < tokens.length && MAGNITUDES[tokens[i + 1]]) {
      current = 1;
      found = true;
      i++;
      continue;
    }

    if (ONES[tok] !== undefined) {
      current += ONES[tok];
      found = true;
      i++;
      continue;
    }

    if (TENS[tok] !== undefined) {
      current += TENS[tok];
      found = true;
      i++;
      continue;
    }

    if (tok === "hundred") {
      current = (current || 1) * 100;
      found = true;
      i++;
      continue;
    }

    if (tok === "thousand") {
      current = (current || 1) * 1000;
      total += current;
      current = 0;
      found = true;
      i++;
      continue;
    }

    if (tok === "million") {
      current = (current || 1) * 1_000_000;
      total += current;
      current = 0;
      found = true;
      i++;
      continue;
    }

    // Negative prefix
    if ((tok === "negative" || tok === "minus") && !found) {
      const sub = parseWordNumber(tokens, i + 1);
      if (sub) return { value: -sub.value, nextIndex: sub.nextIndex };
      break;
    }

    // Point / decimal for word numbers: "three point five"
    if (tok === "point" && found) {
      i++;
      let decimals = "";
      while (i < tokens.length && ONES[tokens[i]] !== undefined) {
        decimals += ONES[tokens[i]];
        i++;
      }
      if (decimals) {
        total += current;
        current = 0;
        total = parseFloat(total + "." + decimals);
        continue;
      }
      break;
    }

    break; // Unrecognized token — stop
  }

  if (!found) return null;
  return { value: total + current, nextIndex: i };
}

// ── Operation detection ──

const ADD_WORDS = new Set(["gains", "gain", "adds", "add", "plus", "increased", "increases", "more", "additional", "combined", "together", "sum", "accelerates", "accelerate", "speeds"]);
const SUB_WORDS = new Set(["loses", "lose", "minus", "subtract", "subtracts", "decreased", "decreases", "less", "fewer", "drops", "drop", "falls", "fell", "slows", "slow", "decelerates", "decelerate", "reduces", "reduce"]);
const MUL_WORDS = new Set(["times", "multiplied", "multiplies", "multiply", "doubled", "tripled", "quadrupled", "product"]);
const DIV_WORDS = new Set(["divided", "divide", "halved", "split"]);

const IMPLICIT_MULTIPLIERS = { doubled: 2, tripled: 3, quadrupled: 4 };
const IMPLICIT_DIVISORS = { halved: 2 };

function solveImplicitMultiplier(tokens, numEntry) {
  for (let j = 0; j < tokens.length; j++) {
    if (j >= numEntry.startIdx && j < numEntry.endIdx) continue;
    const t = tokens[j];
    if (IMPLICIT_MULTIPLIERS[t] !== undefined) return numEntry.value * IMPLICIT_MULTIPLIERS[t];
    if (IMPLICIT_DIVISORS[t] !== undefined) return numEntry.value / IMPLICIT_DIVISORS[t];
  }
  return null;
}

function detectOperation(tokens, fromIdx, toIdx) {
  for (let i = fromIdx; i < toIdx && i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "+" || ADD_WORDS.has(t)) return "+";
    if (t === "-" || SUB_WORDS.has(t)) return "-";
    if (t === "*" || MUL_WORDS.has(t)) return "*";
    if (t === "/" || DIV_WORDS.has(t)) return "/";
  }
  return null;
}

/**
 * Solve a cleaned word problem.
 */
function solveWordProblem(text) {
  const tokens = text.split(/\s+/);

  // Find all numbers in the text
  const numbers = [];
  let i = 0;
  while (i < tokens.length) {
    const parsed = parseWordNumber(tokens, i);
    if (parsed) {
      numbers.push({ value: parsed.value, startIdx: i, endIdx: parsed.nextIndex });
      i = parsed.nextIndex;
    } else {
      i++;
    }
  }

  if (numbers.length === 1) {
    const a = numbers[0];
    const implicitResult = solveImplicitMultiplier(tokens, a);
    if (implicitResult !== null) return implicitResult;
    return null;
  }

  // Chain all numbers with their detected operations
  let result = numbers[0].value;
  for (let n = 1; n < numbers.length; n++) {
    const prev = numbers[n - 1];
    const curr = numbers[n];
    // Look for operation between prev and curr, fall back to before first / after last
    const op = detectOperation(tokens, prev.endIdx, curr.startIdx)
      ?? (n === 1 ? detectOperation(tokens, 0, prev.startIdx) : null)
      ?? detectOperation(tokens, curr.endIdx, tokens.length);
    if (!op) return null;
    switch (op) {
      case "+": result += curr.value; break;
      case "-": result -= curr.value; break;
      case "*": result *= curr.value; break;
      case "/": if (curr.value === 0) return null; result /= curr.value; break;
      default: return null;
    }
  }
  // Check for implicit multiplier after the last number
  const lastNum = numbers[numbers.length - 1];
  for (let j = lastNum.endIdx; j < tokens.length; j++) {
    const t = tokens[j];
    if (IMPLICIT_MULTIPLIERS[t] !== undefined) return result * IMPLICIT_MULTIPLIERS[t];
    if (IMPLICIT_DIVISORS[t] !== undefined) return result / IMPLICIT_DIVISORS[t];
  }
  return result;
}

/**
 * Fallback: try to extract and evaluate a numeric math expression.
 */
function solveNumericExpression(text) {
  const mathMatch = text.match(/[\d+\-*/().]+/);
  if (!mathMatch) return null;

  const expr = mathMatch[0].trim();
  if (!expr || !/\d/.test(expr)) return null;

  try {
    return parseArithmeticExpr(expr);
  } catch {
    return null;
  }
}

/**
 * Recursive-descent parser for arithmetic expressions.
 */
function parseArithmeticExpr(str) {
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
    if (str[pos] === "-") { pos++; return -parseFactor(); }
    if (str[pos] === "(") {
      pos++;
      const val = parseExpr();
      if (str[pos] === ")") pos++;
      return val;
    }
    const start = pos;
    while (pos < str.length && (str[pos] >= "0" && str[pos] <= "9" || str[pos] === ".")) pos++;
    if (pos === start) throw new Error(`Unexpected char at ${pos}`);
    return parseFloat(str.slice(start, pos));
  }

  const result = parseExpr();
  if (pos < str.length) throw new Error(`Unexpected char at ${pos}`);
  return result;
}
