/**
 * PairingHandler — manages pending pairing codes for Telegram user onboarding.
 *
 * Flow: unknown user DMs bot → bot generates 6-char code → admin approves/denies via API route.
 * Codes expire after 1 hour and are auto-purged on list/create.
 */

const CODE_LENGTH = 6;
const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Alphanumeric sans ambiguous chars (0, O, 1, I)
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Generate a random alphanumeric code.
 * @returns {string}
 */
function generateCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

export class PairingHandler {
  constructor() {
    /** @type {Map<string, { userId: number, chatId: number, createdAt: number }>} code -> pairing info */
    this._pending = new Map();
    /** @type {Map<number, string>} userId -> code (for reuse) */
    this._userCodes = new Map();
  }

  /**
   * Purge expired codes.
   */
  _purgeExpired() {
    const now = Date.now();
    for (const [code, entry] of this._pending) {
      if (now - entry.createdAt > CODE_TTL_MS) {
        this._pending.delete(code);
        this._userCodes.delete(entry.userId);
      }
    }
  }

  /**
   * Create or reuse a pairing code for a user.
   * @param {number} userId - Telegram user ID
   * @param {number} chatId - Telegram chat ID
   * @returns {string} pairing code
   */
  createPairingCode(userId, chatId) {
    this._purgeExpired();

    // Reuse existing code for same user
    const existingCode = this._userCodes.get(userId);
    if (existingCode && this._pending.has(existingCode)) {
      return existingCode;
    }

    // Generate unique code
    let code;
    do {
      code = generateCode();
    } while (this._pending.has(code));

    this._pending.set(code, { userId, chatId, createdAt: Date.now() });
    this._userCodes.set(userId, code);
    return code;
  }

  /**
   * List all pending pairing requests.
   * @returns {Array<{ code: string, userId: number, chatId: number, createdAt: number }>}
   */
  listPending() {
    this._purgeExpired();
    const result = [];
    for (const [code, entry] of this._pending) {
      result.push({ code, ...entry });
    }
    return result;
  }

  /**
   * Approve a pairing code.
   * @param {string} code
   * @returns {{ userId: number, chatId: number } | null} null if code not found/expired
   */
  approve(code) {
    this._purgeExpired();
    const entry = this._pending.get(code);
    if (!entry) return null;
    this._pending.delete(code);
    this._userCodes.delete(entry.userId);
    return { userId: entry.userId, chatId: entry.chatId };
  }

  /**
   * Deny a pairing code.
   * @param {string} code
   * @returns {{ userId: number, chatId: number } | null} null if code not found/expired
   */
  deny(code) {
    this._purgeExpired();
    const entry = this._pending.get(code);
    if (!entry) return null;
    this._pending.delete(code);
    this._userCodes.delete(entry.userId);
    return { userId: entry.userId, chatId: entry.chatId };
  }

  /**
   * Number of pending pairings.
   * @returns {number}
   */
  get pendingCount() {
    this._purgeExpired();
    return this._pending.size;
  }
}
