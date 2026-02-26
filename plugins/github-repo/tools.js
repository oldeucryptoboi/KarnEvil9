/**
 * tools — GitHub repo tool manifests + handler factories.
 *
 * 5 tools: gh-create-issue, gh-list-issues, gh-create-discussion,
 *          gh-list-discussions, gh-repo-stats
 *
 * All tools are hardcoded to oldeucryptoboi/KarnEvil9.
 * Handlers use the `gh` CLI (authenticated via keyring).
 */
import { execFile } from "node:child_process";

const REPO = "oldeucryptoboi/KarnEvil9";

// ── Helpers ──

/**
 * Run a gh CLI command and return parsed JSON output.
 * @param {string[]} args
 * @param {object} [opts]
 * @param {boolean} [opts.json] - Whether to expect JSON output (default: true)
 * @returns {Promise<any>}
 */
function gh(args, opts = {}) {
  const expectJson = opts.json !== false;
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gh command failed: ${stderr || err.message}`));
        return;
      }
      if (!expectJson) {
        resolve(stdout.trim());
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

// ── Manifests ──

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const ghCreateIssueManifest = {
  name: "gh-create-issue",
  version: "1.0.0",
  description: "Create a GitHub issue (RFC, feature proposal, roadmap item) on oldeucryptoboi/KarnEvil9",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body (Markdown)" },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Labels to apply (e.g. ['rfc', 'enhancement'])",
      },
    },
    required: ["title", "body"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      issue_number: { type: "number" },
      url: { type: "string" },
      title: { type: "string" },
    },
  },
  permissions: ["github:write:issues"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, issue_number: 1, url: "https://github.com/oldeucryptoboi/KarnEvil9/issues/1", title: "Mock Issue" }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const ghListIssuesManifest = {
  name: "gh-list-issues",
  version: "1.0.0",
  description: "List open issues on oldeucryptoboi/KarnEvil9 (to check existing RFCs and avoid duplicates)",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      label: { type: "string", description: "Filter by label (e.g. 'rfc')" },
      limit: { type: "number", description: "Max issues to return (default: 30, max: 100)" },
      state: { type: "string", enum: ["open", "closed", "all"], description: "Issue state filter (default: open)" },
    },
    required: [],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      issues: { type: "array" },
      count: { type: "number" },
    },
  },
  permissions: ["github:read:issues"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, issues: [], count: 0 }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const ghCreateDiscussionManifest = {
  name: "gh-create-discussion",
  version: "1.0.0",
  description: "Create a GitHub Discussion on oldeucryptoboi/KarnEvil9",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Discussion title" },
      body: { type: "string", description: "Discussion body (Markdown)" },
      category: { type: "string", description: "Discussion category (e.g. 'General', 'Ideas', 'Q&A')" },
    },
    required: ["title", "body", "category"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      url: { type: "string" },
      title: { type: "string" },
    },
  },
  permissions: ["github:write:discussions"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, url: "https://github.com/oldeucryptoboi/KarnEvil9/discussions/1", title: "Mock Discussion" }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const ghListDiscussionsManifest = {
  name: "gh-list-discussions",
  version: "1.0.0",
  description: "List recent GitHub Discussions on oldeucryptoboi/KarnEvil9",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max discussions to return (default: 10, max: 50)" },
    },
    required: [],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      discussions: { type: "array" },
      count: { type: "number" },
    },
  },
  permissions: ["github:read:discussions"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, discussions: [], count: 0 }],
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const ghRepoStatsManifest = {
  name: "gh-repo-stats",
  version: "1.0.0",
  description: "Get repository stats (stars, forks, watchers, open issues) for oldeucryptoboi/KarnEvil9",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      stars: { type: "number" },
      forks: { type: "number" },
      watchers: { type: "number" },
      open_issues: { type: "number" },
      description: { type: "string" },
    },
  },
  permissions: ["github:read:repos"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, stars: 0, forks: 0, watchers: 0, open_issues: 0, description: "Mock repo" }],
};

// ── All manifests for easy import ──

export const allManifests = [
  ghCreateIssueManifest,
  ghListIssuesManifest,
  ghCreateDiscussionManifest,
  ghListDiscussionsManifest,
  ghRepoStatsManifest,
];

// ── Handler Factories ──

/**
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createCreateIssueHandler() {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, issue_number: 1, url: `https://github.com/${REPO}/issues/1`, title: input.title };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, would_create: { title: input.title, labels: input.labels ?? [], repo: REPO } };
    }

    const args = ["issue", "create", "-R", REPO, "--title", input.title, "--body", input.body];
    if (input.labels && input.labels.length > 0) {
      args.push("--label", input.labels.join(","));
    }

    const result = await gh(args, { json: false });

    // gh issue create outputs the URL of the created issue
    const url = typeof result === "string" ? result : String(result);
    const issueNumber = parseInt(url.split("/").pop() ?? "0", 10);

    return { ok: true, issue_number: issueNumber, url, title: input.title };
  };
}

/**
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createListIssuesHandler() {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, issues: [], count: 0 };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, would_list: { label: input.label, limit: input.limit ?? 30, repo: REPO } };
    }

    const limit = Math.min(input.limit ?? 30, 100);
    const state = input.state ?? "open";
    const args = [
      "issue", "list", "-R", REPO,
      "--state", state,
      "--limit", String(limit),
      "--json", "number,title,labels,state,url,createdAt,author",
    ];
    if (input.label) {
      args.push("--label", input.label);
    }

    const issues = await gh(args);
    return { ok: true, issues, count: Array.isArray(issues) ? issues.length : 0 };
  };
}

/**
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createCreateDiscussionHandler() {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, url: `https://github.com/${REPO}/discussions/1`, title: input.title };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, would_create: { title: input.title, category: input.category, repo: REPO } };
    }

    const result = await gh([
      "api", "graphql", "-f", `query=mutation {
        createDiscussion(input: {
          repositoryId: "REPO_ID_PLACEHOLDER",
          categoryId: "CAT_ID_PLACEHOLDER",
          title: ${JSON.stringify(input.title)},
          body: ${JSON.stringify(input.body)}
        }) { discussion { url title } }
      }`,
    ]);

    // Fallback: use gh discussion create if available (gh >= 2.40)
    // The GraphQL approach needs repository and category IDs, so try CLI first
    try {
      const url = await gh([
        "discussion", "create", "-R", REPO,
        "--title", input.title,
        "--body", input.body,
        "--category", input.category,
      ], { json: false });
      return { ok: true, url: typeof url === "string" ? url : String(url), title: input.title };
    } catch {
      // GraphQL fallback — first resolve repo ID and category ID
      const repoData = await gh(["repo", "view", REPO, "--json", "id"]);
      const repoId = repoData.id;

      const catQuery = `query { repository(owner:"oldeucryptoboi", name:"KarnEvil9") { discussionCategories(first:25) { nodes { id name } } } }`;
      const catResult = await gh(["api", "graphql", "-f", `query=${catQuery}`]);
      const categories = catResult?.data?.repository?.discussionCategories?.nodes ?? [];
      const cat = categories.find((c) => c.name.toLowerCase() === input.category.toLowerCase());
      if (!cat) {
        return { ok: false, error: `Discussion category "${input.category}" not found. Available: ${categories.map((c) => c.name).join(", ")}` };
      }

      const mutation = `mutation($repoId:ID!,$catId:ID!,$title:String!,$body:String!) {
        createDiscussion(input:{repositoryId:$repoId,categoryId:$catId,title:$title,body:$body}) {
          discussion { url title }
        }
      }`;
      const gqlResult = await gh([
        "api", "graphql",
        "-F", `repoId=${repoId}`,
        "-F", `catId=${cat.id}`,
        "-F", `title=${input.title}`,
        "-F", `body=${input.body}`,
        "-f", `query=${mutation}`,
      ]);
      const discussion = gqlResult?.data?.createDiscussion?.discussion;
      return { ok: true, url: discussion?.url ?? "", title: discussion?.title ?? input.title };
    }
  };
}

/**
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createListDiscussionsHandler() {
  return async (input, mode) => {
    if (mode === "mock") {
      return { ok: true, discussions: [], count: 0 };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, would_list: { limit: input.limit ?? 10, repo: REPO } };
    }

    const limit = Math.min(input.limit ?? 10, 50);
    const query = `query { repository(owner:"oldeucryptoboi", name:"KarnEvil9") { discussions(first:${limit}, orderBy:{field:CREATED_AT, direction:DESC}) { nodes { number title url createdAt category { name } author { login } } } } }`;
    const result = await gh(["api", "graphql", "-f", `query=${query}`]);
    const discussions = result?.data?.repository?.discussions?.nodes ?? [];

    return { ok: true, discussions, count: discussions.length };
  };
}

/**
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createRepoStatsHandler() {
  return async (_input, mode) => {
    if (mode === "mock") {
      return { ok: true, stars: 0, forks: 0, watchers: 0, open_issues: 0, description: "Mock repo" };
    }
    if (mode === "dry_run") {
      return { ok: true, dry_run: true, repo: REPO };
    }

    const data = await gh([
      "repo", "view", REPO,
      "--json", "stargazerCount,forkCount,watchers,openIssues,description",
    ]);

    return {
      ok: true,
      stars: data.stargazerCount ?? 0,
      forks: data.forkCount ?? 0,
      watchers: data.watchers?.totalCount ?? 0,
      open_issues: data.openIssues?.totalCount ?? 0,
      description: data.description ?? "",
    };
  };
}
