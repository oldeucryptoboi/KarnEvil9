import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { MoltbookClient } from "./moltbook-client.js";

// ── Fetch mock setup ──

const originalFetch = globalThis.fetch;

/** Create a mock fetch that resolves with given body and status. */
function mockFetch(body, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Helper: create a fresh client for each test. */
function makeClient() {
  return new MoltbookClient({
    apiKey: "moltbook_sk_test",
    agentName: "test-agent",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

/** Assert the last fetch call used the expected method, path, and headers. */
function expectFetch(method, pathSuffix, bodyMatch) {
  const calls = globalThis.fetch.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [url, opts] = calls[calls.length - 1];
  expect(url).toContain(pathSuffix);
  expect(opts.method).toBe(method);
  expect(opts.headers.Authorization).toBe("Bearer moltbook_sk_test");

  if (bodyMatch !== undefined) {
    if (bodyMatch === null) {
      expect(opts.body).toBeUndefined();
    } else {
      expect(JSON.parse(opts.body)).toEqual(bodyMatch);
    }
  }
}

// ── DM methods ──

describe("MoltbookClient — DM methods", () => {
  it("getDmRequests() calls GET /agents/dm/requests", async () => {
    const client = makeClient();
    mockFetch({ requests: [] });
    await client.getDmRequests();
    expectFetch("GET", "/agents/dm/requests");
  });

  it("getDmConversations() calls GET /agents/dm/conversations", async () => {
    const client = makeClient();
    mockFetch({ conversations: [] });
    await client.getDmConversations();
    expectFetch("GET", "/agents/dm/conversations");
  });

  it("getDmConversation(id) calls GET /agents/dm/conversations/:id", async () => {
    const client = makeClient();
    mockFetch({ messages: [] });
    await client.getDmConversation("conv_123");
    expectFetch("GET", "/agents/dm/conversations/conv_123");
  });

  it("approveDmRequest(id) calls POST /agents/dm/requests/:id/approve", async () => {
    const client = makeClient();
    mockFetch({ ok: true });
    await client.approveDmRequest("conv_456");
    expectFetch("POST", "/agents/dm/requests/conv_456/approve");
  });

  it("rejectDmRequest(id) calls POST with no body when block not set", async () => {
    const client = makeClient();
    mockFetch({ ok: true });
    await client.rejectDmRequest("conv_789");
    expectFetch("POST", "/agents/dm/requests/conv_789/reject", null);
  });

  it("rejectDmRequest(id, { block: true }) sends { block: true } body", async () => {
    const client = makeClient();
    mockFetch({ ok: true });
    await client.rejectDmRequest("conv_789", { block: true });
    expectFetch("POST", "/agents/dm/requests/conv_789/reject", { block: true });
  });

  it("sendDm(id, content) calls POST with { content } body", async () => {
    const client = makeClient();
    mockFetch({ ok: true });
    await client.sendDm("conv_101", "Hello there!");
    expectFetch("POST", "/agents/dm/conversations/conv_101/send", { content: "Hello there!" });
  });
});

// ── Follow methods ──

describe("MoltbookClient — follow methods", () => {
  it("follow(name) calls POST /agents/:name/follow", async () => {
    const client = makeClient();
    mockFetch({ ok: true });
    await client.follow("cool-agent");
    expectFetch("POST", "/agents/cool-agent/follow");
  });

  it("unfollow(name) calls POST /agents/:name/unfollow", async () => {
    const client = makeClient();
    mockFetch({ ok: true });
    await client.unfollow("cool-agent");
    expectFetch("POST", "/agents/cool-agent/unfollow");
  });
});

// ── Notification methods ──

describe("MoltbookClient — notification methods", () => {
  it("getNotifications() calls GET /notifications", async () => {
    const client = makeClient();
    mockFetch({ notifications: [] });
    await client.getNotifications();
    expectFetch("GET", "/notifications");
  });

  it("markNotificationsRead() calls POST /notifications/read-all", async () => {
    const client = makeClient();
    mockFetch({ ok: true });
    await client.markNotificationsRead();
    expectFetch("POST", "/notifications/read-all");
  });

  it("markPostNotificationsRead(postId) calls POST /notifications/read-by-post/:postId", async () => {
    const client = makeClient();
    mockFetch({ ok: true });
    await client.markPostNotificationsRead("post_abc");
    expectFetch("POST", "/notifications/read-by-post/post_abc");
  });
});

// ── Existing methods ──

describe("MoltbookClient — existing methods", () => {
  it("init() calls GET /agents/me and sets profile + connected", async () => {
    const client = makeClient();
    mockFetch({ name: "eddie", karma: 42 });
    const res = await client.init();
    expectFetch("GET", "/agents/me");
    expect(client.connected).toBe(true);
    expect(client.agentName).toBe("eddie");
    expect(client.profile).toEqual({ name: "eddie", karma: 42 });
    expect(res).toEqual({ name: "eddie", karma: 42 });
  });

  it("createPost() calls POST /posts and updates _lastPostAt", async () => {
    const client = makeClient();
    const before = Date.now();
    mockFetch({ post: { id: "p1", title: "Test" } });
    await client.createPost({ submolt: "general", title: "Test", content: "body" });
    expectFetch("POST", "/posts", { submolt_name: "general", title: "Test", content: "body" });
    expect(client._lastPostAt).toBeGreaterThanOrEqual(before);
  });

  it("createComment() dedup guard suppresses duplicates within 60s", async () => {
    const client = makeClient();
    mockFetch({ comment: { id: "c1" } });
    await client.createComment({ postId: "p1", content: "Great post!" });
    // Second identical call should be suppressed
    const dup = await client.createComment({ postId: "p1", content: "Great post!" });
    expect(dup.duplicate).toBe(true);
    expect(dup.comment.id).toBe("duplicate_suppressed");
    // fetch should have been called only once (first comment)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("_apiRequest — 429 throws with .status, .retryAfter, .body", async () => {
    const client = makeClient();
    const errorBody = { retry_after_minutes: 5, message: "slow down" };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn().mockResolvedValue(errorBody),
      text: vi.fn().mockResolvedValue(JSON.stringify(errorBody)),
    });
    try {
      await client.getHome();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err.status).toBe(429);
      expect(err.retryAfter).toBe(5);
      expect(err.body).toEqual(errorBody);
    }
  });

  it("_apiRequest — non-ok throws with status text", async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error("not json")),
      text: vi.fn().mockResolvedValue("Internal Server Error"),
    });
    await expect(client.getHome()).rejects.toThrow(/500.*Internal Server Error/);
  });

  it("canPost() returns true initially and false right after posting", async () => {
    const client = makeClient();
    expect(client.canPost()).toBe(true);
    mockFetch({ post: { id: "p1", title: "T" } });
    await client.createPost({ submolt: "s", title: "T" });
    expect(client.canPost()).toBe(false);
  });

  it("canComment() returns true initially and false right after commenting", async () => {
    const client = makeClient();
    expect(client.canComment()).toBe(true);
    mockFetch({ comment: { id: "c1" } });
    await client.createComment({ postId: "p1", content: "Hi" });
    expect(client.canComment()).toBe(false);
  });
});
