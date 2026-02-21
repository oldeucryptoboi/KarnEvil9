/**
 * send-tool — post-tweet and send-twitter-dm tool manifests + handlers.
 */

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const postTweetManifest = {
  name: "post-tweet",
  version: "1.0.0",
  description: "Post a tweet to X/Twitter",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Tweet text (max 280 characters)" },
    },
    required: ["text"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      tweet_id: { type: "string" },
      text: { type: "string" },
    },
  },
  permissions: ["twitter:send:tweets"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, tweet_id: "1234567890", text: "Hello from KarnEvil9!" }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const sendTwitterDmManifest = {
  name: "send-twitter-dm",
  version: "1.0.0",
  description: "Send a direct message on X/Twitter",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      recipient_id: { type: "string", description: "Recipient Twitter user ID" },
      text: { type: "string", description: "Message text (max 10,000 characters)" },
    },
    required: ["recipient_id", "text"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      dm_event_id: { type: "string" },
    },
  },
  permissions: ["twitter:send:dms"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, dm_event_id: "dm_1234567890" }],
};

/**
 * Create a tool handler for post-tweet.
 * @param {import("./twitter-client.js").TwitterClient} twitterClient
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createPostTweetHandler(twitterClient) {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { ok: true, tweet_id: "mock_tweet_id", text: input.text ?? "mock tweet" };
    }
    if (mode === "dry_run") {
      return { ok: true, tweet_id: "dry_run", text: input.text, dry_run: true };
    }

    const result = await twitterClient.postTweet(input.text);
    return {
      ok: true,
      tweet_id: result.id,
      text: result.text,
    };
  };
}

/**
 * Create a tool handler for send-twitter-dm.
 * @param {import("./twitter-client.js").TwitterClient} twitterClient
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createSendTwitterDmHandler(twitterClient) {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { ok: true, dm_event_id: "mock_dm_id" };
    }
    if (mode === "dry_run") {
      return { ok: true, dm_event_id: "dry_run", dry_run: true };
    }

    const result = await twitterClient.sendLongDm({
      recipientId: input.recipient_id,
      text: input.text,
    });

    return {
      ok: true,
      dm_event_id: result?.dm_event_id ?? "sent",
    };
  };
}
