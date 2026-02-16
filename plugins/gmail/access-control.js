/**
 * AccessControl — email sender allowlist for Gmail integration.
 * Uses GMAIL_ALLOWED_SENDERS env var (comma-separated email addresses, case-insensitive).
 * Empty list = allow all.
 */
export class AccessControl {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.allowedSenders] - email addresses
   */
  constructor({ allowedSenders = [] } = {}) {
    /** @type {Set<string>} */
    this.allowedSenders = new Set(
      allowedSenders.filter(Boolean).map((s) => s.toLowerCase()),
    );
  }

  /**
   * Check if a sender is allowed.
   * @param {string} sender - email address
   * @returns {boolean}
   */
  isAllowed(sender) {
    // Empty allowlist = allow all
    if (this.allowedSenders.size === 0) return true;
    return this.allowedSenders.has(sender.toLowerCase());
  }
}
