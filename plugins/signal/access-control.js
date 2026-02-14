/**
 * AccessControl — phone number allowlist for Signal integration.
 * Uses SIGNAL_ALLOWED_NUMBERS env var (comma-separated E.164 numbers).
 * Empty list = allow all.
 */
export class AccessControl {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.allowedNumbers] - E.164 phone numbers
   */
  constructor({ allowedNumbers = [] } = {}) {
    /** @type {Set<string>} */
    this.allowedNumbers = new Set(allowedNumbers.filter(Boolean));
  }

  /**
   * Check if a sender is allowed.
   * @param {string} sender - E.164 phone number
   * @returns {boolean}
   */
  isAllowed(sender) {
    // Empty allowlist = allow all
    if (this.allowedNumbers.size === 0) return true;
    return this.allowedNumbers.has(sender);
  }
}
