import { mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JournalEventType } from "@karnevil9/schemas";
import type {
  VaultObject,
  VaultAdapter,
  IngestItem,
  ClassifierFn,
  ClassificationResult,
  OntologySchema,
  VaultStats,
  ParaCategory,
  ContextBriefing,
  EmbedderFn,
  InsightsFn,
  JanitorResult,
  VectorSearchResult,
  DiscoverRelationshipsOptions,
  DiscoverRelationshipsResult,
  ClusterResult,
  DashboardData,
  DropZoneResult,
} from "./types.js";
import { PARA_FOLDERS } from "./types.js";
import { getDefaultSchema, serializeSchemaToYaml } from "./ontology-schema.js";
import { ObjectStore } from "./object-store.js";
import { LinkStore } from "./link-store.js";
import { IngestionTracker } from "./ingestion-tracker.js";
import { Deduplicator } from "./deduplicator.js";
import { ClassificationPipeline } from "./classification-pipeline.js";
import { EntityExtractor } from "./entity-extractor.js";
import { ContextGenerator } from "./context-generator.js";
import { VectorStore } from "./vector-store.js";
import { OPTICSClusterer } from "./clusterer.js";
import { RelationshipDiscoverer } from "./relationship-discoverer.js";
import { DashboardGenerator } from "./dashboard-generator.js";
import { DropZoneWatcher } from "./dropzone-watcher.js";
import { writeFile } from "node:fs/promises";

export interface VaultManagerOptions {
  vaultRoot: string;
  schema?: OntologySchema;
  classifier?: ClassifierFn;
  embedder?: EmbedderFn;
  insightsFn?: InsightsFn;
  lessonsProvider?: () => string[];
  emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => Promise<void>;
}

export class VaultManager {
  private vaultRoot: string;
  private schema: OntologySchema;
  private objectStore: ObjectStore;
  private linkStore: LinkStore;
  private tracker: IngestionTracker;
  private deduplicator: Deduplicator;
  private pipeline: ClassificationPipeline | null = null;
  private entityExtractor: EntityExtractor;
  private contextGenerator: ContextGenerator;
  private vectorStore: VectorStore;
  private clusterer: OPTICSClusterer;
  private relationshipDiscoverer: RelationshipDiscoverer;
  private dashboardGenerator: DashboardGenerator;
  private dropZoneWatcher: DropZoneWatcher;
  private insightsFn: InsightsFn | null;
  private emitEvent: (type: JournalEventType, payload: Record<string, unknown>) => Promise<void>;

  constructor(options: VaultManagerOptions) {
    this.vaultRoot = options.vaultRoot;
    this.schema = options.schema ?? getDefaultSchema();
    this.emitEvent = options.emitEvent ?? (async () => {});
    this.insightsFn = options.insightsFn ?? null;

    this.objectStore = new ObjectStore(this.vaultRoot);
    this.linkStore = new LinkStore(join(this.vaultRoot, "_Ontology", "Links", "links.jsonl"));
    this.tracker = new IngestionTracker(join(this.vaultRoot, "_Ontology", "Links", "ingestion-log.jsonl"));
    this.deduplicator = new Deduplicator(join(this.vaultRoot, "_Ontology", "Schema", "aliases.yaml"));

    if (options.classifier) {
      this.pipeline = new ClassificationPipeline({
        classifier: options.classifier,
        schema: this.schema,
      });
    }

    this.entityExtractor = new EntityExtractor(
      this.objectStore,
      this.linkStore,
      this.deduplicator,
      this.schema,
    );

    this.contextGenerator = new ContextGenerator(
      this.objectStore,
      this.linkStore,
      this.vaultRoot,
      options.lessonsProvider,
    );

    this.vectorStore = new VectorStore(
      join(this.vaultRoot, "_Ontology", "Links", "embeddings.jsonl"),
      options.embedder,
    );

    this.clusterer = new OPTICSClusterer();

    this.relationshipDiscoverer = new RelationshipDiscoverer({
      vectorStore: this.vectorStore,
      clusterer: this.clusterer,
      objectStore: this.objectStore,
      linkStore: this.linkStore,
      classifier: options.classifier,
      emitEvent: this.emitEvent,
    });

    this.dashboardGenerator = new DashboardGenerator({
      objectStore: this.objectStore,
      linkStore: this.linkStore,
      vectorStore: this.vectorStore,
      vaultRoot: this.vaultRoot,
      emitEvent: this.emitEvent,
    });

    this.dropZoneWatcher = new DropZoneWatcher(join(this.vaultRoot, "_DropZone"));
  }

  async init(): Promise<void> {
    await this.scaffold();
    await this.objectStore.init();
    await this.linkStore.init();
    await this.tracker.init();
    await this.deduplicator.init();
    await this.vectorStore.init();
  }

  async scaffold(): Promise<void> {
    // Create directory structure
    const dirs = [
      ...Object.values(PARA_FOLDERS),
      join("_Ontology", "Schema"),
      join("_Ontology", "Objects", "People"),
      join("_Ontology", "Objects", "Projects"),
      join("_Ontology", "Objects", "Tools"),
      join("_Ontology", "Objects", "Concepts"),
      join("_Ontology", "Objects", "Organizations"),
      join("_Ontology", "Objects", "Conversations"),
      join("_Ontology", "Objects", "Notes"),
      join("_Ontology", "Objects", "Documents"),
      join("_Ontology", "Links"),
      "_Meta",
      join("_Meta", "archive"),
      "_DropZone",
      join("_DropZone", "_processed"),
    ];

    for (const dir of dirs) {
      const fullPath = join(this.vaultRoot, dir);
      if (!existsSync(fullPath)) {
        await mkdir(fullPath, { recursive: true });
      }
    }

    // Write default ontology schema if it doesn't exist
    const schemaPath = join(this.vaultRoot, "_Ontology", "Schema", "ontology.yaml");
    if (!existsSync(schemaPath)) {
      await writeFile(schemaPath, serializeSchemaToYaml(this.schema), "utf-8");
    }
  }

  async ingest(adapter: VaultAdapter): Promise<{ created: number; updated: number; skipped: number }> {
    let created = 0;
    let updated = 0;
    let skipped = 0;

    await this.emitEvent("vault.ingestion_started" as JournalEventType, {
      source: adapter.source,
      adapter: adapter.name,
    });

    try {
      for await (const item of adapter.extract()) {
        const result = await this.ingestItem(item);
        switch (result) {
          case "created": created++; break;
          case "updated": updated++; break;
          case "skipped": skipped++; break;
        }
      }

      await this.emitEvent("vault.ingestion_completed" as JournalEventType, {
        source: adapter.source,
        adapter: adapter.name,
        created,
        updated,
        skipped,
      });
    } catch (err) {
      await this.emitEvent("vault.error" as JournalEventType, {
        operation: "ingestion",
        source: adapter.source,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    return { created, updated, skipped };
  }

  async ingestItem(item: IngestItem): Promise<"created" | "updated" | "skipped"> {
    // Check idempotency
    if (this.tracker.hasBeenIngested(item.source, item.source_id)) {
      if (!this.tracker.hasContentChanged(item.source, item.source_id, item.content)) {
        return "skipped";
      }
      // Content changed — update existing object
      const existingId = this.tracker.getObjectId(item.source, item.source_id);
      if (existingId) {
        await this.objectStore.update(existingId, {
          title: item.title,
          content: item.content,
        });
        await this.tracker.track(item.source, item.source_id, item.content, existingId);

        await this.emitEvent("vault.object_updated" as JournalEventType, {
          object_id: existingId,
          source: item.source,
          source_id: item.source_id,
        });
        return "updated";
      }
    }

    // Create new object
    const obj = await this.objectStore.create(
      item.title,
      item.content,
      {
        source: item.source,
        source_id: item.source_id,
        created_at: item.created_at,
        ...item.metadata,
      },
      this.schema,
    );

    await this.tracker.track(item.source, item.source_id, item.content, obj.frontmatter.object_id);

    await this.emitEvent("vault.object_created" as JournalEventType, {
      object_id: obj.frontmatter.object_id,
      object_type: obj.frontmatter.object_type,
      source: item.source,
      title: item.title,
    });

    return "created";
  }

  async classify(options?: { limit?: number; concurrency?: number }): Promise<{ classified: number; errors: number }> {
    if (!this.pipeline) {
      throw new Error("No classifier configured — set ClassifierFn via vault plugin config");
    }

    const unclassified = this.objectStore
      .search({ limit: options?.limit })
      .filter((e) => e.para_category === "inbox");

    let classified = 0;
    let errors = 0;

    const items = [];
    for (const entry of unclassified) {
      const obj = await this.objectStore.get(entry.object_id);
      if (obj) {
        items.push({ objectId: entry.object_id, title: obj.title, content: obj.content });
      }
    }

    await this.pipeline.classifyBatch(
      items,
      async (objectId, result) => {
        await this.applyClassification(objectId, result);
        classified++;
      },
      async (objectId, error) => {
        await this.emitEvent("vault.error" as JournalEventType, {
          operation: "classification",
          object_id: objectId,
          error: error.message,
        });
        errors++;
      },
    );

    return { classified, errors };
  }

  async applyClassification(objectId: string, result: ClassificationResult): Promise<void> {
    // Update object with classification
    await this.objectStore.update(objectId, {
      frontmatter: {
        object_type: result.object_type,
        para_category: result.para_category,
        tags: result.tags,
        entities: result.entities.map((e) => e.name),
        confidence: result.confidence,
        classified_by: "claude-classifier",
      },
    });

    // Physically move file to correct PARA folder
    await this.objectStore.moveObject(objectId, result.para_category, this.schema);

    await this.emitEvent("vault.object_classified" as JournalEventType, {
      object_id: objectId,
      object_type: result.object_type,
      para_category: result.para_category,
      confidence: result.confidence,
    });

    // Extract entities and create links
    const extraction = await this.entityExtractor.extractAndLink(objectId, result);

    for (const entity of extraction.entities) {
      if (entity.is_new) {
        await this.emitEvent("vault.entity_extracted" as JournalEventType, {
          entity_name: entity.canonical_name,
          entity_type: entity.type,
          source_object_id: objectId,
        });
      } else {
        await this.emitEvent("vault.entity_deduplicated" as JournalEventType, {
          entity_name: entity.name,
          canonical_name: entity.canonical_name,
          entity_type: entity.type,
        });
      }
    }

    for (const link of extraction.links_created) {
      await this.emitEvent("vault.link_created" as JournalEventType, {
        link_id: link.link_id,
        source_id: link.source_id,
        target_id: link.target_id,
        link_type: link.link_type,
      });
    }
  }

  async generateContext(): Promise<ContextBriefing> {
    const briefing = await this.contextGenerator.generate();
    await this.contextGenerator.writeContextFile(briefing);

    await this.emitEvent("vault.context_generated" as JournalEventType, {
      conversations: briefing.recent_conversations.length,
      projects: briefing.active_projects.length,
      entities: briefing.key_entities.length,
    });

    return briefing;
  }

  async janitor(): Promise<JanitorResult> {
    // Remove orphaned links
    const validIds = new Set(
      this.objectStore.search({}).map((e) => e.object_id),
    );
    const orphanedLinksRemoved = await this.linkStore.removeOrphanedLinks(validIds);

    // Frontmatter validation — fix missing required fields
    let frontmatterFixed = 0;
    const allEntries = this.objectStore.search({});
    for (const entry of allEntries) {
      const obj = await this.objectStore.get(entry.object_id);
      if (!obj) continue;

      const fixes: Record<string, unknown> = {};
      if (!obj.frontmatter.object_id) fixes.object_id = entry.object_id;
      if (!obj.frontmatter.source) fixes.source = "unknown";
      if (!obj.frontmatter.created_at) fixes.created_at = obj.frontmatter.ingested_at || new Date().toISOString();
      if (!obj.frontmatter.para_category) fixes.para_category = "inbox";

      if (Object.keys(fixes).length > 0) {
        await this.objectStore.update(entry.object_id, { frontmatter: fixes });
        frontmatterFixed++;
      }
    }

    // Duplicate detection — find objects with same source+source_id, keep newest
    let duplicatesMerged = 0;
    const sourceIndex = new Map<string, typeof allEntries>();
    for (const entry of allEntries) {
      const key = `${entry.source}:${entry.source_id}`;
      const existing = sourceIndex.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        sourceIndex.set(key, [entry]);
      }
    }
    for (const [, entries] of sourceIndex) {
      if (entries.length <= 1) continue;
      // Sort by ingested_at descending — keep newest
      entries.sort((a, b) => new Date(b.ingested_at).getTime() - new Date(a.ingested_at).getTime());
      for (let i = 1; i < entries.length; i++) {
        await this.objectStore.delete(entries[i]!.object_id);
        this.vectorStore.removeEmbedding(entries[i]!.object_id);
        duplicatesMerged++;
      }
    }

    // Stale inbox cleanup — objects in _Inbox older than 30 days → archive
    let staleArchived = 0;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const inboxEntries = this.objectStore.search({ para_category: "inbox" });
    for (const entry of inboxEntries) {
      const createdAt = new Date(entry.created_at).getTime();
      if (createdAt < thirtyDaysAgo) {
        await this.objectStore.update(entry.object_id, {
          frontmatter: { para_category: "archive" },
        });
        await this.objectStore.moveObject(entry.object_id, "archive", this.schema);
        staleArchived++;
      }
    }

    // Resolve broken wikilinks — create stubs for missing targets
    const wikilink_stubs_created = await this.resolveWikilinks();

    // Compact tracker
    await this.tracker.compact();

    // Save deduplicator state
    await this.deduplicator.save();

    // Remove stale embeddings for deleted objects
    for (const id of this.vectorStore.allIds()) {
      if (!validIds.has(id)) {
        this.vectorStore.removeEmbedding(id);
      }
    }
    await this.vectorStore.save();

    const result: JanitorResult = {
      orphaned_links_removed: orphanedLinksRemoved,
      frontmatter_fixed: frontmatterFixed,
      duplicates_merged: duplicatesMerged,
      stale_archived: staleArchived,
      tracker_compacted: true,
      wikilink_stubs_created,
    };

    await this.emitEvent("vault.janitor_completed" as JournalEventType, { ...result });

    return result;
  }

  private async resolveWikilinks(): Promise<number> {
    // Build title lookup: lowercase title → object_id
    const titleLookup = new Map<string, string>();
    const allEntries = this.objectStore.search({});
    for (const entry of allEntries) {
      titleLookup.set(entry.title.toLowerCase(), entry.object_id);
    }

    const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
    let stubsCreated = 0;

    for (const entry of allEntries) {
      const obj = await this.objectStore.get(entry.object_id);
      if (!obj) continue;

      let match: RegExpExecArray | null = wikilinkPattern.exec(obj.content);
      while (match !== null) {
        const target = match[1]!;
        const targetLower = target.toLowerCase();

        // Skip if target already exists
        if (titleLookup.has(targetLower)) {
          match = wikilinkPattern.exec(obj.content);
          continue;
        }

        // Create stub Note in _Inbox
        const stub = await this.objectStore.create(
          target,
          `Stub created automatically. Referenced by "${entry.title}".`,
          {
            source: "janitor-stub",
            source_id: `stub-${target.toLowerCase().replace(/\s+/g, "-")}`,
            object_type: "Note",
            para_category: "inbox",
            tags: ["stub", "auto-generated"],
          },
          this.schema,
        );

        // Add mentions link from referencing object to stub
        await this.linkStore.addLink({
          source_id: entry.object_id,
          target_id: stub.frontmatter.object_id,
          link_type: "mentions",
          confidence: 1.0,
        });

        // Track in lookup to prevent duplicate stubs within same run
        titleLookup.set(targetLower, stub.frontmatter.object_id);
        stubsCreated++;
        match = wikilinkPattern.exec(obj.content);
      }
    }

    return stubsCreated;
  }

  // ─── Vector / Embedding Pipeline ────────────────────────────────────

  async vectorize(options?: { limit?: number }): Promise<{ embeddings_created: number }> {
    const entries = this.objectStore.search({ limit: options?.limit });
    const unembedded = entries
      .filter((e) => !this.vectorStore.hasEmbedding(e.object_id))
      .map((e) => e.object_id);

    const created = await this.vectorStore.embed(
      unembedded,
      async (id) => {
        const obj = await this.objectStore.get(id);
        if (!obj) return null;
        return `${obj.title}\n\n${obj.content}`;
      },
    );

    await this.vectorStore.save();

    await this.emitEvent("vault.vectorize_completed" as JournalEventType, {
      embeddings_created: created,
      total_embeddings: this.vectorStore.size(),
    });

    return { embeddings_created: created };
  }

  async semanticSearch(query: string, k: number = 10): Promise<VectorSearchResult[]> {
    if (!this.vectorStore.size()) return [];

    // Need embedder to embed the query
    const embedder = this.vectorStore.getEmbedder();
    if (!embedder) throw new Error("No embedder configured for semantic search");

    const [queryVec] = await embedder([query]);
    if (!queryVec) return [];

    const results = this.vectorStore.search(new Float32Array(queryVec), k);
    const searchResults: VectorSearchResult[] = [];

    for (const r of results) {
      const entries = this.objectStore.search({ text: r.id, limit: 1 });
      // Look up by object_id from the index
      const entry = this.objectStore.search({}).find((e) => e.object_id === r.id);
      if (entry) {
        searchResults.push({
          object_id: r.id,
          score: r.score,
          title: entry.title,
          object_type: entry.object_type,
        });
      }
    }

    return searchResults;
  }

  async discoverRelationships(options?: DiscoverRelationshipsOptions): Promise<{
    result: DiscoverRelationshipsResult;
    clusters: ClusterResult[];
  }> {
    return this.relationshipDiscoverer.discover(options);
  }

  async generateDashboard(clusters?: ClusterResult[]): Promise<string> {
    return this.dashboardGenerator.generateDashboard(clusters);
  }

  async generateInsights(): Promise<string> {
    return this.dashboardGenerator.generateInsights(this.insightsFn ?? undefined);
  }

  getDashboardData(clusters?: ClusterResult[]): DashboardData {
    return this.dashboardGenerator.buildDashboardData(clusters);
  }

  async processDropZone(): Promise<DropZoneResult> {
    const result: DropZoneResult = {
      files_processed: 0,
      files_failed: 0,
      items_created: 0,
      items_updated: 0,
      items_skipped: 0,
    };

    const detected = await this.dropZoneWatcher.scan();
    if (detected.length === 0) return result;

    const adapterModules = await import("./adapters/chatgpt-adapter.js")
      .then((m) => ({ ChatGPTAdapter: m.ChatGPTAdapter }))
      .catch(() => null);
    const claudeModule = await import("./adapters/claude-adapter.js")
      .then((m) => ({ ClaudeAdapter: m.ClaudeAdapter }))
      .catch(() => null);
    const whatsappModule = await import("./adapters/whatsapp-adapter.js")
      .then((m) => ({ WhatsAppAdapter: m.WhatsAppAdapter }))
      .catch(() => null);

    for (const { filePath, detectedSource } of detected) {
      try {
        let adapter: VaultAdapter | null = null;

        switch (detectedSource) {
          case "chatgpt":
            if (adapterModules) adapter = new adapterModules.ChatGPTAdapter(filePath);
            break;
          case "claude":
            if (claudeModule) adapter = new claudeModule.ClaudeAdapter(filePath);
            break;
          case "whatsapp":
            if (whatsappModule) adapter = new whatsappModule.WhatsAppAdapter(filePath);
            break;
          // Gmail mbox detection exists but no mbox adapter yet — skip gracefully
        }

        if (!adapter) {
          result.files_failed++;
          continue;
        }

        const ingestResult = await this.ingest(adapter);
        result.items_created += ingestResult.created;
        result.items_updated += ingestResult.updated;
        result.items_skipped += ingestResult.skipped;

        await this.dropZoneWatcher.moveToProcessed(filePath);
        result.files_processed++;
      } catch (err) {
        result.files_failed++;
        await this.emitEvent("vault.error" as JournalEventType, {
          operation: "dropzone",
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result.files_processed > 0) {
      await this.emitEvent("vault.dropzone_processed" as JournalEventType, {
        files_processed: result.files_processed,
        files_failed: result.files_failed,
        items_created: result.items_created,
      });
    }

    return result;
  }

  getDropZonePath(): string {
    return join(this.vaultRoot, "_DropZone");
  }

  getStats(): VaultStats {
    const storeStats = this.objectStore.getStats();
    return {
      total_objects: storeStats.total,
      total_links: this.linkStore.size(),
      objects_by_type: storeStats.by_type,
      objects_by_category: storeStats.by_category,
      unclassified_count: storeStats.by_category["inbox"] ?? 0,
    };
  }

  search(query: {
    text?: string;
    object_type?: string;
    para_category?: ParaCategory;
    tags?: string[];
    source?: string;
    limit?: number;
  }) {
    return this.objectStore.search(query);
  }

  async getObject(objectId: string): Promise<VaultObject | null> {
    return this.objectStore.get(objectId);
  }

  getObjectStore(): ObjectStore { return this.objectStore; }
  getLinkStore(): LinkStore { return this.linkStore; }
  getTracker(): IngestionTracker { return this.tracker; }
  getDeduplicator(): Deduplicator { return this.deduplicator; }
  getSchema(): OntologySchema { return this.schema; }
  getVaultRoot(): string { return this.vaultRoot; }
  getVectorStore(): VectorStore { return this.vectorStore; }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.deduplicator.save(),
      this.linkStore.save(),
      this.vectorStore.save(),
    ]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length > 0) {
      throw new Error(`VaultManager.close() failed: ${errors.map((e) => String(e.reason)).join("; ")}`);
    }
  }
}
