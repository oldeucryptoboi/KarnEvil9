/**
 * Vault tool manifests and handlers.
 */

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const vaultIngestManifest = {
  name: "vault-ingest",
  version: "1.0.0",
  description: "Ingest data from a source into the knowledge vault",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Source adapter: chatgpt, claude, whatsapp, journal, apple-notes, gmail, google-drive" },
      path: { type: "string", description: "Path to the export file or directory (for file-based adapters)" },
      options: { type: "object", description: "Additional adapter-specific options" },
    },
    required: ["source"],
  },
  output_schema: {
    type: "object",
    properties: {
      created: { type: "number" },
      updated: { type: "number" },
      skipped: { type: "number" },
    },
  },
  permissions: ["vault:write:objects"],
  timeout_ms: 300000,
  supports: { mock: true, dry_run: false },
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const vaultSearchManifest = {
  name: "vault-search",
  version: "1.0.0",
  description: "Search the knowledge vault for objects matching a query",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Free-text search query" },
      object_type: { type: "string", description: "Filter by object type (Person, Project, Tool, etc.)" },
      para_category: { type: "string", description: "Filter by PARA category (projects, areas, resources, archive, inbox)" },
      tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
      source: { type: "string", description: "Filter by source" },
      limit: { type: "number", description: "Maximum results to return", default: 20 },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      results: { type: "array" },
      total: { type: "number" },
    },
  },
  permissions: ["vault:read:objects"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const vaultContextManifest = {
  name: "vault-context",
  version: "1.0.0",
  description: "Generate or retrieve the current context briefing from the vault",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      regenerate: { type: "boolean", description: "Force regeneration of the context briefing", default: false },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      generated_at: { type: "string" },
      recent_conversations: { type: "array" },
      active_projects: { type: "array" },
      key_entities: { type: "array" },
    },
  },
  permissions: ["vault:read:objects"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
};

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const vaultClassifyManifest = {
  name: "vault-classify",
  version: "1.0.0",
  description: "Classify unclassified vault objects using the LLM classifier",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Maximum objects to classify", default: 50 },
      concurrency: { type: "number", description: "Number of concurrent classifications", default: 3 },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      classified: { type: "number" },
      errors: { type: "number" },
    },
  },
  permissions: ["vault:classify:objects"],
  timeout_ms: 600000,
  supports: { mock: true, dry_run: false },
};

/**
 * Create tool handlers that reference the vault manager.
 * @param {() => import("@karnevil9/vault").VaultManager | null} getManager
 */
export function createVaultToolHandlers(getManager) {
  return {
    "vault-ingest": async (input, mode) => {
      if (mode === "mock") return { created: 1, updated: 0, skipped: 0 };
      const manager = getManager();
      if (!manager) throw new Error("Vault engine not initialized");

      const { source, path, options } = input;
      const adapter = await createAdapter(source, path, options, manager);
      return manager.ingest(adapter);
    },

    "vault-search": async (input) => {
      const manager = getManager();
      if (!manager) throw new Error("Vault engine not initialized");

      const results = manager.search({
        text: input.text,
        object_type: input.object_type,
        para_category: input.para_category,
        tags: input.tags,
        source: input.source,
        limit: input.limit ?? 20,
      });
      return { results, total: results.length };
    },

    "vault-context": async (input) => {
      const manager = getManager();
      if (!manager) throw new Error("Vault engine not initialized");
      return manager.generateContext();
    },

    "vault-classify": async (input, mode) => {
      if (mode === "mock") return { classified: 0, errors: 0 };
      const manager = getManager();
      if (!manager) throw new Error("Vault engine not initialized");
      return manager.classify({ limit: input.limit, concurrency: input.concurrency });
    },
  };
}

/**
 * @param {string} source
 * @param {string} [path]
 * @param {Record<string,unknown>} [options]
 * @param {import("@karnevil9/vault").VaultManager} manager
 */
async function createAdapter(source, path, options, manager) {
  switch (source) {
    case "chatgpt": {
      const { ChatGPTAdapter } = await import("@karnevil9/vault");
      return new ChatGPTAdapter(path);
    }
    case "claude": {
      const { ClaudeAdapter } = await import("@karnevil9/vault");
      return new ClaudeAdapter(path);
    }
    case "whatsapp": {
      const { WhatsAppAdapter } = await import("@karnevil9/vault");
      return new WhatsAppAdapter(path);
    }
    case "journal": {
      const { JournalAdapter } = await import("@karnevil9/vault");
      // The journal read function will be wired by the plugin
      return new JournalAdapter({ readEvents: options?.readEvents ?? (async () => []) });
    }
    case "apple-notes": {
      const { AppleNotesAdapter } = await import("@karnevil9/vault");
      return new AppleNotesAdapter();
    }
    case "gmail": {
      const { GmailAdapter } = await import("@karnevil9/vault");
      return new GmailAdapter({ accessToken: options?.accessToken ?? "", query: options?.query, maxResults: options?.maxResults });
    }
    case "google-drive": {
      const { GoogleDriveAdapter } = await import("@karnevil9/vault");
      return new GoogleDriveAdapter({ accessToken: options?.accessToken ?? "", folderId: options?.folderId, query: options?.query, maxResults: options?.maxResults });
    }
    default:
      throw new Error(`Unknown vault source: ${source}`);
  }
}
