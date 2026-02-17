/**
 * Vault Plugin — Palantir-inspired ontology knowledge vault for KarnEvil9.
 *
 * Ingests conversations (ChatGPT, Claude, WhatsApp, etc.), classifies via LLM,
 * extracts entities, discovers relationships, and provides AI agents with rich context.
 */
import { resolve } from "node:path";
import {
  vaultIngestManifest,
  vaultSearchManifest,
  vaultContextManifest,
  vaultClassifyManifest,
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

  // Construct ClassifierFn if API key is available
  let classifierFn = undefined;
  if (anthropicApiKey) {
    classifierFn = createClassifierFn(anthropicApiKey, classifierModel);
  } else {
    api.logger.warn(
      "No ANTHROPIC_API_KEY set — vault classification will be unavailable",
    );
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
    emitEvent,
  });

  const getManager = () => vaultManager;

  // Register tools
  const handlers = createVaultToolHandlers(getManager);
  api.registerTool(vaultIngestManifest, handlers["vault-ingest"]);
  api.registerTool(vaultSearchManifest, handlers["vault-search"]);
  api.registerTool(vaultContextManifest, handlers["vault-context"]);
  api.registerTool(vaultClassifyManifest, handlers["vault-classify"]);

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

  // Register vault-engine service
  const service = createVaultService({ manager: vaultManager, logger: api.logger });
  api.registerService(service);

  api.logger.info("Vault plugin registered", {
    vaultRoot,
    classifierModel,
    hasClassifier: !!classifierFn,
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
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const text =
      data.content?.[0]?.text ??
      "";

    // Parse JSON response, stripping any markdown fences
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(jsonStr);

    return {
      object_type: result.object_type ?? "Note",
      para_category: result.para_category ?? "inbox",
      tags: result.tags ?? [],
      entities: result.entities ?? [],
      confidence: result.confidence ?? 0.5,
    };
  };
}
