/**
 * Webhook Notifications Plugin — sends HTTP callbacks on session lifecycle events.
 *
 * Registers hooks for after_step, after_session_end, and on_error to fire
 * webhook notifications. Exposes REST routes for CRUD management of webhook
 * configurations. Persists webhooks to webhooks.json alongside this plugin.
 */
import { randomUUID, createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Constants ──────────────────────────────────────────────────────
const MAX_WEBHOOKS = 50;
const DELIVERY_TIMEOUT_MS = 5000;
const MIN_SECRET_LENGTH = 16;
const KNOWN_EVENTS = new Set([
  "session.completed",
  "session.failed",
  "session.aborted",
  "step.succeeded",
  "step.failed",
  "step.started",
  "error",
]);

// ─── Webhook Store ──────────────────────────────────────────────────

/**
 * @typedef {Object} WebhookConfig
 * @property {string} id
 * @property {string} url
 * @property {string[]} events
 * @property {string} secret
 * @property {boolean} active
 * @property {string} created_at
 */

class WebhookStore {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {WebhookConfig[]} */
    this.webhooks = [];
    /** @type {Promise<void>} */
    this.writeLock = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.webhooks = parsed;
      }
    } catch {
      this.webhooks = [];
    }
  }

  async save() {
    const prev = this.writeLock;
    let release;
    this.writeLock = new Promise((r) => { release = r; });
    try {
      await prev;
      await writeFile(this.filePath, JSON.stringify(this.webhooks, null, 2) + "\n", "utf-8");
    } finally {
      release();
    }
  }

  list() {
    return this.webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      active: w.active,
      created_at: w.created_at,
      // secret is intentionally excluded from list responses
    }));
  }

  getById(id) {
    return this.webhooks.find((w) => w.id === id) ?? null;
  }

  /** @returns {{ webhook?: WebhookConfig; error?: string }} */
  add(url, events, secret) {
    if (this.webhooks.length >= MAX_WEBHOOKS) {
      return { error: `Maximum of ${MAX_WEBHOOKS} webhooks reached` };
    }

    const urlValidation = validateUrl(url);
    if (urlValidation) return { error: urlValidation };

    const eventsValidation = validateEvents(events);
    if (eventsValidation) return { error: eventsValidation };

    if (!secret || typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      return { error: `Secret must be at least ${MIN_SECRET_LENGTH} characters` };
    }

    /** @type {WebhookConfig} */
    const webhook = {
      id: randomUUID(),
      url,
      events,
      secret,
      active: true,
      created_at: new Date().toISOString(),
    };

    this.webhooks.push(webhook);
    return { webhook };
  }

  /** @returns {boolean} */
  remove(id) {
    const idx = this.webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    this.webhooks.splice(idx, 1);
    return true;
  }

  /** Get all active webhooks subscribed to a given event type. */
  getSubscribers(eventType) {
    return this.webhooks.filter((w) => w.active && w.events.includes(eventType));
  }
}

// ─── Validation Helpers ─────────────────────────────────────────────

function validateUrl(url) {
  if (!url || typeof url !== "string") return "URL is required";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return null;
    if (parsed.protocol === "http:") {
      // Allow HTTP only for localhost / 127.0.0.1 / [::1] (development)
      const host = parsed.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
        return null;
      }
      return "URL must use HTTPS (HTTP is only allowed for localhost)";
    }
    return "URL must use HTTPS";
  } catch {
    return "Invalid URL format";
  }
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return "Events must be a non-empty array";
  }
  const invalid = events.filter((e) => !KNOWN_EVENTS.has(e));
  if (invalid.length > 0) {
    return `Unknown events: ${invalid.join(", ")}. Known events: ${[...KNOWN_EVENTS].join(", ")}`;
  }
  return null;
}

// ─── Webhook Delivery ───────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 signature for a payload.
 * @param {string} body - JSON-stringified body
 * @param {string} secret - HMAC secret key
 * @returns {string} hex-encoded HMAC
 */
function computeSignature(body, secret) {
  return createHmac("sha256", secret).update(body, "utf-8").digest("hex");
}

/**
 * Deliver a webhook notification (fire-and-forget).
 * @param {WebhookConfig} webhook
 * @param {string} eventType
 * @param {Record<string, unknown>} payload
 * @param {import("@karnevil9/schemas").PluginLogger} logger
 */
async function deliverWebhook(webhook, eventType, payload, logger) {
  const body = JSON.stringify({
    event: eventType,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  const signature = computeSignature(body, webhook.secret);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    timer.unref?.();

    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Event": eventType,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.ok) {
      logger.debug(`Webhook delivered: ${eventType} -> ${webhook.url} (${response.status})`);
    } else {
      logger.warn(`Webhook delivery failed: ${eventType} -> ${webhook.url} (HTTP ${response.status})`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Webhook delivery error: ${eventType} -> ${webhook.url}: ${msg}`);
  }
}

/**
 * Fan-out delivery to all subscribers for a given event type.
 * @param {WebhookStore} store
 * @param {string} eventType
 * @param {Record<string, unknown>} payload
 * @param {import("@karnevil9/schemas").PluginLogger} logger
 */
function fireWebhooks(store, eventType, payload, logger) {
  const subscribers = store.getSubscribers(eventType);
  if (subscribers.length === 0) return;

  // Fire and forget — do not await
  for (const webhook of subscribers) {
    deliverWebhook(webhook, eventType, payload, logger).catch(() => {
      // Swallowed — deliverWebhook already logs errors
    });
  }
}

// ─── Plugin Entry Point ─────────────────────────────────────────────

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const storePath = resolve(pluginDir, "webhooks.json");
  const store = new WebhookStore(storePath);
  await store.load();

  // ── Hooks ──────────────────────────────────────────────────────────

  api.registerHook("after_step", async (context) => {
    const status = String(context.status ?? "");
    let eventType;
    if (status === "succeeded") {
      eventType = "step.succeeded";
    } else if (status === "failed") {
      eventType = "step.failed";
    } else if (status === "running") {
      eventType = "step.started";
    } else {
      // Unknown status — skip
      return { action: "observe" };
    }

    fireWebhooks(store, eventType, {
      session_id: context.session_id,
      step_id: context.step_id,
      status,
      output: context.output,
      error: context.error,
    }, api.logger);

    return { action: "observe" };
  });

  api.registerHook("after_session_end", async (context) => {
    const status = String(context.status ?? "");
    let eventType;
    if (status === "completed") {
      eventType = "session.completed";
    } else if (status === "failed") {
      eventType = "session.failed";
    } else if (status === "aborted") {
      eventType = "session.aborted";
    } else {
      return { action: "observe" };
    }

    fireWebhooks(store, eventType, {
      session_id: context.session_id,
      status,
    }, api.logger);

    return { action: "observe" };
  });

  api.registerHook("on_error", async (context) => {
    fireWebhooks(store, "error", {
      session_id: context.session_id,
      error: context.error,
      step_id: context.step_id,
    }, api.logger);

    return { action: "observe" };
  });

  // ── Routes ─────────────────────────────────────────────────────────

  // GET /webhooks — list all configured webhooks
  api.registerRoute("GET", "webhooks", async (_req, res) => {
    res.json({ webhooks: store.list() });
  });

  // POST /webhooks — register a new webhook
  api.registerRoute("POST", "webhooks", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Request body is required" });
      return;
    }

    const { url, events, secret } = /** @type {any} */ (body);
    const result = store.add(url, events, secret);

    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    await store.save();
    api.logger.info(`Webhook registered: ${result.webhook.id} -> ${result.webhook.url}`, {
      webhook_id: result.webhook.id,
      events: result.webhook.events,
    });

    res.status(201).json({
      webhook: {
        id: result.webhook.id,
        url: result.webhook.url,
        events: result.webhook.events,
        active: result.webhook.active,
        created_at: result.webhook.created_at,
      },
    });
  });

  // DELETE /webhooks/:id — remove a webhook
  api.registerRoute("DELETE", "webhooks/:id", async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "Webhook ID is required" });
      return;
    }

    const removed = store.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    await store.save();
    api.logger.info(`Webhook removed: ${id}`, { webhook_id: id });
    res.json({ status: "deleted", id });
  });

  // ── Service ────────────────────────────────────────────────────────

  api.registerService({
    name: "webhook-manager",
    async start() {
      await store.load();
      api.logger.info(`Webhook manager started (${store.webhooks.length} webhooks loaded)`);
    },
    async stop() {
      api.logger.info("Webhook manager stopped");
    },
    async health() {
      return {
        ok: true,
        detail: `${store.webhooks.filter((w) => w.active).length} active webhooks`,
      };
    },
  });

  api.logger.info(`Webhooks plugin registered (${store.webhooks.length} webhooks loaded)`);
}

// ─── Exports for Testing ────────────────────────────────────────────
export { WebhookStore, computeSignature, validateUrl, validateEvents, deliverWebhook, KNOWN_EVENTS };
