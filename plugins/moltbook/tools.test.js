import { describe, it, expect, vi } from "vitest";
import {
  createPostHandler,
  createCommentHandler,
  createVoteHandler,
  createGetPostHandler,
  createFeedHandler,
  createSearchHandler,
  createDmHandler,
  createFollowHandler,
  createNotificationsHandler,
  allManifests,
} from "./tools.js";

// ── Mock client factory ──

function makeClient(overrides = {}) {
  return {
    canPost: vi.fn().mockReturnValue(true),
    canComment: vi.fn().mockReturnValue(true),
    createPost: vi.fn().mockResolvedValue({ post: { id: "p1", title: "Test", verification: true } }),
    createComment: vi.fn().mockResolvedValue({ comment: { id: "c1", verification: true } }),
    vote: vi.fn().mockResolvedValue({}),
    getPost: vi.fn().mockResolvedValue({ post: { id: "p1", title: "Test" }, comments: [{ id: "c1" }] }),
    getFeed: vi.fn().mockResolvedValue({ posts: [{ id: "p1" }], has_more: false }),
    search: vi.fn().mockResolvedValue({ results: [{ id: "r1" }], count: 1 }),
    getDmRequests: vi.fn().mockResolvedValue({ requests: [] }),
    getDmConversations: vi.fn().mockResolvedValue({ conversations: [] }),
    getDmConversation: vi.fn().mockResolvedValue({ messages: [] }),
    approveDmRequest: vi.fn().mockResolvedValue({ ok: true }),
    rejectDmRequest: vi.fn().mockResolvedValue({ ok: true }),
    sendDm: vi.fn().mockResolvedValue({ ok: true }),
    follow: vi.fn().mockResolvedValue({}),
    unfollow: vi.fn().mockResolvedValue({}),
    getNotifications: vi.fn().mockResolvedValue({ notifications: [] }),
    markNotificationsRead: vi.fn().mockResolvedValue({ ok: true }),
    markPostNotificationsRead: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

// ── Manifests ──

describe("allManifests", () => {
  it("exports 9 tool manifests", () => {
    expect(allManifests).toHaveLength(9);
  });

  it("each manifest has required fields", () => {
    for (const m of allManifests) {
      expect(m.name).toEqual(expect.any(String));
      expect(m.version).toBe("1.0.0");
      expect(m.input_schema).toBeDefined();
      expect(m.permissions).toEqual(expect.any(Array));
      expect(m.supports.mock).toBe(true);
      expect(m.supports.dry_run).toBe(true);
    }
  });

  it("manifest names are unique", () => {
    const names = allManifests.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ── createPostHandler ──

describe("createPostHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createPostHandler(makeClient());
    const result = await handler({ title: "My Post", submolt: "general" }, "mock");
    expect(result.ok).toBe(true);
    expect(result.post_id).toBe("mock_post_id");
    expect(result.title).toBe("My Post");
    expect(result.verification_solved).toBe(true);
  });

  it("returns dry_run output with canPost check", async () => {
    const client = makeClient();
    const handler = createPostHandler(client);
    const result = await handler({ title: "My Post", submolt: "general" }, "dry_run");
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.can_post).toBe(true);
    expect(client.canPost).toHaveBeenCalled();
  });

  it("delegates to client.createPost in real mode", async () => {
    const client = makeClient();
    const handler = createPostHandler(client);
    const result = await handler({ submolt: "general", title: "Hello", content: "body", url: "http://x.com" }, "real");
    expect(client.createPost).toHaveBeenCalledWith({
      submolt: "general",
      title: "Hello",
      content: "body",
      url: "http://x.com",
    });
    expect(result.ok).toBe(true);
    expect(result.post_id).toBe("p1");
    expect(result.verification_solved).toBe(true);
  });

  it("handles response without nested post object", async () => {
    const client = makeClient({ createPost: vi.fn().mockResolvedValue({ id: "p2", title: "Direct" }) });
    const handler = createPostHandler(client);
    const result = await handler({ submolt: "s", title: "T" }, "real");
    expect(result.post_id).toBe("p2");
  });
});

// ── createCommentHandler ──

describe("createCommentHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createCommentHandler(makeClient());
    const result = await handler({ post_id: "p1", content: "Nice" }, "mock");
    expect(result.ok).toBe(true);
    expect(result.comment_id).toBe("mock_comment_id");
    expect(result.verification_solved).toBe(true);
  });

  it("returns dry_run output with canComment check", async () => {
    const client = makeClient();
    const handler = createCommentHandler(client);
    const result = await handler({ post_id: "p1", content: "Nice" }, "dry_run");
    expect(result.dry_run).toBe(true);
    expect(result.can_comment).toBe(true);
    expect(client.canComment).toHaveBeenCalled();
  });

  it("delegates to client.createComment in real mode", async () => {
    const client = makeClient();
    const handler = createCommentHandler(client);
    await handler({ post_id: "p1", content: "Reply", parent_id: "c0" }, "real");
    expect(client.createComment).toHaveBeenCalledWith({
      postId: "p1",
      content: "Reply",
      parentId: "c0",
    });
  });

  it("handles response without nested comment object", async () => {
    const client = makeClient({ createComment: vi.fn().mockResolvedValue({ id: "c2", verification: false }) });
    const handler = createCommentHandler(client);
    const result = await handler({ post_id: "p1", content: "Hi" }, "real");
    expect(result.comment_id).toBe("c2");
    expect(result.verification_solved).toBe(false);
  });
});

// ── createVoteHandler ──

describe("createVoteHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createVoteHandler(makeClient());
    const result = await handler({ target_type: "post", target_id: "p1", direction: "up" }, "mock");
    expect(result).toEqual({ ok: true });
  });

  it("returns dry_run output with input echo", async () => {
    const handler = createVoteHandler(makeClient());
    const result = await handler({ target_type: "comment", target_id: "c1", direction: "down" }, "dry_run");
    expect(result.dry_run).toBe(true);
    expect(result.target_type).toBe("comment");
    expect(result.direction).toBe("down");
  });

  it("delegates to client.vote in real mode", async () => {
    const client = makeClient();
    const handler = createVoteHandler(client);
    const result = await handler({ target_type: "post", target_id: "p1", direction: "up" }, "real");
    expect(client.vote).toHaveBeenCalledWith({
      targetType: "post",
      targetId: "p1",
      direction: "up",
    });
    expect(result).toEqual({ ok: true });
  });
});

// ── createGetPostHandler ──

describe("createGetPostHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createGetPostHandler(makeClient());
    const result = await handler({ post_id: "p1" }, "mock");
    expect(result.ok).toBe(true);
    expect(result.post.id).toBe("p1");
    expect(result.comments).toEqual([]);
  });

  it("returns dry_run output in dry_run mode", async () => {
    const handler = createGetPostHandler(makeClient());
    const result = await handler({ post_id: "p1" }, "dry_run");
    expect(result.dry_run).toBe(true);
    expect(result.post_id).toBe("p1");
  });

  it("delegates to client.getPost with comments in real mode", async () => {
    const client = makeClient();
    const handler = createGetPostHandler(client);
    const result = await handler({ post_id: "p1" }, "real");
    expect(client.getPost).toHaveBeenCalledWith("p1", { includeComments: true });
    expect(result.post.id).toBe("p1");
    expect(result.comments).toEqual([{ id: "c1" }]);
  });

  it("passes include_comments=false to client", async () => {
    const client = makeClient();
    const handler = createGetPostHandler(client);
    await handler({ post_id: "p1", include_comments: false }, "real");
    expect(client.getPost).toHaveBeenCalledWith("p1", { includeComments: false });
  });

  it("defaults comments to empty array when response lacks them", async () => {
    const client = makeClient({ getPost: vi.fn().mockResolvedValue({ post: { id: "p1" } }) });
    const handler = createGetPostHandler(client);
    const result = await handler({ post_id: "p1" }, "real");
    expect(result.comments).toEqual([]);
  });
});

// ── createFeedHandler ──

describe("createFeedHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createFeedHandler(makeClient());
    const result = await handler({}, "mock");
    expect(result).toEqual({ ok: true, posts: [], has_more: false });
  });

  it("returns dry_run output with source echo", async () => {
    const handler = createFeedHandler(makeClient());
    const result = await handler({ source: "submolt" }, "dry_run");
    expect(result.dry_run).toBe(true);
    expect(result.source).toBe("submolt");
  });

  it("defaults source to 'home' in dry_run mode", async () => {
    const handler = createFeedHandler(makeClient());
    const result = await handler({}, "dry_run");
    expect(result.source).toBe("home");
  });

  it("delegates to client.getFeed with all params in real mode", async () => {
    const client = makeClient();
    const handler = createFeedHandler(client);
    const result = await handler({ source: "submolt", submolt: "tech", sort: "hot", limit: 10, cursor: "abc" }, "real");
    expect(client.getFeed).toHaveBeenCalledWith({
      source: "submolt",
      submolt: "tech",
      sort: "hot",
      limit: 10,
      cursor: "abc",
    });
    expect(result.posts).toEqual([{ id: "p1" }]);
    expect(result.has_more).toBe(false);
  });

  it("handles alternative response shapes (data array, bare array)", async () => {
    const client = makeClient({ getFeed: vi.fn().mockResolvedValue({ data: [{ id: "d1" }] }) });
    const handler = createFeedHandler(client);
    const result = await handler({}, "real");
    expect(result.posts).toEqual([{ id: "d1" }]);
  });
});

// ── createSearchHandler ──

describe("createSearchHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createSearchHandler(makeClient());
    const result = await handler({ query: "test" }, "mock");
    expect(result).toEqual({ ok: true, results: [], count: 0 });
  });

  it("returns dry_run output with query echo", async () => {
    const handler = createSearchHandler(makeClient());
    const result = await handler({ query: "hello" }, "dry_run");
    expect(result.dry_run).toBe(true);
    expect(result.query).toBe("hello");
  });

  it("delegates to client.search in real mode", async () => {
    const client = makeClient();
    const handler = createSearchHandler(client);
    const result = await handler({ query: "ai", type: "post", limit: 5 }, "real");
    expect(client.search).toHaveBeenCalledWith({ query: "ai", type: "post", limit: 5 });
    expect(result.results).toEqual([{ id: "r1" }]);
    expect(result.count).toBe(1);
  });

  it("falls back count to results.length when count missing", async () => {
    const client = makeClient({ search: vi.fn().mockResolvedValue({ results: [{ id: "r1" }, { id: "r2" }] }) });
    const handler = createSearchHandler(client);
    const result = await handler({ query: "x" }, "real");
    expect(result.count).toBe(2);
  });
});

// ── createDmHandler ──

describe("createDmHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createDmHandler(makeClient());
    const result = await handler({ action: "list_requests" }, "mock");
    expect(result).toEqual({ ok: true, data: {} });
  });

  it("returns dry_run output with action echo", async () => {
    const handler = createDmHandler(makeClient());
    const result = await handler({ action: "send" }, "dry_run");
    expect(result.dry_run).toBe(true);
    expect(result.action).toBe("send");
  });

  it("action: list_requests delegates to getDmRequests", async () => {
    const client = makeClient();
    const handler = createDmHandler(client);
    const result = await handler({ action: "list_requests" }, "real");
    expect(client.getDmRequests).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("action: list_conversations delegates to getDmConversations", async () => {
    const client = makeClient();
    const handler = createDmHandler(client);
    const result = await handler({ action: "list_conversations" }, "real");
    expect(client.getDmConversations).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("action: get_conversation delegates to getDmConversation", async () => {
    const client = makeClient();
    const handler = createDmHandler(client);
    await handler({ action: "get_conversation", conversation_id: "conv_1" }, "real");
    expect(client.getDmConversation).toHaveBeenCalledWith("conv_1");
  });

  it("action: approve delegates to approveDmRequest", async () => {
    const client = makeClient();
    const handler = createDmHandler(client);
    await handler({ action: "approve", conversation_id: "conv_2" }, "real");
    expect(client.approveDmRequest).toHaveBeenCalledWith("conv_2");
  });

  it("action: reject delegates to rejectDmRequest with block option", async () => {
    const client = makeClient();
    const handler = createDmHandler(client);
    await handler({ action: "reject", conversation_id: "conv_3", block: true }, "real");
    expect(client.rejectDmRequest).toHaveBeenCalledWith("conv_3", { block: true });
  });

  it("action: send delegates to sendDm", async () => {
    const client = makeClient();
    const handler = createDmHandler(client);
    await handler({ action: "send", conversation_id: "conv_4", content: "Hello!" }, "real");
    expect(client.sendDm).toHaveBeenCalledWith("conv_4", "Hello!");
  });

  it("unknown action returns error", async () => {
    const handler = createDmHandler(makeClient());
    const result = await handler({ action: "invalid" }, "real");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown DM action");
  });
});

// ── createFollowHandler ──

describe("createFollowHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createFollowHandler(makeClient());
    const result = await handler({ action: "follow", agent_name: "bot" }, "mock");
    expect(result).toEqual({ ok: true });
  });

  it("returns dry_run output with action and agent_name echo", async () => {
    const handler = createFollowHandler(makeClient());
    const result = await handler({ action: "unfollow", agent_name: "bot" }, "dry_run");
    expect(result.dry_run).toBe(true);
    expect(result.action).toBe("unfollow");
    expect(result.agent_name).toBe("bot");
  });

  it("action: follow delegates to client.follow", async () => {
    const client = makeClient();
    const handler = createFollowHandler(client);
    const result = await handler({ action: "follow", agent_name: "cool-agent" }, "real");
    expect(client.follow).toHaveBeenCalledWith("cool-agent");
    expect(result).toEqual({ ok: true });
  });

  it("action: unfollow delegates to client.unfollow", async () => {
    const client = makeClient();
    const handler = createFollowHandler(client);
    const result = await handler({ action: "unfollow", agent_name: "spam-bot" }, "real");
    expect(client.unfollow).toHaveBeenCalledWith("spam-bot");
    expect(result).toEqual({ ok: true });
  });
});

// ── createNotificationsHandler ──

describe("createNotificationsHandler", () => {
  it("returns mock output in mock mode", async () => {
    const handler = createNotificationsHandler(makeClient());
    const result = await handler({ action: "list" }, "mock");
    expect(result).toEqual({ ok: true, data: {} });
  });

  it("returns dry_run output with action echo", async () => {
    const handler = createNotificationsHandler(makeClient());
    const result = await handler({ action: "mark_read" }, "dry_run");
    expect(result.dry_run).toBe(true);
    expect(result.action).toBe("mark_read");
  });

  it("action: list delegates to getNotifications", async () => {
    const client = makeClient();
    const handler = createNotificationsHandler(client);
    const result = await handler({ action: "list" }, "real");
    expect(client.getNotifications).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("action: mark_read delegates to markNotificationsRead", async () => {
    const client = makeClient();
    const handler = createNotificationsHandler(client);
    await handler({ action: "mark_read" }, "real");
    expect(client.markNotificationsRead).toHaveBeenCalled();
  });

  it("action: mark_post_read delegates to markPostNotificationsRead", async () => {
    const client = makeClient();
    const handler = createNotificationsHandler(client);
    await handler({ action: "mark_post_read", post_id: "p1" }, "real");
    expect(client.markPostNotificationsRead).toHaveBeenCalledWith("p1");
  });

  it("unknown action returns error", async () => {
    const handler = createNotificationsHandler(makeClient());
    const result = await handler({ action: "invalid" }, "real");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown notifications action");
  });
});
