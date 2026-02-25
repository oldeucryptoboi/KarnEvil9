/**
 * HeartbeatService — periodic /home check to keep the agent active on Moltbook.
 *
 * Calls GET /home every 30 minutes and caches the last response
 * for the status route.
 */

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export class HeartbeatService {
  /**
   * @param {object} opts
   * @param {import("./moltbook-client.js").MoltbookClient} opts.client
   * @param {object} [opts.logger]
   */
  constructor({ client, logger }) {
    this.client = client;
    this.logger = logger;
    this._timer = null;
    this._running = false;
    this._lastResponse = null;
    this._lastCheckedAt = null;
    this._errorCount = 0;
    this._pendingDmCount = 0;
  }

  /**
   * Start the heartbeat polling loop.
   */
  start() {
    if (this._running) return;
    this._running = true;

    // Fire immediately, then schedule recurring
    this._tick();
    this._timer = setInterval(() => this._tick(), HEARTBEAT_INTERVAL_MS);
    this.logger?.info("Moltbook heartbeat started (30 min interval)");
  }

  /**
   * Stop the heartbeat polling loop.
   */
  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.logger?.info("Moltbook heartbeat stopped");
  }

  /**
   * Health check for service registry.
   * @returns {{ ok: boolean, lastCheckedAt: string|null, errorCount: number, lastResponse: object|null }}
   */
  health() {
    return {
      ok: this._running && this._errorCount < 5,
      lastCheckedAt: this._lastCheckedAt,
      errorCount: this._errorCount,
      lastResponse: this._lastResponse,
      pendingDmCount: this._pendingDmCount,
    };
  }

  /**
   * Single heartbeat tick.
   */
  async _tick() {
    try {
      this._lastResponse = await this.client.getHome();
      this._lastCheckedAt = new Date().toISOString();
      this._errorCount = 0;

      const karma = this._lastResponse.your_account?.karma;
      const unread = this._lastResponse.your_account?.unread_notification_count ?? 0;

      // Fetch pending DM requests count alongside the heartbeat
      try {
        const dmRes = await this.client.getDmRequests();
        const requests = dmRes.requests ?? dmRes.data ?? (Array.isArray(dmRes) ? dmRes : []);
        this._pendingDmCount = requests.length;
      } catch {
        // DM endpoint failure is non-fatal — keep previous count
      }

      this.logger?.info("Moltbook heartbeat OK", { karma, unread, pendingDms: this._pendingDmCount });
    } catch (err) {
      this._errorCount++;
      this.logger?.error("Moltbook heartbeat failed", { error: err.message, errorCount: this._errorCount });
    }
  }
}
