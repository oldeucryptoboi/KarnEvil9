/**
 * SessionBridge — maps Signal sender phone numbers to KarnEvil9 sessions.
 * One active session per sender phone number at a time.
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
    /** @type {Map<string, { sender: string, startedAt: number }>} sessionId -> info */
    this.sessions = new Map();
    /** @type {Map<string, string>} sender phone -> sessionId */
    this.senderToSession = new Map();
  }

  /**
   * Check if a sender already has an active session.
   * @param {string} sender - E.164 phone number
   * @returns {boolean}
   */
  hasActiveSession(sender) {
    return this.senderToSession.has(sender);
  }

  /**
   * Get session ID for a sender.
   * @param {string} sender
   * @returns {string | undefined}
   */
  getSessionIdForSender(sender) {
    return this.senderToSession.get(sender);
  }

  /**
   * Get the number of currently active sessions.
   * @returns {number}
   */
  get activeCount() {
    return this.sessions.size;
  }

  /**
   * Create a new KarnEvil9 session from a Signal message.
   * @param {object} opts
   * @param {string} opts.taskText - cleaned task text
   * @param {string} opts.sender - sender phone number (E.164)
   * @returns {Promise<{ session_id: string, status: string }>}
   * @throws {Error} if concurrency limit reached or sessionFactory fails
   */
  async createSession({ taskText, sender }) {
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new Error(`Concurrency limit reached (${this.maxConcurrentSessions} active sessions)`);
    }

    const task = {
      task_id: `signal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: taskText,
      created_at: new Date().toISOString(),
    };

    const result = await this.sessionFactory(task, { agentic: true });
    const sessionId = result.session_id;

    this.sessions.set(sessionId, {
      sender,
      startedAt: Date.now(),
    });
    this.senderToSession.set(sender, sessionId);

    return result;
  }

  /**
   * Get sender info for a session ID.
   * @param {string} sessionId
   * @returns {{ sender: string, startedAt: number } | undefined}
   */
  getSessionInfo(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Get sender phone number for a session ID.
   * @param {string} sessionId
   * @returns {string | undefined}
   */
  getSenderForSession(sessionId) {
    const info = this.sessions.get(sessionId);
    return info?.sender;
  }

  /**
   * Remove a completed/failed/aborted session.
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    const info = this.sessions.get(sessionId);
    if (info) {
      this.senderToSession.delete(info.sender);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * List all active sessions.
   * @returns {Array<{ sessionId: string, sender: string, startedAt: number }>}
   */
  listSessions() {
    const result = [];
    for (const [sessionId, info] of this.sessions) {
      result.push({ sessionId, ...info });
    }
    return result;
  }
}
