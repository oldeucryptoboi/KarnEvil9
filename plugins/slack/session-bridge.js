/**
 * SessionBridge — maps Slack messages to Jarvis sessions, tracks threads.
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
    /** @type {Map<string, { channel: string, threadTs: string, userId: string, startedAt: number }>} */
    this.sessions = new Map();
    /** @type {Map<string, string>} threadTs -> sessionId for dedup */
    this.threadToSession = new Map();
  }

  /**
   * Check if a thread already has an active session.
   * @param {string} threadTs
   * @returns {boolean}
   */
  hasActiveSession(threadTs) {
    return this.threadToSession.has(threadTs);
  }

  /**
   * Get the number of currently active sessions.
   * @returns {number}
   */
  get activeCount() {
    return this.sessions.size;
  }

  /**
   * Create a new Jarvis session from a Slack message.
   * @param {object} opts
   * @param {string} opts.taskText - cleaned task text
   * @param {string} opts.channel - Slack channel ID
   * @param {string} opts.threadTs - thread timestamp (anchor message ts)
   * @param {string} opts.userId - requesting Slack user ID
   * @returns {Promise<{ session_id: string, status: string }>}
   * @throws {Error} if concurrency limit reached or sessionFactory fails
   */
  async createSession({ taskText, channel, threadTs, userId }) {
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new Error(`Concurrency limit reached (${this.maxConcurrentSessions} active sessions)`);
    }

    const task = {
      task_id: `slack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: taskText,
      created_at: new Date().toISOString(),
    };

    const result = await this.sessionFactory(task, { agentic: true });
    const sessionId = result.session_id;

    this.sessions.set(sessionId, {
      channel,
      threadTs,
      userId,
      startedAt: Date.now(),
    });
    this.threadToSession.set(threadTs, sessionId);

    return result;
  }

  /**
   * Get thread info for a session ID.
   * @param {string} sessionId
   * @returns {{ channel: string, threadTs: string, userId: string, startedAt: number } | undefined}
   */
  getSessionThread(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Remove a completed/failed/aborted session.
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    const info = this.sessions.get(sessionId);
    if (info) {
      this.threadToSession.delete(info.threadTs);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * List all active sessions.
   * @returns {Array<{ sessionId: string, channel: string, threadTs: string, userId: string, startedAt: number }>}
   */
  listSessions() {
    const result = [];
    for (const [sessionId, info] of this.sessions) {
      result.push({ sessionId, ...info });
    }
    return result;
  }
}
