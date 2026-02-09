/**
 * AccessControl — mention-only filtering with per-channel overrides.
 */
export class AccessControl {
  /**
   * @param {object} opts
   * @param {boolean} opts.defaultRequireMention - default: true
   * @param {Record<string, { requireMention?: boolean }>} [opts.channelOverrides]
   */
  constructor({ defaultRequireMention = true, channelOverrides = {} } = {}) {
    this.defaultRequireMention = defaultRequireMention;
    this.channelOverrides = channelOverrides;
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
