/**
 * Vault Plugin — Palantir-inspired ontology knowledge vault for KarnEvil9.
 *
 * Ingests conversations (ChatGPT, Claude, WhatsApp, etc.), classifies via LLM,
 * extracts entities, discovers relationships, and provides AI agents with rich context.
 */
import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  vaultIngestManifest,
  vaultSearchManifest,
  vaultContextManifest,
  vaultClassifyManifest,
  vaultVectorizeManifest,
  vaultSemanticSearchManifest,
  vaultDiscoverManifest,
  vaultDashboardManifest,
  vaultInsightsManifest,
  createVaultToolHandlers,
} from "./vault-tools.js";
import { createVaultService, createVaultRoutes } from "./vault-service.js";

/** @type {import("@karnevil9/vault").VaultManager | null} */
let vaultManager = null;

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;
  const journal = config.journal;
  const vaultRoot = resolve(
    process.env.KARNEVIL9_VAULT_ROOT ?? config.vaultRoot ?? "./vault",
  );
  const classifierModel =
    process.env.KARNEVIL9_VAULT_CLASSIFIER_MODEL ??
    config.classifierModel ??
    "claude-3-haiku-20240307";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const embeddingModel =
    process.env.KARNEVIL9_VAULT_EMBEDDING_MODEL ?? "text-embedding-3-small";

  // Construct ClassifierFn if API key is available
  let classifierFn = undefined;
  if (anthropicApiKey) {
    classifierFn = createClassifierFn(anthropicApiKey, classifierModel);
  } else {
    api.logger.warn(
      "No ANTHROPIC_API_KEY set — vault classification will be unavailable",
    );
  }

  // Construct EmbedderFn if OpenAI API key is available
  let embedderFn = undefined;
  if (openaiApiKey) {
    embedderFn = createEmbedderFn(openaiApiKey, embeddingModel);
  } else {
    api.logger.warn(
      "No OPENAI_API_KEY set — vault embeddings and semantic search will be unavailable",
    );
  }

  // Construct InsightsFn if Anthropic API key is available
  let insightsFn = undefined;
  if (anthropicApiKey) {
    insightsFn = createInsightsFn(anthropicApiKey, classifierModel);
  }

  // Construct emitEvent function
  const emitEvent = journal
    ? async (type, payload) => {
        try {
          await journal.emit("vault", type, payload);
        } catch {
          // Journal emit failures should not break vault operations
        }
      }
    : async () => {};

  // Construct VaultManager
  const { VaultManager } = await import("@karnevil9/vault");
  vaultManager = new VaultManager({
    vaultRoot,
    classifier: classifierFn,
    embedder: embedderFn,
    insightsFn,
    emitEvent,
  });

  const getManager = () => vaultManager;

  // Register tools
  const handlers = createVaultToolHandlers(getManager);
  api.registerTool(vaultIngestManifest, handlers["vault-ingest"]);
  api.registerTool(vaultSearchManifest, handlers["vault-search"]);
  api.registerTool(vaultContextManifest, handlers["vault-context"]);
  api.registerTool(vaultClassifyManifest, handlers["vault-classify"]);
  api.registerTool(vaultVectorizeManifest, handlers["vault-vectorize"]);
  api.registerTool(vaultSemanticSearchManifest, handlers["vault-semantic-search"]);
  api.registerTool(vaultDiscoverManifest, handlers["vault-discover"]);
  api.registerTool(vaultDashboardManifest, handlers["vault-dashboard"]);
  api.registerTool(vaultInsightsManifest, handlers["vault-insights"]);

  // Register routes
  const routes = createVaultRoutes(getManager);
  for (const [key, handler] of Object.entries(routes)) {
    const [method, path] = key.split(" ");
    api.registerRoute(method, path, handler);
  }

  // Register after_session_end hook — auto-ingest completed sessions
  api.registerHook(
    "after_session_end",
    async (context) => {
      if (!vaultManager || !journal) return { action: "continue" };

      try {
        const { JournalAdapter } = await import("@karnevil9/vault");
        const adapter = new JournalAdapter({
          readEvents: () => journal.readSession(context.session_id),
        });
        await vaultManager.ingest(adapter);
        api.logger.debug("Session auto-ingested into vault", {
          session_id: context.session_id,
        });
        // Regen context so the next session sees fresh vault state
        try {
          await vaultManager.generateContext();
        } catch (ctxErr) {
          api.logger.warn("Post-ingest context regeneration failed", {
            session_id: context.session_id,
            error: ctxErr.message,
          });
        }
      } catch (err) {
        api.logger.error("Failed to auto-ingest session", {
          session_id: context.session_id,
          error: err.message,
        });
      }
      return { action: "continue" };
    },
    { priority: 50 },
  );

  // Register before_plan hook — inject vault context into planner prompts
  api.registerHook(
    "before_plan",
    async (_context) => {
      if (!vaultManager) return { action: "continue" };

      try {
        const contextPath = join(vaultRoot, "_Meta", "current-context.md");
        if (!existsSync(contextPath)) return { action: "continue" };

        const content = await readFile(contextPath, "utf-8");
        const truncated = content.length > 3000 ? content.slice(0, 3000) + "\n...(truncated)" : content;

        return { action: "modify", data: { vault_context: truncated } };
      } catch (err) {
        api.logger.debug("Failed to read vault context for plan injection", {
          error: err.message,
        });
        return { action: "continue" };
      }
    },
    { priority: 90 },
  );

  // Register vault-sync command
  api.registerCommand("vault-sync", {
    description: "Run full vault pipeline: dropzone → classify → vectorize → discover → dashboard → context → insights",
    options: [
      { flags: "--skip-classify", description: "Skip LLM classification" },
      { flags: "--skip-vectorize", description: "Skip embedding generation" },
      { flags: "--skip-discover", description: "Skip relationship discovery" },
      { flags: "--skip-insights", description: "Skip LLM insights generation" },
      { flags: "--limit <n>", description: "Max items per phase", default: "500" },
    ],
    action: async (opts) => {
      const limit = parseInt(opts.limit ?? "500", 10);

      console.log("Phase 1: Processing DropZone...");
      const dz = await vaultManager.processDropZone();
      console.log(`  ${dz.files_processed} files → ${dz.items_created} items`);

      if (!opts.skipClassify) {
        console.log("Phase 2: Classifying unclassified items...");
        const cl = await vaultManager.classify({ limit });
        console.log(`  ${cl.classified} classified, ${cl.errors} errors`);
      }

      if (!opts.skipVectorize) {
        console.log("Phase 3: Generating embeddings...");
        const vec = await vaultManager.vectorize({ limit });
        console.log(`  ${vec.embeddings_created} embeddings created`);
      }

      if (!opts.skipDiscover) {
        console.log("Phase 4: Discovering relationships...");
        const disc = await vaultManager.discoverRelationships();
        console.log(`  ${disc.result.links_created} links, ${disc.clusters.length} clusters`);
      }

      console.log("Phase 5: Janitor + Dashboard...");
      const jan = await vaultManager.janitor();
      console.log(`  Cleaned: ${jan.orphaned_links_removed} orphaned links, ${jan.duplicates_merged} duplicates`);
      await vaultManager.generateDashboard();

      console.log("Phase 6: Context briefing...");
      await vaultManager.generateContext();

      if (!opts.skipInsights) {
        console.log("Phase 7: Generating insights...");
        await vaultManager.generateInsights();
      }

      const stats = vaultManager.getStats();
      console.log(`\nSync complete: ${stats.total_objects} objects, ${stats.total_links} links`);
    },
  });

  // Register vault-engine service
  const service = createVaultService({ manager: vaultManager, logger: api.logger });
  api.registerService(service);

  api.logger.info("Vault plugin registered", {
    vaultRoot,
    classifierModel,
    embeddingModel,
    hasClassifier: !!classifierFn,
    hasEmbedder: !!embedderFn,
    hasInsights: !!insightsFn,
  });
}

/**
 * Build a ClassifierFn using the Anthropic API directly (fetch-based, no SDK dependency).
 * Uses <<<UNTRUSTED_INPUT>>> delimiters for prompt injection prevention.
 *
 * @param {string} apiKey
 * @param {string} model
 * @returns {import("@karnevil9/vault").ClassifierFn}
 */
function createClassifierFn(apiKey, model) {
  return async (title, content, availableTypes) => {
    const truncatedContent =
      content.length > 4000 ? content.slice(0, 4000) + "\n...(truncated)" : content;

    const systemPrompt = `You are a knowledge classifier. Given a document title and content, classify it according to the ontology.

Available object types: ${availableTypes.join(", ")}
PARA categories: projects (active work), areas (ongoing responsibilities), resources (reference material), archive (inactive), inbox (unclassified)

Respond with ONLY valid JSON (no markdown fences):
{
  "object_type": "one of the available types",
  "para_category": "one of projects/areas/resources/archive/inbox",
  "tags": ["tag1", "tag2"],
  "entities": [{"name": "Entity Name", "type": "Person|Tool|Concept|Organization|Project", "link_type": "discusses|uses|mentions|authored_by|related_to"}],
  "confidence": 0.0-1.0
}`;

    const userPrompt = `Title: <<<UNTRUSTED_INPUT>>>${title}<<<END_UNTRUSTED_INPUT>>>

Content: <<<UNTRUSTED_INPUT>>>${truncatedContent}<<<END_UNTRUSTED_INPUT>>>`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Classifier API error (HTTP ${response.status})`);
    }

    const data = await response.json();
    const text =
      data.content?.[0]?.text ??
      "";

    // Parse JSON response, stripping any markdown fences
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch {
      // LLM returned non-JSON — fall back to defaults
      return {
        object_type: "Note",
        para_category: "inbox",
        tags: [],
        entities: [],
        confidence: 0.1,
      };
    }

    return {
      object_type: result.object_type ?? "Note",
      para_category: result.para_category ?? "inbox",
      tags: result.tags ?? [],
      entities: result.entities ?? [],
      confidence: result.confidence ?? 0.5,
    };
  };
}

/**
 * Build an EmbedderFn using the OpenAI embeddings API.
 * Batches requests in groups of 100, with retry on 429.
 *
 * @param {string} apiKey
 * @param {string} model
 * @returns {import("@karnevil9/vault").EmbedderFn}
 */
function createEmbedderFn(apiKey, model) {
  return async (texts) => {
    const BATCH_SIZE = 100;
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      let retries = 0;

      while (retries < 3) {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: batch,
          }),
        });

        if (response.status === 429) {
          retries++;
          const raw = parseInt(response.headers.get("retry-after") ?? "2", 10);
          const retryAfter = Math.min(Math.max(Number.isFinite(raw) ? raw : 2, 1), 60);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!response.ok) {
          throw new Error(`Embedder API error (HTTP ${response.status})`);
        }

        const data = await response.json();
        const sorted = data.data.sort((a, b) => a.index - b.index);
        for (const item of sorted) {
          allEmbeddings.push(item.embedding);
        }
        break;
      }
    }

    return allEmbeddings;
  };
}

/**
 * Build an InsightsFn using the Anthropic API.
 *
 * @param {string} apiKey
 * @param {string} model
 * @returns {import("@karnevil9/vault").InsightsFn}
 */
function createInsightsFn(apiKey, model) {
  return async (dashboardData) => {
    const statsText = JSON.stringify(dashboardData, null, 2);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: `You are a behavioral analyst reviewing a personal knowledge vault containing ingested conversations (ChatGPT, Claude, WhatsApp), notes, documents, and extracted entities spanning months of thinking.

Analyze the vault statistics and produce an insights report in markdown covering:

1. **Thinking Patterns**: Dominant topics, recurring themes, emerging vs declining interests
2. **Working Methodology**: Preferred tools/approaches, exploration vs execution balance
3. **Knowledge Gaps**: Missing connections, frequently mentioned but poorly linked entities, blind spots
4. **Behavioral Contradictions**: Stated priorities vs actual time allocation, discussed-but-inactive projects
5. **Relationship Patterns**: Key collaborators, entities bridging multiple projects
6. **Actionable Recommendations**: Focus areas, deprioritize candidates, unexplored connections

Ground every observation in quantitative data. Cite specific numbers. Do not speculate beyond what the data supports.`,
        messages: [{
          role: "user",
          content: `Here are the vault statistics:\n\n${statsText}\n\nGenerate insights.`,
        }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Insights API error (HTTP ${response.status})`);
    }

    const data = await response.json();
    return data.content?.[0]?.text ?? "No insights generated.";
  };
}
