import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WebhookStore,
  computeSignature,
  validateUrl,
  validateEvents,
  deliverWebhook,
  KNOWN_EVENTS,
} from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_STORE_PATH = resolve(__dirname, "webhooks.test.tmp.json");

/** Create a fresh temporary store file for each test. */
async function createTempStore() {
  await writeFile(TEST_STORE_PATH, "[]", "utf-8");
  return new WebhookStore(TEST_STORE_PATH);
}

/** Clean up temp file. */
async function cleanupTempStore() {
  try { await unlink(TEST_STORE_PATH); } catch { /* ignore */ }
}

/** Create a mock logger. */
function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ─── URL Validation ──────────────────────────────────────────────────

describe("validateUrl", () => {
  it("accepts HTTPS URLs", () => {
    expect(validateUrl("https://example.com/webhook")).toBeNull();
  });

  it("accepts HTTP localhost", () => {
    expect(validateUrl("http://localhost:4000/hook")).toBeNull();
    expect(validateUrl("http://127.0.0.1:4000/hook")).toBeNull();
  });

  it("rejects HTTP non-localhost", () => {
    const err = validateUrl("http://example.com/webhook");
    expect(err).toContain("HTTPS");
  });

  it("rejects non-URL strings", () => {
    expect(validateUrl("not-a-url")).toBeTruthy();
  });

  it("rejects missing URL", () => {
    expect(validateUrl("")).toBeTruthy();
    expect(validateUrl(null)).toBeTruthy();
    expect(validateUrl(undefined)).toBeTruthy();
  });

  it("rejects non-HTTP protocols", () => {
    expect(validateUrl("ftp://example.com")).toBeTruthy();
    expect(validateUrl("ws://example.com")).toBeTruthy();
  });
});

// ─── Event Validation ────────────────────────────────────────────────

describe("validateEvents", () => {
  it("accepts known events", () => {
    expect(validateEvents(["session.completed", "step.failed"])).toBeNull();
  });

  it("rejects unknown events", () => {
    const err = validateEvents(["session.completed", "bogus.event"]);
    expect(err).toContain("bogus.event");
  });

  it("rejects empty array", () => {
    expect(validateEvents([])).toBeTruthy();
  });

  it("rejects non-array", () => {
    expect(validateEvents("session.completed")).toBeTruthy();
    expect(validateEvents(null)).toBeTruthy();
  });

  it("all KNOWN_EVENTS are accepted", () => {
    expect(validateEvents([...KNOWN_EVENTS])).toBeNull();
  });
});

// ─── HMAC Signature ──────────────────────────────────────────────────

describe("computeSignature", () => {
  it("produces a hex string", () => {
    const sig = computeSignature('{"test":true}', "my-secret-key-1234567890");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const body = '{"event":"session.completed"}';
    const secret = "super-secret-key-abcdef";
    const sig1 = computeSignature(body, secret);
    const sig2 = computeSignature(body, secret);
    expect(sig1).toBe(sig2);
  });

  it("changes with different bodies", () => {
    const secret = "super-secret-key-abcdef";
    const sig1 = computeSignature('{"a":1}', secret);
    const sig2 = computeSignature('{"a":2}', secret);
    expect(sig1).not.toBe(sig2);
  });

  it("changes with different secrets", () => {
    const body = '{"event":"test"}';
    const sig1 = computeSignature(body, "secret-key-aaaa1234");
    const sig2 = computeSignature(body, "secret-key-bbbb5678");
    expect(sig1).not.toBe(sig2);
  });
});

// ─── WebhookStore CRUD ──────────────────────────────────────────────

describe("WebhookStore", () => {
  let store;

  beforeEach(async () => {
    store = await createTempStore();
    await store.load();
  });

  afterEach(async () => {
    await cleanupTempStore();
  });

  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("adds a webhook", () => {
    const result = store.add(
      "https://example.com/hook",
      ["session.completed"],
      "my-secret-key-1234567890",
    );
    expect(result.error).toBeUndefined();
    expect(result.webhook).toBeDefined();
    expect(result.webhook.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.webhook.url).toBe("https://example.com/hook");
    expect(result.webhook.events).toEqual(["session.completed"]);
    expect(result.webhook.active).toBe(true);
    expect(result.webhook.created_at).toBeTruthy();
  });

  it("list excludes secret", () => {
    store.add("https://example.com/hook", ["session.completed"], "my-secret-key-1234567890");
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].secret).toBeUndefined();
    expect(listed[0].url).toBe("https://example.com/hook");
  });

  it("getById retrieves a webhook with secret", () => {
    const { webhook } = store.add("https://example.com/hook", ["session.completed"], "my-secret-key-1234567890");
    const found = store.getById(webhook.id);
    expect(found).toBeDefined();
    expect(found.secret).toBe("my-secret-key-1234567890");
  });

  it("removes a webhook", () => {
    const { webhook } = store.add("https://example.com/hook", ["session.completed"], "my-secret-key-1234567890");
    expect(store.remove(webhook.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("returns false when removing non-existent webhook", () => {
    expect(store.remove(randomUUID())).toBe(false);
  });

  it("persists to disk and reloads", async () => {
    store.add("https://example.com/hook1", ["session.completed"], "secret-key-abcdef-1234");
    store.add("https://example.com/hook2", ["step.failed"], "secret-key-ghijkl-5678");
    await store.save();

    const store2 = new WebhookStore(TEST_STORE_PATH);
    await store2.load();
    expect(store2.list()).toHaveLength(2);
  });

  it("rejects invalid URL", () => {
    const result = store.add("http://evil.com/hook", ["session.completed"], "my-secret-key-1234567890");
    expect(result.error).toContain("HTTPS");
  });

  it("rejects invalid events", () => {
    const result = store.add("https://example.com/hook", ["made.up"], "my-secret-key-1234567890");
    expect(result.error).toContain("made.up");
  });

  it("rejects short secret", () => {
    const result = store.add("https://example.com/hook", ["session.completed"], "short");
    expect(result.error).toContain("16 characters");
  });

  it("enforces max webhooks limit", () => {
    for (let i = 0; i < 50; i++) {
      store.add(`https://example.com/hook${i}`, ["session.completed"], `secret-long-enough-${i}-pad`);
    }
    expect(store.list()).toHaveLength(50);

    const result = store.add("https://example.com/hook50", ["session.completed"], "secret-long-enough-extra");
    expect(result.error).toContain("Maximum");
  });

  it("getSubscribers filters by event and active status", () => {
    store.add("https://a.com/hook", ["session.completed", "step.failed"], "secret-key-aaaa-1234-5678");
    store.add("https://b.com/hook", ["step.failed"], "secret-key-bbbb-5678-9012");
    store.add("https://c.com/hook", ["session.failed"], "secret-key-cccc-9012-3456");

    const stepFailedSubs = store.getSubscribers("step.failed");
    expect(stepFailedSubs).toHaveLength(2);

    const sessionCompletedSubs = store.getSubscribers("session.completed");
    expect(sessionCompletedSubs).toHaveLength(1);
    expect(sessionCompletedSubs[0].url).toBe("https://a.com/hook");

    const noSubs = store.getSubscribers("error");
    expect(noSubs).toHaveLength(0);
  });

  it("getSubscribers excludes inactive webhooks", () => {
    const { webhook } = store.add("https://a.com/hook", ["session.completed"], "secret-key-aaaa-1234-5678");
    webhook.active = false;
    expect(store.getSubscribers("session.completed")).toHaveLength(0);
  });

  it("handles corrupted JSON on load", async () => {
    await writeFile(TEST_STORE_PATH, "{not valid json", "utf-8");
    const corruptStore = new WebhookStore(TEST_STORE_PATH);
    await corruptStore.load();
    expect(corruptStore.list()).toEqual([]);
  });

  it("handles missing file on load", async () => {
    const missingStore = new WebhookStore(resolve(__dirname, "does-not-exist.json"));
    await missingStore.load();
    expect(missingStore.list()).toEqual([]);
  });
});

// ─── Webhook Delivery with Local HTTP Server ────────────────────────

describe("deliverWebhook", () => {
  let server;
  let port;
  let receivedRequests;

  beforeEach(async () => {
    receivedRequests = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        receivedRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("sends POST with correct headers and body", async () => {
    const webhook = {
      id: randomUUID(),
      url: `http://127.0.0.1:${port}/hook`,
      events: ["session.completed"],
      secret: "test-secret-key-1234567890",
      active: true,
      created_at: new Date().toISOString(),
    };

    const logger = mockLogger();
    await deliverWebhook(webhook, "session.completed", { session_id: "s1" }, logger);

    // Wait a tick for async delivery
    await new Promise((r) => setTimeout(r, 100));

    expect(receivedRequests).toHaveLength(1);
    const req = receivedRequests[0];
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-webhook-event"]).toBe("session.completed");
    expect(req.headers["x-webhook-signature"]).toBeTruthy();

    const parsed = JSON.parse(req.body);
    expect(parsed.event).toBe("session.completed");
    expect(parsed.data.session_id).toBe("s1");
    expect(parsed.timestamp).toBeTruthy();
  });

  it("signature matches HMAC-SHA256 of body", async () => {
    const secret = "verification-secret-key-1234";
    const webhook = {
      id: randomUUID(),
      url: `http://127.0.0.1:${port}/hook`,
      events: ["step.failed"],
      secret,
      active: true,
      created_at: new Date().toISOString(),
    };

    const logger = mockLogger();
    await deliverWebhook(webhook, "step.failed", { step_id: "st1" }, logger);
    await new Promise((r) => setTimeout(r, 100));

    expect(receivedRequests).toHaveLength(1);
    const req = receivedRequests[0];
    const expectedSig = computeSignature(req.body, secret);
    expect(req.headers["x-webhook-signature"]).toBe(expectedSig);
  });

  it("logs warning on HTTP error response", async () => {
    // Create a server that returns 500
    const errServer = createServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
    await new Promise((resolve) => {
      errServer.listen(0, "127.0.0.1", () => resolve());
    });
    const errPort = errServer.address().port;

    const webhook = {
      id: randomUUID(),
      url: `http://127.0.0.1:${errPort}/hook`,
      events: ["session.completed"],
      secret: "error-test-secret-1234567890",
      active: true,
      created_at: new Date().toISOString(),
    };

    const logger = mockLogger();
    await deliverWebhook(webhook, "session.completed", {}, logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("500"));

    await new Promise((resolve) => errServer.close(resolve));
  });

  it("logs warning on connection error (unreachable host)", async () => {
    const webhook = {
      id: randomUUID(),
      url: "http://127.0.0.1:1/unreachable",
      events: ["session.completed"],
      secret: "unreachable-test-secret-12345",
      active: true,
      created_at: new Date().toISOString(),
    };

    const logger = mockLogger();
    await deliverWebhook(webhook, "session.completed", {}, logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("delivery error"));
  });

  it("logs debug on successful delivery", async () => {
    const webhook = {
      id: randomUUID(),
      url: `http://127.0.0.1:${port}/hook`,
      events: ["session.completed"],
      secret: "success-test-secret-1234567890",
      active: true,
      created_at: new Date().toISOString(),
    };

    const logger = mockLogger();
    await deliverWebhook(webhook, "session.completed", {}, logger);

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("delivered"));
  });
});

// ─── Event Filtering (integration) ──────────────────────────────────

describe("Event filtering", () => {
  let store;

  beforeEach(async () => {
    store = await createTempStore();
    await store.load();
  });

  afterEach(async () => {
    await cleanupTempStore();
  });

  it("only matches subscribed events", () => {
    store.add("https://a.com/hook", ["session.completed"], "secret-key-filter-test-12345");
    store.add("https://b.com/hook", ["step.failed", "error"], "secret-key-filter-test-67890");

    // session.completed -> only a.com
    expect(store.getSubscribers("session.completed").map((w) => w.url)).toEqual(["https://a.com/hook"]);

    // step.failed -> only b.com
    expect(store.getSubscribers("step.failed").map((w) => w.url)).toEqual(["https://b.com/hook"]);

    // error -> only b.com
    expect(store.getSubscribers("error").map((w) => w.url)).toEqual(["https://b.com/hook"]);

    // session.failed -> nobody
    expect(store.getSubscribers("session.failed")).toHaveLength(0);
  });

  it("all known events are recognized", () => {
    // Ensure we cover the full set
    expect(KNOWN_EVENTS.size).toBeGreaterThanOrEqual(7);
    expect(KNOWN_EVENTS.has("session.completed")).toBe(true);
    expect(KNOWN_EVENTS.has("session.failed")).toBe(true);
    expect(KNOWN_EVENTS.has("session.aborted")).toBe(true);
    expect(KNOWN_EVENTS.has("step.succeeded")).toBe(true);
    expect(KNOWN_EVENTS.has("step.failed")).toBe(true);
    expect(KNOWN_EVENTS.has("step.started")).toBe(true);
    expect(KNOWN_EVENTS.has("error")).toBe(true);
  });
});
