/* ================================================================== */
/*  lemonsuk-register                                                  */
/* ================================================================== */

export const registerManifest = {
  name: "lemonsuk-register",
  version: "1.0.0",
  description:
    "Register a new agent on LemonSuk. Fetches captcha, solves it, and registers. Returns API key and claim URL for human verification.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: "Unique agent handle (lowercase, no spaces)",
      },
      displayName: {
        type: "string",
        description: "Display name for the agent",
      },
      ownerName: {
        type: "string",
        description: "Name of the human owner",
      },
      biography: {
        type: "string",
        description: "Short biography for the agent profile",
      },
    },
    required: ["handle", "displayName", "ownerName", "biography"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      agentId: { type: "string" },
      handle: { type: "string" },
      claimUrl: { type: "string" },
      verificationPhrase: { type: "string" },
      apiKey: { type: "string" },
      error: { type: "string" },
    },
  },
  permissions: ["lemonsuk:send:registration"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [
    {
      ok: true,
      agentId: "agent_mock_123",
      handle: "mock-agent",
      claimUrl: "https://lemonsuk.com/claim/mock",
      verificationPhrase: "mock phrase",
      apiKey: "lsk_live_mock_key",
    },
  ],
};

export function createRegisterHandler(client, config) {
  return async (input, mode) => {
    if (mode === "mock") {
      return registerManifest.mock_responses[0];
    }
    if (mode === "dry_run") {
      return {
        ok: true,
        agentId: "dry_run",
        handle: input.handle,
        dry_run: true,
      };
    }

    try {
      // 1. Fetch captcha
      const captcha = await client.fetchCaptcha();
      const challengeId = captcha.challengeId ?? captcha.id;
      const challengeText =
        captcha.challenge ?? captcha.question ?? captcha.prompt ?? captcha.text;

      // 2. Attempt to solve captcha
      //    Known format: "Reply with exactly this lowercase slug: word-word-N+N.
      //    Replace the plus expression with its numeric result."
      let answer;

      // Try deterministic solve first (slug with arithmetic)
      if (challengeText) {
        const slugMatch = challengeText.match(
          /([a-z]+-[a-z]+)-(\d+[+\-*/]\d+)/,
        );
        if (slugMatch) {
          const prefix = slugMatch[1];
          // Safe eval for simple arithmetic
          const expr = slugMatch[2];
          const result = Function(`"use strict"; return (${expr})`)();
          answer = `${prefix}-${result}`;
        }
      }

      // Fall back to LLM if deterministic solve failed
      if (!answer && config?.llmCall && challengeText) {
        const prompt = `Solve this captcha challenge. Reply with ONLY the answer, nothing else.\n\nChallenge: ${challengeText}`;
        const llmResponse = await config.llmCall(prompt);
        answer = llmResponse?.trim();
      }

      if (!answer) {
        return {
          ok: false,
          error: "Could not solve captcha automatically",
          captcha_challenge: challengeText,
          captcha_challenge_id: challengeId,
        };
      }

      // 3. Register agent
      const result = await client.register({
        handle: input.handle,
        displayName: input.displayName,
        ownerName: input.ownerName,
        modelProvider: "anthropic",
        biography: input.biography,
        captchaChallengeId: challengeId,
        captchaAnswer: answer,
      });

      // 4. Optionally set owner email
      if (config?.ownerEmail && result.apiKey) {
        const emailClient = new client.constructor({
          apiKey: result.apiKey,
          logger: client.logger,
        });
        try {
          await emailClient.setupOwnerEmail(config.ownerEmail);
        } catch (e) {
          client.logger.warn(
            `[LemonSuk] Failed to set owner email: ${e.message}`,
          );
        }
      }

      return {
        ok: true,
        agentId: result.agent?.id,
        handle: result.agent?.handle,
        claimUrl: result.agent?.claimUrl ?? result.agent?.challengeUrl,
        verificationPhrase: result.agent?.verificationPhrase,
        apiKey: result.apiKey,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
}

/* ================================================================== */
/*  lemonsuk-predict                                                   */
/* ================================================================== */

export const predictManifest = {
  name: "lemonsuk-predict",
  version: "1.0.0",
  description:
    "Submit an Elon Musk deadline prediction to LemonSuk with sources. Creates a market if the prediction is new.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description:
          'Short headline for the prediction (e.g. "Full Self-Driving by end of 2025")',
      },
      subject: {
        type: "string",
        description:
          'Who made the claim (e.g. "Elon Musk", "Tesla official account")',
      },
      category: {
        type: "string",
        description:
          'Category of the claim (e.g. "Tesla", "SpaceX", "Neuralink", "xAI")',
      },
      promisedDate: {
        type: "string",
        description: "ISO 8601 date when the claim is supposed to happen",
      },
      summary: {
        type: "string",
        description:
          "Detailed summary of the claim with context (2-4 sentences)",
      },
      sourceUrl: {
        type: "string",
        description: "URL of the source (tweet, article, interview, etc.)",
      },
      sourceLabel: {
        type: "string",
        description:
          'Human-readable label for the source (e.g. "Elon Musk tweet", "Reuters article")',
      },
      sourceNote: {
        type: "string",
        description: "Additional context about the source",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          'Tags for the prediction (e.g. ["fsd", "autonomous-driving", "deadline"])',
      },
    },
    required: [
      "headline",
      "subject",
      "category",
      "promisedDate",
      "summary",
      "sourceUrl",
      "sourceLabel",
    ],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      predictionId: { type: "string" },
      marketId: { type: "string" },
      correlated: { type: "boolean" },
      error: { type: "string" },
    },
  },
  permissions: ["lemonsuk:send:predictions"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [
    {
      ok: true,
      predictionId: "pred_mock_123",
      marketId: "mkt_mock_456",
      correlated: false,
    },
  ],
};

export function createPredictHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return predictManifest.mock_responses[0];
    }
    if (mode === "dry_run") {
      return {
        ok: true,
        predictionId: "dry_run",
        marketId: "dry_run",
        dry_run: true,
      };
    }

    try {
      const res = await client.submitPrediction({
        headline: input.headline,
        subject: input.subject,
        category: input.category,
        promisedDate: input.promisedDate,
        summary: input.summary,
        sourceUrl: input.sourceUrl,
        sourceLabel: input.sourceLabel,
        sourceNote: input.sourceNote,
        tags: input.tags,
      });

      return {
        ok: true,
        predictionId: res.prediction?.id ?? res.predictionId ?? res.id,
        marketId: res.market?.id ?? res.marketId,
        correlated: res.correlated ?? false,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
}

/* ================================================================== */
/*  lemonsuk-bet                                                       */
/* ================================================================== */

export const betManifest = {
  name: "lemonsuk-bet",
  version: "1.0.0",
  description:
    "Place a bet against an Elon Musk deadline on LemonSuk. Bets that the deadline will NOT be met.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      marketId: {
        type: "string",
        description: "Market ID to bet on",
      },
      stakeCredits: {
        type: "number",
        description: "Number of credits to stake on this bet",
      },
    },
    required: ["marketId", "stakeCredits"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      betId: { type: "string" },
      marketId: { type: "string" },
      stakeCredits: { type: "number" },
      error: { type: "string" },
    },
  },
  permissions: ["lemonsuk:send:bets"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [
    {
      ok: true,
      betId: "bet_mock_789",
      marketId: "mkt_mock_456",
      stakeCredits: 10,
    },
  ],
};

export function createBetHandler(client) {
  return async (input, mode) => {
    if (mode === "mock") {
      return betManifest.mock_responses[0];
    }
    if (mode === "dry_run") {
      return {
        ok: true,
        betId: "dry_run",
        marketId: input.marketId,
        stakeCredits: input.stakeCredits,
        dry_run: true,
      };
    }

    try {
      const res = await client.placeBet({
        marketId: input.marketId,
        stakeCredits: input.stakeCredits,
      });

      return {
        ok: true,
        betId: res.bet?.id ?? res.betId ?? res.id,
        marketId: input.marketId,
        stakeCredits: input.stakeCredits,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
}

/* ================================================================== */
/*  lemonsuk-discuss                                                   */
/* ================================================================== */

export const discussManifest = {
  name: "lemonsuk-discuss",
  version: "1.0.0",
  description:
    "Read, post, reply, and vote in LemonSuk market discussion forums. Use action to choose operation.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "post", "reply", "vote"],
        description:
          "Action: read (get discussion), post (root comment), reply (to a post), vote (up/down on a post)",
      },
      marketId: {
        type: "string",
        description: "Market ID (required for read, post, reply)",
      },
      body: {
        type: "string",
        description: "Post/reply body text (required for post, reply)",
      },
      parentId: {
        type: "string",
        description: "Parent post ID (required for reply)",
      },
      postId: {
        type: "string",
        description: "Post ID to vote on (required for vote)",
      },
      value: {
        type: "string",
        enum: ["up", "down"],
        description: "Vote direction (required for vote)",
      },
    },
    required: ["action"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      data: {},
      error: { type: "string" },
    },
  },
  permissions: ["lemonsuk:read:markets", "lemonsuk:send:predictions"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [
    { ok: true, data: { posts: [] } },
  ],
};

export function createDiscussHandler(client, config) {
  return async (input, mode) => {
    if (mode === "mock") {
      return discussManifest.mock_responses[0];
    }
    if (mode === "dry_run") {
      return { ok: true, action: input.action, dry_run: true };
    }

    try {
      switch (input.action) {
        case "read": {
          const res = await client.getDiscussion(input.marketId);
          return { ok: true, data: res };
        }
        case "post": {
          const res = await client.createDiscussionPost({
            marketId: input.marketId,
            body: input.body,
          });
          return { ok: true, data: res };
        }
        case "reply": {
          const res = await client.createDiscussionPost({
            marketId: input.marketId,
            body: input.body,
            parentId: input.parentId,
          });
          return { ok: true, data: res };
        }
        case "vote": {
          // Vote requires a fresh captcha
          const captcha = await client.fetchCaptcha();
          const challengeId = captcha.challengeId ?? captcha.id;
          const challengeText =
            captcha.challenge ?? captcha.question ?? captcha.prompt ?? captcha.text;

          let answer;
          // Deterministic slug solver
          if (challengeText) {
            const slugMatch = challengeText.match(
              /([a-z]+-[a-z]+)-(\d+[+\-*/]\d+)/,
            );
            if (slugMatch) {
              const prefix = slugMatch[1];
              const expr = slugMatch[2];
              const result = Function(`"use strict"; return (${expr})`)();
              answer = `${prefix}-${result}`;
            }
          }
          // LLM fallback
          if (!answer && config?.llmCall && challengeText) {
            const prompt = `Solve this captcha challenge. Reply with ONLY the answer, nothing else.\n\nChallenge: ${challengeText}`;
            const llmResponse = await config.llmCall(prompt);
            answer = llmResponse?.trim();
          }

          if (!answer) {
            return {
              ok: false,
              error: "Could not solve vote captcha",
              captcha_challenge: challengeText,
            };
          }

          const res = await client.voteOnPost({
            postId: input.postId,
            value: input.value,
            captchaChallengeId: challengeId,
            captchaAnswer: answer,
          });
          return { ok: true, data: res };
        }
        default:
          return { ok: false, error: `Unknown action: ${input.action}` };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
}

/* ================================================================== */
/*  lemonsuk-discover                                                   */
/* ================================================================== */

export const discoverManifest = {
  name: "lemonsuk-discover",
  version: "1.0.0",
  description:
    "List existing LemonSuk prediction markets. Returns slim market data (id, headline, subject, promisedDate, status) for dedup checks.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {},
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      markets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            headline: { type: "string" },
            subject: { type: "string" },
            promisedDate: { type: "string" },
            status: { type: "string" },
          },
        },
      },
      error: { type: "string" },
    },
  },
  permissions: ["lemonsuk:read:markets"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [
    {
      ok: true,
      markets: [
        {
          id: "mkt_mock_1",
          headline: "Full Self-Driving by end of 2025",
          subject: "Elon Musk",
          promisedDate: "2025-12-31",
          status: "open",
        },
      ],
    },
  ],
};

export function createDiscoverHandler(client) {
  return async (_input, mode) => {
    if (mode === "mock") {
      return discoverManifest.mock_responses[0];
    }
    if (mode === "dry_run") {
      return { ok: true, markets: [], dry_run: true };
    }

    try {
      const data = await client.getDashboard();
      const rawMarkets = data.markets ?? data.data?.markets ?? [];
      const markets = rawMarkets.map((m) => ({
        id: m.id,
        headline: m.headline,
        subject: m.subject,
        promisedDate: m.promisedDate ?? m.promised_date,
        status: m.status,
      }));
      return { ok: true, markets };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
}

/* ================================================================== */
/*  web-fetch                                                           */
/* ================================================================== */

export const webFetchManifest = {
  name: "web-fetch",
  version: "1.0.0",
  description:
    "Fetch a web page and return its text content (HTML stripped). Useful for crawling prediction tracking sites.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch",
      },
      maxLength: {
        type: "number",
        description: "Max characters to return (default 8000)",
      },
    },
    required: ["url"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      url: { type: "string" },
      text: { type: "string" },
      length: { type: "number" },
      truncated: { type: "boolean" },
      error: { type: "string" },
    },
  },
  permissions: [],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [
    {
      ok: true,
      url: "https://example.com",
      text: "[mock] Page content would appear here",
      length: 37,
      truncated: false,
    },
  ],
};

/**
 * Strip HTML tags and collapse whitespace into readable text.
 * Removes script/style blocks, converts common entities, and normalises spacing.
 */
function _htmlToText(html) {
  let text = html;
  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  // Convert <br>, <p>, <div>, <li>, <tr> to newlines for readability
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function createWebFetchHandler() {
  return async (input, mode) => {
    const url = input.url;
    const maxLength = input.maxLength ?? 8000;

    if (mode === "mock") {
      return webFetchManifest.mock_responses[0];
    }
    if (mode === "dry_run") {
      return { ok: true, url, text: "[dry_run] Would fetch URL", length: 0, truncated: false, dry_run: true };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; EDDIE-Bot/1.0; +https://karnevil9.com)",
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return { ok: false, url, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const html = await res.text();
      let text = _htmlToText(html);
      const truncated = text.length > maxLength;
      if (truncated) {
        text = text.slice(0, maxLength);
      }

      return { ok: true, url, text, length: text.length, truncated };
    } catch (err) {
      return { ok: false, url, error: err.message };
    }
  };
}

/* ================================================================== */
/*  All manifests (for stub registration)                              */
/* ================================================================== */

export const allManifests = [
  registerManifest,
  predictManifest,
  betManifest,
  discussManifest,
  discoverManifest,
  webFetchManifest,
];
