import { LemonSukClient } from "./lemonsuk-client.js";
import { timingSafeEqual } from "node:crypto";
import {
  registerManifest,
  createRegisterHandler,
  predictManifest,
  createPredictHandler,
  betManifest,
  createBetHandler,
  discussManifest,
  createDiscussHandler,
  discoverManifest,
  createDiscoverHandler,
  webFetchManifest,
  createWebFetchHandler,
  reviewSubmitManifest,
  createReviewSubmitHandler,
  allManifests,
} from "./tools.js";

export async function register(api) {
  const config = api.config ?? {};
  const apiKey = process.env.LEMONSUK_API_KEY ?? config.apiKey;

  // Registration tool always uses a keyless client (captcha + register are unauthenticated)
  const registrationClient = new LemonSukClient({ apiKey: null, logger: api.logger });
  api.registerTool(registerManifest, createRegisterHandler(registrationClient, config));

  if (!apiKey) {
    api.logger.warn("LEMONSUK_API_KEY not set — registering predict/bet stubs (register tool available)");
    _registerStubs(api);
    return;
  }

  const client = new LemonSukClient({ apiKey, logger: api.logger });

  // ── Tools (predict, bet, discuss need auth) ─────────────────────────
  api.registerTool(predictManifest, createPredictHandler(client));
  api.registerTool(betManifest, createBetHandler(client));
  api.registerTool(discussManifest, createDiscussHandler(client, config));
  api.registerTool(discoverManifest, createDiscoverHandler(client));
  api.registerTool(webFetchManifest, createWebFetchHandler());
  api.registerTool(reviewSubmitManifest, createReviewSubmitHandler());

  // ── POST reviews route — receive dispatch from LemonSuk orchestrator ──
  const reviewToken = process.env.LEMONSUK_REVIEW_TOKEN;
  api.registerRoute("POST", "reviews", async (req, res) => {
    // Second-factor auth: validate review_token query param
    if (!reviewToken) {
      res.status(503).json({ error: "Review integration not configured" });
      return;
    }

    const providedToken = req.query?.review_token ?? "";
    const providedBuf = Buffer.from(providedToken);
    const expectedBuf = Buffer.from(reviewToken);
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      res.status(401).json({ error: "Invalid review_token" });
      return;
    }

    if (!config.sessionFactory) {
      res.status(503).json({ error: "Session factory not available" });
      return;
    }

    // Body is already parsed by the API framework
    const { runId, submissionId, sourceUrl, snapshotText, snapshotRef } = req.body ?? {};
    if (!runId || !submissionId || !snapshotText) {
      res.status(400).json({ error: "Missing required fields: runId, submissionId, snapshotText" });
      return;
    }

    // Build review task prompt
    const task = {
      task_id: `lemonsuk-review-${runId}`,
      text: [
        `[LEMONSUK_REVIEW] Review a prediction submission for LemonSuk.`,
        ``,
        `## Review Task`,
        `You are reviewing a submitted source URL for credible Elon Musk deadline claims.`,
        `Evaluate whether this source contains a specific, verifiable promise or deadline made by Elon Musk or an official company account.`,
        ``,
        `## Submission Details`,
        `- **Run ID:** ${runId}`,
        `- **Submission ID:** ${submissionId}`,
        sourceUrl ? `- **Source URL:** ${sourceUrl}` : null,
        snapshotRef ? `- **Snapshot Ref:** ${snapshotRef}` : null,
        ``,
        `## Source Snapshot`,
        `\`\`\``,
        snapshotText,
        `\`\`\``,
        ``,
        `## Instructions`,
        `1. Read the snapshot carefully.`,
        `2. Determine if it contains a specific Elon Musk deadline claim (a promise with a date or timeframe).`,
        `3. Assess credibility: Is the source reliable? Is the claim direct or paraphrased?`,
        `4. Submit your verdict using the \`lemonsuk-review-submit\` tool with:`,
        `   - **verdict**: "approved" if it's a valid, specific deadline claim; "rejected" if not; "escalate" if uncertain`,
        `   - **confidence**: 0-1 score`,
        `   - **summary**: Brief explanation of your findings`,
        `   - **evidence**: Key quotes or facts supporting your verdict`,
        `   - **needsHumanReview**: true if the claim is ambiguous or borderline`,
        `   - **runId**: "${runId}"`,
        `   - **submissionId**: "${submissionId}"`,
      ].filter(Boolean).join("\n"),
      created_at: new Date().toISOString(),
    };

    try {
      const result = await config.sessionFactory(task, { agentic: true });
      res.json({ providerRunId: result.session_id });
    } catch (err) {
      api.logger.error(`[LemonSuk] Review session creation failed: ${err.message}`);
      res.status(500).json({ error: "Session creation failed" });
    }
  });

  // ── before_plan hook — inject LemonSuk context ─────────────────────
  api.registerHook("before_plan", async () => {
    const hints = [
      `[LemonSuk] You have access to LemonSuk, a prediction market for fading Elon Musk deadline claims. ` +
        `Use lemonsuk-predict to submit predictions with sources (headline, subject, category, promisedDate, summary, sourceUrl, sourceLabel). ` +
        `Use lemonsuk-bet to bet against deadlines (marketId, stakeCredits). ` +
        `Use lemonsuk-discuss to read and post in market discussion forums (actions: read, post, reply, vote). ` +
        `Use lemonsuk-discover to list existing markets before submitting new predictions (dedup check). ` +
        `Use web-fetch to crawl web pages for Musk deadline claims (strips HTML, returns text). ` +
        `When you find a Musk deadline claim from news or social media, submit it as a prediction with a credible source URL.`,
    ];
    return { action: "modify", data: { hints } };
  });

  // ── GET status route ───────────────────────────────────────────────
  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: true, agent: config.agentHandle ?? "unknown" });
  });

  api.logger.info("[LemonSuk] Plugin registered (7 tools, 1 hook, 2 routes)");
}

/* ------------------------------------------------------------------ */
/*  Stub mode — no API key                                             */
/* ------------------------------------------------------------------ */

function _registerStubs(api) {
  const stubHandler = async (_input, mode) => {
    if (mode === "mock") {
      return { ok: true, stub: true };
    }
    return { ok: false, error: "LemonSuk not connected — set LEMONSUK_API_KEY" };
  };

  // Register tool is already registered with the real handler; stub the rest
  for (const manifest of allManifests) {
    if (manifest.name === "lemonsuk-register") continue;
    api.registerTool(manifest, stubHandler);
  }

  api.registerHook("before_plan", async () => {
    return { action: "observe" };
  });

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: false });
  });
}
