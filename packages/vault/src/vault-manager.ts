import { mkdir } from "node:fs/promises";
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
import { writeFile } from "node:fs/promises";

export interface VaultManagerOptions {
  vaultRoot: string;
  schema?: OntologySchema;
  classifier?: ClassifierFn;
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
  private emitEvent: (type: JournalEventType, payload: Record<string, unknown>) => Promise<void>;

  constructor(options: VaultManagerOptions) {
    this.vaultRoot = options.vaultRoot;
    this.schema = options.schema ?? getDefaultSchema();

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
    );

    this.emitEvent = options.emitEvent ?? (async () => {});
  }

  async init(): Promise<void> {
    await this.scaffold();
    await this.objectStore.init();
    await this.linkStore.init();
    await this.tracker.init();
    await this.deduplicator.init();
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

  async janitor(): Promise<{ orphaned_links_removed: number; tracker_compacted: boolean }> {
    // Remove orphaned links
    const validIds = new Set(
      this.objectStore.search({}).map((e) => e.object_id),
    );
    const orphanedLinksRemoved = await this.linkStore.removeOrphanedLinks(validIds);

    // Compact tracker
    await this.tracker.compact();

    // Save deduplicator state
    await this.deduplicator.save();

    await this.emitEvent("vault.janitor_completed" as JournalEventType, {
      orphaned_links_removed: orphanedLinksRemoved,
      tracker_compacted: true,
    });

    return { orphaned_links_removed: orphanedLinksRemoved, tracker_compacted: true };
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

  async close(): Promise<void> {
    await this.deduplicator.save();
    await this.linkStore.save();
  }
}
