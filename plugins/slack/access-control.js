/**
 * AccessControl — mention-only filtering with per-channel overrides
 * and user-level allowlist for Slack integration.
 */
export class AccessControl {
  /**
   * @param {object} opts
   * @param {boolean} opts.defaultRequireMention - default: true
   * @param {Record<string, { requireMention?: boolean }>} [opts.channelOverrides]
   * @param {string[]} [opts.allowedUserIds] - Slack user IDs allowed to interact
   */
  constructor({ defaultRequireMention = true, channelOverrides = {}, allowedUserIds = [] } = {}) {
    this.defaultRequireMention = defaultRequireMention;
    this.channelOverrides = channelOverrides;
    /** @type {Set<string>} */
    this.allowedUserIds = new Set(allowedUserIds.filter(Boolean));
  }

  /**
   * Check if a Slack user is allowed to interact with the bot.
   * Empty allowlist = deny all (require explicit opt-in via SLACK_ALLOWED_USER_IDS).
   * @param {string} userId - Slack user ID
   * @returns {boolean}
   */
  isUserAllowed(userId) {
    if (this.allowedUserIds.size === 0) return false;
    return this.allowedUserIds.has(userId);
  }

  /**
   * Whether a given channel requires an @mention to trigger the bot.
   * @param {string} channelId
   * @returns {boolean}
   */
  requiresMention(channelId) {
    const override = this.channelOverrides[channelId];
    if (override && typeof override.requireMention === "boolean") {
      return override.requireMention;
    }
    return this.defaultRequireMention;
  }

  /**
   * Strip the bot's @mention from message text and return cleaned text.
   * @param {string} text
   * @param {string} botUserId
   * @returns {string}
   */
  stripMention(text, botUserId) {
    return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }
}
