/**
 * AccessControl — Twitter user ID allowlist for X/Twitter integration.
 * Uses TWITTER_ALLOWED_USER_IDS env var (comma-separated Twitter user IDs).
 * Empty list = deny all (require explicit opt-in).
 */
export class AccessControl {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.allowedUserIds] - Twitter user IDs (numeric strings)
   */
  constructor({ allowedUserIds = [] } = {}) {
    /** @type {Set<string>} */
    this.allowedUserIds = new Set(allowedUserIds.filter(Boolean));
  }

  /**
   * Check if a sender is allowed.
   * @param {string} senderId - Twitter user ID
   * @returns {boolean}
   */
  isAllowed(senderId) {
    // Empty allowlist = deny all (require explicit opt-in via TWITTER_ALLOWED_USER_IDS)
    if (this.allowedUserIds.size === 0) return false;

    return this.allowedUserIds.has(senderId);
  }
}
