/**
 * GitHub Repo Plugin — create issues, discussions, and check stats on
 * oldeucryptoboi/KarnEvil9 via the `gh` CLI.
 *
 * Registers 5 tools. Gracefully degrades if `gh` is not available.
 */
import { execFile } from "node:child_process";
import {
  ghCreateIssueManifest, createCreateIssueHandler,
  ghListIssuesManifest, createListIssuesHandler,
  ghGetIssueManifest, createGetIssueHandler,
  ghAddLabelManifest, createAddLabelHandler,
  ghCreateDiscussionManifest, createCreateDiscussionHandler,
  ghListDiscussionsManifest, createListDiscussionsHandler,
  ghRepoStatsManifest, createRepoStatsHandler,
  allManifests,
} from "./tools.js";

/**
 * Check if `gh` CLI is installed and authenticated.
 * @returns {Promise<boolean>}
 */
function isGhAvailable() {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "status"], { timeout: 10000 }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const available = await isGhAvailable();

  if (!available) {
    api.logger.warn("gh CLI not available or not authenticated — GitHub repo plugin will register stubs (graceful degradation)");
    _registerStubs(api);
    return;
  }

  // ── Register tools ──
  api.registerTool(ghCreateIssueManifest, createCreateIssueHandler());
  api.registerTool(ghListIssuesManifest, createListIssuesHandler());
  api.registerTool(ghGetIssueManifest, createGetIssueHandler());
  api.registerTool(ghAddLabelManifest, createAddLabelHandler());
  api.registerTool(ghCreateDiscussionManifest, createCreateDiscussionHandler());
  api.registerTool(ghListDiscussionsManifest, createListDiscussionsHandler());
  api.registerTool(ghRepoStatsManifest, createRepoStatsHandler());

  api.logger.info("GitHub repo plugin registered (gh CLI authenticated)");
}

/**
 * Register stubs when gh is not available.
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  for (const manifest of allManifests) {
    api.registerTool(manifest, async (input, mode) => {
      if (mode === "mock") return { ok: true, ...(manifest.mock_responses?.[0] ?? {}) };
      return { ok: false, error: "gh CLI not available — GitHub repo plugin disabled" };
    });
  }
}
