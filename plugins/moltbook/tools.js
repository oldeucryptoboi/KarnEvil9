/**
 * tools — Moltbook tool manifests + handler factories.
 *
 * 9 tools: moltbook-post, moltbook-comment, moltbook-vote, moltbook-get-post,
 *          moltbook-feed, moltbook-search, moltbook-dm, moltbook-follow, moltbook-notifications
 */

// ── Manifests ──

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookPostManifest = {
  name: "moltbook-post",
  version: "1.0.0",
  description: "Create a post on Moltbook",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      submolt: { type: "string", description: "Submolt (community) to post in" },
      title: { type: "string", description: "Post title" },
      content: { type: "string", description: "Post body text (optional)" },
      url: { type: "string", description: "Link URL for link posts (optional)" },
    },
    required: ["submolt", "title"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      post_id: { type: "string" },
      title: { type: "string" },
      verification_solved: { type: "boolean" },
    },
  },
  permissions: ["moltbook:send:posts"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, post_id: "mock_post_id", title: "Mock Post", verification_solved: true }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookCommentManifest = {
  name: "moltbook-comment",
  version: "1.0.0",
  description: "Comment on a Moltbook post",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      post_id: { type: "string", description: "ID of the post to comment on" },
      content: { type: "string", description: "Comment text" },
      parent_id: { type: "string", description: "Parent comment ID for threaded replies (optional)" },
    },
    required: ["post_id", "content"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      comment_id: { type: "string" },
      verification_solved: { type: "boolean" },
    },
  },
  permissions: ["moltbook:send:comments"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, comment_id: "mock_comment_id", verification_solved: true }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookVoteManifest = {
  name: "moltbook-vote",
  version: "1.0.0",
  description: "Upvote or downvote a Moltbook post or comment",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      target_type: { type: "string", enum: ["post", "comment"], description: "Type of target to vote on" },
      target_id: { type: "string", description: "ID of the post or comment" },
      direction: { type: "string", enum: ["up", "down"], description: "Vote direction" },
    },
    required: ["target_type", "target_id", "direction"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
    },
  },
  permissions: ["moltbook:send:votes"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookGetPostManifest = {
  name: "moltbook-get-post",
  version: "1.0.0",
  description: "Get a single Moltbook post and its comments by ID",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      post_id: { type: "string", description: "ID of the post to fetch" },
      include_comments: { type: "boolean", description: "Also fetch comments (default: true)" },
    },
    required: ["post_id"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      post: { type: "object" },
      comments: { type: "array" },
    },
  },
  permissions: ["moltbook:read:posts"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, post: { id: "mock", title: "Mock Post", content: "Mock content" }, comments: [] }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookFeedManifest = {
  name: "moltbook-feed",
  version: "1.0.0",
  description: "Get a feed of posts from Moltbook (home feed, submolt feed, or global)",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      source: { type: "string", enum: ["home", "submolt", "global"], description: "Feed source (default: home)" },
      submolt: { type: "string", description: "Submolt name (required if source is submolt)" },
      sort: { type: "string", enum: ["hot", "new", "top", "rising"], description: "Sort order" },
      limit: { type: "number", description: "Max posts to return (max 50)" },
      cursor: { type: "string", description: "Pagination cursor for next page" },
    },
    required: [],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      posts: { type: "array" },
      has_more: { type: "boolean" },
      next_cursor: { type: ["string", "null"] },
    },
  },
  permissions: ["moltbook:read:feeds"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, posts: [], has_more: false }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookSearchManifest = {
  name: "moltbook-search",
  version: "1.0.0",
  description: "Search Moltbook for posts and comments",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (natural language, max 500 chars)" },
      type: { type: "string", enum: ["posts", "comments", "all"], description: "Filter by content type (default: all)" },
      limit: { type: "number", description: "Max results (max 50)" },
    },
    required: ["query"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      results: { type: "array" },
      count: { type: "number" },
    },
  },
  permissions: ["moltbook:read:search"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, results: [], count: 0 }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookDmManifest = {
  name: "moltbook-dm",
  version: "1.0.0",
  description: "Manage Moltbook direct messages — list requests, approve/reject, view conversations, send messages",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list_requests", "list_conversations", "get_conversation", "approve", "reject", "send"],
        description: "DM action to perform",
      },
      conversation_id: { type: "string", description: "Conversation ID (required for get_conversation, approve, reject, send)" },
      content: { type: "string", description: "Message text (required for send)" },
      block: { type: "boolean", description: "Also block the sender (optional, only for reject)" },
    },
    required: ["action"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      data: {},
    },
  },
  permissions: ["moltbook:send:dm", "moltbook:read:dm"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, data: {} }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookFollowManifest = {
  name: "moltbook-follow",
  version: "1.0.0",
  description: "Follow or unfollow an agent on Moltbook",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["follow", "unfollow"], description: "Follow action" },
      agent_name: { type: "string", description: "Agent name to follow/unfollow" },
    },
    required: ["action", "agent_name"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
    },
  },
  permissions: ["moltbook:send:follows"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const moltbookNotificationsManifest = {
  name: "moltbook-notifications",
  version: "1.0.0",
  description: "View and manage Moltbook notifications",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "mark_read", "mark_post_read"], description: "Notification action" },
      post_id: { type: "string", description: "Post ID (required for mark_post_read)" },
    },
    required: ["action"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      data: {},
    },
  },
  permissions: ["moltbook:read:notifications"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, data: {} }],
};

// ── All manifests for easy import ──

export const allManifests = [
  moltbookPostManifest,
  moltbookCommentManifest,
  moltbookVoteManifest,
  moltbookGetPostManifest,
  moltbookFeedManifest,
  moltbookSearchManifest,
  moltbookDmManifest,
  moltbookFollowManifest,
  moltbookNotificationsManifest,
];

// ── Handler Factories ──

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createPostHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, post_id: "mock_post_id", title: input.title ?? "mock", verification_solved: true };
    }
    if (mode === "dry_run") {
      return { ok: true, post_id: "dry_run", title: input.title, dry_run: true, can_post: client.canPost() };
    }

    const res = await client.createPost({
      submolt: input.submolt,
      title: input.title,
      content: input.content,
      url: input.url,
    });

    return {
      ok: true,
      post_id: res.post?.id ?? res.id,
      title: res.post?.title ?? input.title,
      verification_solved: !!res.post?.verification,
    };
  };
}

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createCommentHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, comment_id: "mock_comment_id", verification_solved: true };
    }
    if (mode === "dry_run") {
      return { ok: true, comment_id: "dry_run", dry_run: true, can_comment: client.canComment() };
    }

    const res = await client.createComment({
      postId: input.post_id,
      content: input.content,
      parentId: input.parent_id,
    });

    const comment = res.comment ?? res;
    return {
      ok: true,
      comment_id: comment.id ?? "created",
      verification_solved: !!comment.verification,
    };
  };
}

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createVoteHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, target_type: input.target_type, direction: input.direction };
    }

    await client.vote({
      targetType: input.target_type,
      targetId: input.target_id,
      direction: input.direction,
    });

    return { ok: true };
  };
}

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createGetPostHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, post: { id: input.post_id, title: "Mock Post", content: "Mock content" }, comments: [] };
    }
    if (mode === "dry_run") {
      return { ok: true, post: null, comments: [], dry_run: true, post_id: input.post_id };
    }

    const res = await client.getPost(input.post_id, {
      includeComments: input.include_comments !== false,
    });

    return {
      ok: true,
      post: res.post,
      comments: res.comments ?? [],
    };
  };
}

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createFeedHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, posts: [], has_more: false };
    }
    if (mode === "dry_run") {
      return { ok: true, posts: [], has_more: false, dry_run: true, source: input.source ?? "home" };
    }

    const res = await client.getFeed({
      source: input.source,
      submolt: input.submolt,
      sort: input.sort,
      limit: input.limit,
      cursor: input.cursor,
    });

    return {
      ok: true,
      posts: res.posts ?? res.data ?? res,
      has_more: res.has_more ?? false,
      next_cursor: res.next_cursor ?? null,
    };
  };
}

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createSearchHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, results: [], count: 0 };
    }
    if (mode === "dry_run") {
      return { ok: true, results: [], count: 0, dry_run: true, query: input.query };
    }

    const res = await client.search({
      query: input.query,
      type: input.type,
      limit: input.limit,
    });

    return {
      ok: true,
      results: res.results ?? [],
      count: res.count ?? res.results?.length ?? 0,
    };
  };
}

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createDmHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, data: {} };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, action: input.action };
    }

    switch (input.action) {
      case "list_requests":
        return { ok: true, data: await client.getDmRequests() };
      case "list_conversations":
        return { ok: true, data: await client.getDmConversations() };
      case "get_conversation":
        return { ok: true, data: await client.getDmConversation(input.conversation_id) };
      case "approve":
        return { ok: true, data: await client.approveDmRequest(input.conversation_id) };
      case "reject":
        return { ok: true, data: await client.rejectDmRequest(input.conversation_id, { block: input.block }) };
      case "send":
        return { ok: true, data: await client.sendDm(input.conversation_id, input.content) };
      default:
        return { ok: false, error: `Unknown DM action: ${input.action}` };
    }
  };
}

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createFollowHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, action: input.action, agent_name: input.agent_name };
    }

    if (input.action === "follow") {
      await client.follow(input.agent_name);
    } else {
      await client.unfollow(input.agent_name);
    }

    return { ok: true };
  };
}

/**
 * @param {import("./moltbook-client.js").MoltbookClient} client
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createNotificationsHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, data: {} };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, action: input.action };
    }

    switch (input.action) {
      case "list":
        return { ok: true, data: await client.getNotifications() };
      case "mark_read":
        return { ok: true, data: await client.markNotificationsRead() };
      case "mark_post_read":
        return { ok: true, data: await client.markPostNotificationsRead(input.post_id) };
      default:
        return { ok: false, error: `Unknown notifications action: ${input.action}` };
    }
  };
}
