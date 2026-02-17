/**
 * AccessControl — phone number allowlist for WhatsApp integration.
 * Uses WHATSAPP_ALLOWED_NUMBERS env var (comma-separated E.164 numbers).
 * Empty list = deny all (require explicit opt-in).
 */
export class AccessControl {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.allowedNumbers] - E.164 phone numbers (e.g. "+1234567890")
   */
  constructor({ allowedNumbers = [] } = {}) {
    /** @type {Set<string>} */
    this.allowedNumbers = new Set(allowedNumbers.filter(Boolean));
  }

  /**
   * Check if a sender JID is allowed.
   * Strips the @s.whatsapp.net suffix and compares against E.164 numbers.
   * @param {string} sender - WhatsApp JID (e.g. "1234567890@s.whatsapp.net")
   * @returns {boolean}
   */
  isAllowed(sender) {
    // Empty allowlist = deny all (require explicit opt-in via WHATSAPP_ALLOWED_NUMBERS)
    if (this.allowedNumbers.size === 0) return false;

    // Direct JID match
    if (this.allowedNumbers.has(sender)) return true;

    // Strip WhatsApp JID suffix and try E.164 match
    const number = jidToNumber(sender);
    if (number && this.allowedNumbers.has(number)) return true;
    if (number && this.allowedNumbers.has("+" + number)) return true;

    return false;
  }
}

/**
 * Extract phone number from a WhatsApp JID.
 * @param {string} jid - e.g. "1234567890@s.whatsapp.net"
 * @returns {string | null}
 */
export function jidToNumber(jid) {
  if (!jid) return null;
  const match = jid.match(/^(\d+)@/);
  return match ? match[1] : null;
}

/**
 * Convert an E.164 phone number to a WhatsApp JID.
 * @param {string} number - e.g. "+1234567890" or "1234567890"
 * @returns {string}
 */
export function numberToJid(number) {
  const digits = number.replace(/[^0-9]/g, "");
  return `${digits}@s.whatsapp.net`;
}
