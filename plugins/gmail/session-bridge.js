/**
 * SessionBridge — maps Gmail sender email addresses to KarnEvil9 sessions.
 * One active session per sender email at a time.
 * Also tracks threadId per session for reply-in-thread.
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
    /** @type {Map<string, { sender: string, threadId: string | null, subject: string, startedAt: number }>} sessionId -> info */
    this.sessions = new Map();
    /** @type {Map<string, string>} sender email -> sessionId */
    this.senderToSession = new Map();
  }

  /**
   * Check if a sender already has an active session.
   * @param {string} sender - email address
   * @returns {boolean}
   */
  hasActiveSession(sender) {
    return this.senderToSession.has(sender.toLowerCase());
  }

  /**
   * Get session ID for a sender.
   * @param {string} sender
   * @returns {string | undefined}
   */
  getSessionIdForSender(sender) {
    return this.senderToSession.get(sender.toLowerCase());
  }

  /**
   * Get the number of currently active sessions.
   * @returns {number}
   */
  get activeCount() {
    return this.sessions.size;
  }

  /**
   * Create a new KarnEvil9 session from a Gmail message.
   * @param {object} opts
   * @param {string} opts.taskText - cleaned task text
   * @param {string} opts.sender - sender email address
   * @param {string | null} [opts.threadId] - Gmail threadId for reply-in-thread
   * @param {string} [opts.subject] - email subject line
   * @returns {Promise<{ session_id: string, status: string }>}
   * @throws {Error} if concurrency limit reached or sessionFactory fails
   */
  async createSession({ taskText, sender, threadId = null, subject = "" }) {
    const senderLower = sender.toLowerCase();
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new Error(`Concurrency limit reached (${this.maxConcurrentSessions} active sessions)`);
    }

    const task = {
      task_id: `gmail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: taskText,
      created_at: new Date().toISOString(),
    };

    const result = await this.sessionFactory(task, { agentic: true });
    const sessionId = result.session_id;

    this.sessions.set(sessionId, {
      sender: senderLower,
      threadId,
      subject,
      startedAt: Date.now(),
    });
    this.senderToSession.set(senderLower, sessionId);

    return result;
  }

  /**
   * Get sender info for a session ID.
   * @param {string} sessionId
   * @returns {{ sender: string, threadId: string | null, subject: string, startedAt: number } | undefined}
   */
  getSessionInfo(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Get sender email for a session ID.
   * @param {string} sessionId
   * @returns {string | undefined}
   */
  getSenderForSession(sessionId) {
    const info = this.sessions.get(sessionId);
    return info?.sender;
  }

  /**
   * Get threadId for a session ID.
   * @param {string} sessionId
   * @returns {string | null | undefined}
   */
  getThreadIdForSession(sessionId) {
    const info = this.sessions.get(sessionId);
    return info?.threadId;
  }

  /**
   * Get subject for a session ID.
   * @param {string} sessionId
   * @returns {string | undefined}
   */
  getSubjectForSession(sessionId) {
    const info = this.sessions.get(sessionId);
    return info?.subject;
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
   * @returns {Array<{ sessionId: string, sender: string, threadId: string | null, subject: string, startedAt: number }>}
   */
  listSessions() {
    const result = [];
    for (const [sessionId, info] of this.sessions) {
      result.push({ sessionId, ...info });
    }
    return result;
  }
}
