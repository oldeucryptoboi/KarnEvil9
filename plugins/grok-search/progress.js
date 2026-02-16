/**
 * Throttled journal event emitter for Grok search progress events.
 * Prevents flooding the journal with high-frequency progress updates.
 */

/** @type {Map<string, number>} */
const _lastEmitTime = new Map();

/** Minimum interval between progress events (ms) */
const THROTTLE_MS = 2000;

/**
 * Emit a search journal event, throttling progress events.
 *
 * @param {import("@karnevil9/journal").Journal} journal
 * @param {string} sessionId
 * @param {string} eventType - One of agent.started, agent.progress, agent.completed, agent.failed, agent.aborted
 * @param {Record<string, unknown>} payload
 */
export async function emitSearchEvent(journal, sessionId, eventType, payload) {
  // Throttle progress events only
  if (eventType === "agent.progress") {
    const key = `${sessionId}:progress`;
    const now = Date.now();
    const last = _lastEmitTime.get(key);
    if (last && now - last < THROTTLE_MS) {
      return; // Skip — too soon
    }
    _lastEmitTime.set(key, now);
  }

  // Clean up throttle state on terminal events
  if (eventType === "agent.completed" || eventType === "agent.failed" || eventType === "agent.aborted") {
    _lastEmitTime.delete(`${sessionId}:progress`);
  }

  try {
    await journal.emit(sessionId, eventType, payload);
  } catch {
    // Never throw from event emission — best effort
  }
}
