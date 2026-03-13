/**
 * MoltbookClient — HTTP client for Moltbook API v1.
 *
 * Bearer-token auth, LLM-based verification challenge solver,
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
      this.logger?.info("Solving verification challenge via LLM");
      const response = await this._llmCall(challengeText);
      // Extract the first number from the response
      const match = response.match(/-?\d+(\.\d+)?/);
      if (match) {
        const answer = parseFloat(match[0]);
        if (isFinite(answer)) {
          this.logger?.info("LLM solved verification challenge", { answer, response: response.slice(0, 50) });
          return answer;
        }
      }
      this.logger?.warn("LLM returned non-numeric response", { response: response.slice(0, 100) });
      return null;
    } catch (err) {
      this.logger?.warn("LLM solver failed", { error: err.message });
      return null;
    }
  }

  /**
   * Solve a Moltbook verification challenge via LLM.
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

    // Solve via LLM
    const answer = await this._solveWithLLM(challenge_text);

    if (answer === null) {
      this.logger?.error("LLM solver failed for verification challenge", { challenge_text });
      this._trackFailedVerification(meta, challenge_text, "solver_failed");
      this._recordChallenge(challenge_text, null, "failed", false);
      return { solved: false, error: "solver_failed", challenge_text };
    }

    const formatted = answer.toFixed(2);
    this.logger?.info("Solving verification", { verification_code, answer: formatted, challenge_text });

    try {
      const res = await this._apiRequest("POST", "/verify", {
        verification_code,
        answer: formatted,
      });
      this.logger?.info("Verification solved", { res });
      this._recordChallenge(challenge_text, answer, "llm", true);
      return { solved: true };
    } catch (err) {
      const error = err.message ?? "submission_failed";
      this.logger?.error("Verification submission failed", { error, challenge_text });
      this._trackFailedVerification(meta, challenge_text, error);
      this._recordChallenge(challenge_text, answer, "llm", false);
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
