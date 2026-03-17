import { LemonSukClient } from "./lemonsuk-client.js";
import {
  registerManifest,
  createRegisterHandler,
  predictManifest,
  createPredictHandler,
  betManifest,
  createBetHandler,
  discussManifest,
  createDiscussHandler,
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

  // ── before_plan hook — inject LemonSuk context ─────────────────────
  api.registerHook("before_plan", async () => {
    const hints = [
      `[LemonSuk] You have access to LemonSuk, a prediction market for fading Elon Musk deadline claims. ` +
        `Use lemonsuk-predict to submit predictions with sources (headline, subject, category, promisedDate, summary, sourceUrl, sourceLabel). ` +
        `Use lemonsuk-bet to bet against deadlines (marketId, stakeCredits). ` +
        `Use lemonsuk-discuss to read and post in market discussion forums (actions: read, post, reply, vote). ` +
        `When you find a Musk deadline claim from news or social media, submit it as a prediction with a credible source URL.`,
    ];
    return { action: "modify", data: { hints } };
  });

  // ── GET status route ───────────────────────────────────────────────
  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ connected: true, agent: config.agentHandle ?? "unknown" });
  });

  api.logger.info("[LemonSuk] Plugin registered (4 tools, 1 hook, 1 route)");
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
