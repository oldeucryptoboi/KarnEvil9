/**
 * SessionBridge — maps Telegram chat IDs to KarnEvil9 sessions.
 * One active session per chat at a time.
 */
export class SessionBridge {
  /**
   * @param {object} opts
   * @param {Function} opts.sessionFactory - (task, opts) => Promise<{ session_id, status }>
   * @param {number} [opts.maxConcurrentSessions] - default: 10
   * @param {number} [opts.sessionTimeout] - default: 300000 (5 min)
   */
  constructor({ sessionFactory, maxConcurrentSessions = 10, sessionTimeout = 300000 }) {
    this.sessionFactory = sessionFactory;
    this.maxConcurrentSessions = maxConcurrentSessions;
    this.sessionTimeout = sessionTimeout;
    /** @type {Map<string, { chatId: number, startedAt: number }>} sessionId -> info */
    this.sessions = new Map();
    /** @type {Map<number, string>} chatId -> sessionId */
    this.chatToSession = new Map();
  }

  /**
   * Check if a chat already has an active session.
   * @param {number} chatId - Telegram chat ID
   * @returns {boolean}
   */
  hasActiveSession(chatId) {
    return this.chatToSession.has(chatId);
  }

  /**
   * Get session ID for a chat.
   * @param {number} chatId
   * @returns {string | undefined}
   */
  getSessionIdForChat(chatId) {
    return this.chatToSession.get(chatId);
  }

  /**
   * Get the number of currently active sessions.
   * @returns {number}
   */
  get activeCount() {
    return this.sessions.size;
  }

  /**
   * Create a new KarnEvil9 session from a Telegram message.
   * @param {object} opts
   * @param {string} opts.taskText - cleaned task text
   * @param {number} opts.chatId - Telegram chat ID
   * @returns {Promise<{ session_id: string, status: string }>}
   * @throws {Error} if concurrency limit reached or sessionFactory fails
   */
  async createSession({ taskText, chatId }) {
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new Error(`Concurrency limit reached (${this.maxConcurrentSessions} active sessions)`);
    }

    const task = {
      task_id: `telegram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: taskText,
      created_at: new Date().toISOString(),
    };

    const result = await this.sessionFactory(task, { agentic: true });
    const sessionId = result.session_id;

    this.sessions.set(sessionId, {
      chatId,
      startedAt: Date.now(),
    });
    this.chatToSession.set(chatId, sessionId);

    return result;
  }

  /**
   * Get chat info for a session ID.
   * @param {string} sessionId
   * @returns {{ chatId: number, startedAt: number } | undefined}
   */
  getSessionInfo(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Get chat ID for a session ID.
   * @param {string} sessionId
   * @returns {number | undefined}
   */
  getChatIdForSession(sessionId) {
    const info = this.sessions.get(sessionId);
    return info?.chatId;
  }

  /**
   * Remove a completed/failed/aborted session.
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    const info = this.sessions.get(sessionId);
    if (info) {
      this.chatToSession.delete(info.chatId);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * List all active sessions.
   * @returns {Array<{ sessionId: string, chatId: number, startedAt: number }>}
   */
  listSessions() {
    const result = [];
    for (const [sessionId, info] of this.sessions) {
      result.push({ sessionId, ...info });
    }
    return result;
  }
}
