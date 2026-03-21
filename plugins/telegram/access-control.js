/**
 * AccessControl — Telegram user ID allowlist with optional pairing mode.
 *
 * Modes:
 *   "allowlist" — only pre-configured user IDs may interact (default when TELEGRAM_ALLOWED_USERS is set)
 *   "pairing"  — unknown users trigger a pairing code flow; approved users are added at runtime
 *
 * Empty allowlist behavior:
 *   allowlist mode → deny all (require explicit opt-in via TELEGRAM_ALLOWED_USERS)
 *   pairing mode   → deny but caller should trigger pairing flow
 */
export class AccessControl {
  /**
   * @param {object} [opts]
   * @param {number[]} [opts.allowedUsers] - Telegram user IDs
   * @param {"allowlist"|"pairing"} [opts.mode] - Access control mode
   */
  constructor({ allowedUsers = [], mode = "allowlist" } = {}) {
    /** @type {Set<number>} */
    this.allowedUsers = new Set(allowedUsers.filter(Boolean));
    /** @type {"allowlist"|"pairing"} */
    this.mode = mode;
  }

  /**
   * Whether the controller is in pairing mode.
   * @returns {boolean}
   */
  get isPairingMode() {
    return this.mode === "pairing";
  }

  /**
   * Check if a user is allowed.
   * @param {number} userId - Telegram user ID
   * @returns {boolean}
   */
  isAllowed(userId) {
    if (this.allowedUsers.size === 0) return false;
    return this.allowedUsers.has(userId);
  }

  /**
   * Add a user at runtime (used by pairing approval).
   * @param {number} userId - Telegram user ID
   */
  addUser(userId) {
    this.allowedUsers.add(userId);
  }
}
