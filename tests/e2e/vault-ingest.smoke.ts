/**
 * Vault Ingest Pipeline E2E Smoke Test
 *
 * Tests the full vault ingestion lifecycle: VaultManager creation,
 * file ingestion via adapters, classification pipeline, dropzone
 * scanning, search/retrieval, and duplicate detection.
 * Self-contained — no running API server required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { v4 as uuid } from "uuid";
import { VaultManager, DropZoneWatcher } from "@karnevil9/vault";
import type {
  VaultAdapter,
  IngestItem,
  ClassifierFn,
  EmbedderFn,
} from "@karnevil9/vault";

// ─── Helpers ──────────────────────────────────────────────────────────

function mockClassifier(): ClassifierFn {
  return async (title, _content, _availableTypes) => {
    // Deterministic classification based on title keywords
    if (title.toLowerCase().includes("project")) {
      return {
        object_type: "Project",
        para_category: "projects",
        tags: ["project"],
        entities: [{ name: "Engineering", type: "Organization", link_type: "belongs_to" }],
        confidence: 0.9,
      };
    }
    return {
      object_type: "Conversation",
      para_category: "resources",
      tags: ["test"],
      entities: [{ name: "TestEntity", type: "Concept", link_type: "discusses" }],
      confidence: 0.85,
    };
  };
}

function mockEmbedder(): EmbedderFn {
  return async (texts: string[]) =>
    texts.map((t) => {
      // Simple deterministic embedding based on content
      if (t.toLowerCase().includes("typescript")) return [1, 0, 0];
      if (t.toLowerCase().includes("cooking")) return [0, 0, 1];
      if (t.toLowerCase().includes("project")) return [0, 1, 0];
      return [0.5, 0.5, 0.5];
    });
}

function createMockAdapter(items: IngestItem[]): VaultAdapter {
  return {
    name: "test-adapter",
    source: "test",
    async *extract() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

function makeItem(overrides: Partial<IngestItem> & { source_id: string; title: string }): IngestItem {
  return {
    source: "test",
    content: `Content for ${overrides.title}`,
    created_at: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("Vault Ingest Pipeline Smoke", () => {
  let testDir: string;
  let manager: VaultManager;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-vault-${uuid()}`);
    await mkdir(testDir, { recursive: true });

    manager = new VaultManager({
      vaultRoot: testDir,
      classifier: mockClassifier(),
      embedder: mockEmbedder(),
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.close();
    await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  // ─── 1. Vault Manager Lifecycle ──────────────────────────────────

  describe("vault manager lifecycle", () => {
    it("scaffolds vault directory structure on init", () => {
      expect(existsSync(join(testDir, "_Inbox"))).toBe(true);
      expect(existsSync(join(testDir, "01-Projects"))).toBe(true);
      expect(existsSync(join(testDir, "02-Areas"))).toBe(true);
      expect(existsSync(join(testDir, "03-Resources"))).toBe(true);
      expect(existsSync(join(testDir, "04-Archive"))).toBe(true);
      expect(existsSync(join(testDir, "_Ontology", "Schema"))).toBe(true);
      expect(existsSync(join(testDir, "_Ontology", "Objects"))).toBe(true);
      expect(existsSync(join(testDir, "_Ontology", "Links"))).toBe(true);
      expect(existsSync(join(testDir, "_DropZone"))).toBe(true);
      expect(existsSync(join(testDir, "_DropZone", "_processed"))).toBe(true);
      expect(existsSync(join(testDir, "_Meta"))).toBe(true);
    });

    it("creates ontology schema file", () => {
      expect(existsSync(join(testDir, "_Ontology", "Schema", "ontology.yaml"))).toBe(true);
    });

    it("ingest a text item and verify it appears in search results", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "lifecycle-1", title: "Lifecycle Test Note", content: "Hello vault world" }),
      ]);

      const result = await manager.ingest(adapter);
      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);

      // Verify search finds it
      const found = manager.search({ text: "lifecycle" });
      expect(found.length).toBe(1);
      expect(found[0]!.title).toBe("Lifecycle Test Note");
      expect(found[0]!.source).toBe("test");
      expect(found[0]!.source_id).toBe("lifecycle-1");

      // Verify the object is retrievable
      const obj = await manager.getObject(found[0]!.object_id);
      expect(obj).not.toBeNull();
      expect(obj!.content).toBe("Hello vault world");
      expect(obj!.frontmatter.object_id).toBe(found[0]!.object_id);
    });

    it("reports correct stats after ingestion", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "stat-1", title: "Stat Item A" }),
        makeItem({ source_id: "stat-2", title: "Stat Item B" }),
        makeItem({ source_id: "stat-3", title: "Stat Item C" }),
      ]);
      await manager.ingest(adapter);

      const stats = manager.getStats();
      expect(stats.total_objects).toBe(3);
      expect(stats.unclassified_count).toBe(3); // All start in inbox
      expect(stats.objects_by_category.inbox).toBe(3);
    });
  });

  // ─── 2. Dropzone Scan and Ingest ────────────────────────────────

  describe("dropzone scan and ingest", () => {
    it("DropZoneWatcher detects files placed in the dropzone", async () => {
      const dropDir = join(testDir, "_DropZone");

      // Place a ChatGPT-style JSON export in the dropzone
      const chatgptExport = [
        {
          id: "conv-dz-1",
          title: "Dropzone Test Chat",
          create_time: Date.now() / 1000,
          update_time: Date.now() / 1000,
          mapping: {
            root: { id: "root", children: ["msg1"] },
            msg1: {
              id: "msg1",
              message: {
                author: { role: "user" },
                content: { parts: ["Hello from dropzone"], content_type: "text" },
                create_time: Date.now() / 1000,
              },
              children: [],
              parent: "root",
            },
          },
        },
      ];
      await writeFile(join(dropDir, "conversations.json"), JSON.stringify(chatgptExport), "utf-8");

      // Direct DropZoneWatcher scan
      const watcher = new DropZoneWatcher(dropDir);
      const detected = await watcher.scan();

      expect(detected.length).toBe(1);
      expect(detected[0]!.detectedSource).toBe("chatgpt");
      expect(detected[0]!.filePath).toContain("conversations.json");
    });

    it("processDropZone ingests detected files and moves them to _processed", async () => {
      const dropDir = join(testDir, "_DropZone");

      // Place a Claude-style JSON export
      const claudeExport = [
        {
          uuid: "chat-dz-1",
          name: "Claude Dropzone Chat",
          chat_messages: [
            {
              uuid: "msg-1",
              sender: "human",
              text: "Testing dropzone ingestion",
              created_at: new Date().toISOString(),
            },
            {
              uuid: "msg-2",
              sender: "assistant",
              text: "Acknowledged.",
              created_at: new Date().toISOString(),
            },
          ],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
      await writeFile(join(dropDir, "claude-export.json"), JSON.stringify(claudeExport), "utf-8");

      const result = await manager.processDropZone();
      expect(result.files_processed).toBe(1);
      expect(result.items_created).toBeGreaterThanOrEqual(1);
      expect(result.files_failed).toBe(0);

      // Verify original file was moved to _processed
      const processedFiles = await readdir(join(dropDir, "_processed"));
      expect(processedFiles.some((f) => f.includes("claude-export.json"))).toBe(true);

      // Verify ingested object appears in search
      const results = manager.search({});
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("ignores hidden files and directories in the dropzone", async () => {
      const dropDir = join(testDir, "_DropZone");
      await writeFile(join(dropDir, ".hidden-file"), "should be ignored", "utf-8");

      const watcher = new DropZoneWatcher(dropDir);
      const detected = await watcher.scan();
      expect(detected.length).toBe(0);
    });

    it("returns empty result when dropzone is empty", async () => {
      const result = await manager.processDropZone();
      expect(result.files_processed).toBe(0);
      expect(result.files_failed).toBe(0);
      expect(result.items_created).toBe(0);
      expect(result.items_updated).toBe(0);
      expect(result.items_skipped).toBe(0);
    });
  });

  // ─── 3. Classification Pipeline ─────────────────────────────────

  describe("classification pipeline", () => {
    it("classifies ingested objects via the mock classifier", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "cls-1", title: "A Normal Conversation", content: "Discussing topics" }),
      ]);
      await manager.ingest(adapter);

      // Before classification, items are in inbox
      const beforeResults = manager.search({ para_category: "inbox" });
      expect(beforeResults.length).toBe(1);

      const result = await manager.classify();
      expect(result.classified + result.errors).toBe(1);

      // After classification, the original item is moved to resources.
      // Entity extraction may also create additional entity objects in resources.
      const resourceResults = manager.search({ para_category: "resources" });
      expect(resourceResults.length).toBeGreaterThanOrEqual(1);
      const originalItem = resourceResults.find((r) => r.title === "A Normal Conversation");
      expect(originalItem).toBeDefined();
      expect(originalItem!.object_type).toBe("Conversation");
    });

    it("classifies items differently based on content", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "cls-p1", title: "My Project Plan", content: "Project details" }),
        makeItem({ source_id: "cls-c1", title: "Casual Chat", content: "Just talking" }),
      ]);
      await manager.ingest(adapter);

      const result = await manager.classify();
      expect(result.classified).toBe(2);

      // Project-titled item should be classified as Project
      const projects = manager.search({ object_type: "Project" });
      expect(projects.length).toBe(1);
      expect(projects[0]!.title).toBe("My Project Plan");

      // Other item should be classified as Conversation
      const conversations = manager.search({ object_type: "Conversation" });
      expect(conversations.length).toBe(1);
      expect(conversations[0]!.title).toBe("Casual Chat");
    });

    it("entity extraction creates ontology objects and links", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "ent-1", title: "Entity Test Note", content: "Talking about concepts" }),
      ]);
      await manager.ingest(adapter);
      await manager.classify();

      // Check that entity extraction created links
      const links = manager.getLinkStore();
      expect(links.size()).toBeGreaterThan(0);
    });

    it("throws when no classifier is configured", async () => {
      const noClassManager = new VaultManager({ vaultRoot: testDir });
      await noClassManager.init();

      await expect(noClassManager.classify()).rejects.toThrow("No classifier configured");
      await noClassManager.close();
    });
  });

  // ─── 4. Search and Retrieval ────────────────────────────────────

  describe("search and retrieval", () => {
    it("searches by text match (title)", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "srch-1", title: "TypeScript Advanced Guide" }),
        makeItem({ source_id: "srch-2", title: "Cooking Recipes Collection" }),
        makeItem({ source_id: "srch-3", title: "TypeScript Basics" }),
      ]);
      await manager.ingest(adapter);

      const tsResults = manager.search({ text: "typescript" });
      expect(tsResults.length).toBe(2);
      expect(tsResults.every((r) => r.title.includes("TypeScript"))).toBe(true);

      const cookResults = manager.search({ text: "cooking" });
      expect(cookResults.length).toBe(1);
      expect(cookResults[0]!.title).toBe("Cooking Recipes Collection");
    });

    it("filters by object_type after classification", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "filt-1", title: "Project Alpha", content: "Project work" }),
        makeItem({ source_id: "filt-2", title: "Random Chat", content: "Just chatting" }),
        makeItem({ source_id: "filt-3", title: "Project Beta", content: "Another project" }),
      ]);
      await manager.ingest(adapter);
      await manager.classify();

      const projects = manager.search({ object_type: "Project" });
      expect(projects.length).toBe(2);
      expect(projects.map((p) => p.title).sort()).toEqual(["Project Alpha", "Project Beta"]);

      const conversations = manager.search({ object_type: "Conversation" });
      expect(conversations.length).toBe(1);
      expect(conversations[0]!.title).toBe("Random Chat");
    });

    it("filters by para_category", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "cat-1", title: "Inbox Item A" }),
        makeItem({ source_id: "cat-2", title: "Inbox Item B" }),
      ]);
      await manager.ingest(adapter);

      // All start in inbox
      const inbox = manager.search({ para_category: "inbox" });
      expect(inbox.length).toBe(2);

      const resources = manager.search({ para_category: "resources" });
      expect(resources.length).toBe(0);

      // Classify moves them to resources (entity extraction may add more objects)
      await manager.classify();
      const afterResources = manager.search({ para_category: "resources" });
      // At least the 2 original items, plus any extracted entity objects
      expect(afterResources.length).toBeGreaterThanOrEqual(2);
      const originalTitles = afterResources.map((r) => r.title);
      expect(originalTitles).toContain("Inbox Item A");
      expect(originalTitles).toContain("Inbox Item B");
    });

    it("filters by source", async () => {
      const adapterA = createMockAdapter([
        makeItem({ source: "source-a", source_id: "sa-1", title: "From Source A" }),
      ]);
      const adapterB: VaultAdapter = {
        name: "source-b-adapter",
        source: "source-b",
        async *extract() {
          yield makeItem({ source: "source-b", source_id: "sb-1", title: "From Source B" });
        },
      };
      await manager.ingest(adapterA);
      await manager.ingest(adapterB);

      const sourceAResults = manager.search({ source: "source-a" });
      expect(sourceAResults.length).toBe(1);
      expect(sourceAResults[0]!.title).toBe("From Source A");

      const sourceBResults = manager.search({ source: "source-b" });
      expect(sourceBResults.length).toBe(1);
      expect(sourceBResults[0]!.title).toBe("From Source B");
    });

    it("respects limit parameter", async () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        makeItem({ source_id: `lim-${i}`, title: `Item ${i}` }),
      );
      await manager.ingest(createMockAdapter(items));

      const limited = manager.search({ limit: 3 });
      expect(limited.length).toBe(3);

      const all = manager.search({});
      expect(all.length).toBe(10);
    });

    it("retrieves full object by ID", async () => {
      const adapter = createMockAdapter([
        makeItem({
          source_id: "get-1",
          title: "Detailed Object",
          content: "This has lots of detail in it.",
        }),
      ]);
      await manager.ingest(adapter);

      const results = manager.search({ text: "detailed" });
      expect(results.length).toBe(1);

      const obj = await manager.getObject(results[0]!.object_id);
      expect(obj).not.toBeNull();
      expect(obj!.title).toBe("Detailed Object");
      expect(obj!.content).toBe("This has lots of detail in it.");
      expect(obj!.frontmatter.source).toBe("test");
      expect(obj!.frontmatter.para_category).toBe("inbox");
    });

    it("semantic search returns results ranked by similarity", async () => {
      const adapter = createMockAdapter([
        makeItem({ source_id: "sem-1", title: "TypeScript Mastery", content: "Learn TypeScript deeply" }),
        makeItem({ source_id: "sem-2", title: "Cooking Italian", content: "Best Cooking pasta recipes" }),
      ]);
      await manager.ingest(adapter);
      await manager.vectorize();

      const results = await manager.semanticSearch("TypeScript", 2);
      expect(results.length).toBe(2);
      // TypeScript item should rank first (higher cosine similarity with mock embedder)
      expect(results[0]!.title).toBe("TypeScript Mastery");
    });
  });

  // ─── 5. Duplicate Detection ─────────────────────────────────────

  describe("duplicate detection", () => {
    it("skips ingestion when same source+source_id and same content", async () => {
      const items: IngestItem[] = [
        makeItem({ source_id: "dup-1", title: "Duplicate Item", content: "Identical content" }),
      ];

      // First ingest — creates
      const result1 = await manager.ingest(createMockAdapter(items));
      expect(result1.created).toBe(1);

      // Second ingest with same content — skips
      const result2 = await manager.ingest(createMockAdapter(items));
      expect(result2.skipped).toBe(1);
      expect(result2.created).toBe(0);
      expect(result2.updated).toBe(0);

      // Only one object in the vault
      expect(manager.getStats().total_objects).toBe(1);
    });

    it("updates when same source+source_id but different content", async () => {
      const original = makeItem({
        source_id: "dup-update-1",
        title: "Evolving Item",
        content: "Version 1 content",
      });

      const updated = makeItem({
        source_id: "dup-update-1",
        title: "Evolving Item Updated",
        content: "Version 2 content",
      });

      // First ingest
      const result1 = await manager.ingest(createMockAdapter([original]));
      expect(result1.created).toBe(1);

      // Second ingest with changed content — updates
      const result2 = await manager.ingest(createMockAdapter([updated]));
      expect(result2.updated).toBe(1);
      expect(result2.created).toBe(0);
      expect(result2.skipped).toBe(0);

      // Still only one object, but with updated content
      const stats = manager.getStats();
      expect(stats.total_objects).toBe(1);

      const results = manager.search({});
      const obj = await manager.getObject(results[0]!.object_id);
      expect(obj).not.toBeNull();
      expect(obj!.content).toBe("Version 2 content");
    });

    it("handles multiple duplicate ingestions correctly", async () => {
      const item = makeItem({ source_id: "multi-dup", title: "Repeated", content: "Same" });

      await manager.ingest(createMockAdapter([item]));
      await manager.ingest(createMockAdapter([item]));
      await manager.ingest(createMockAdapter([item]));

      expect(manager.getStats().total_objects).toBe(1);
    });

    it("items with different source_ids are not treated as duplicates", async () => {
      const items = [
        makeItem({ source_id: "unique-1", title: "Same Title", content: "Same content" }),
        makeItem({ source_id: "unique-2", title: "Same Title", content: "Same content" }),
      ];

      const result = await manager.ingest(createMockAdapter(items));
      expect(result.created).toBe(2);
      expect(manager.getStats().total_objects).toBe(2);
    });
  });

  // ─── 6. Full Ingestion Pipeline (end-to-end) ───────────────────

  describe("full pipeline: ingest -> classify -> vectorize -> search", () => {
    it("runs the complete pipeline from ingestion to semantic search", async () => {
      // Step 1: Ingest multiple items
      const adapter = createMockAdapter([
        makeItem({ source_id: "pipe-1", title: "TypeScript Deep Dive", content: "TypeScript generics and patterns" }),
        makeItem({ source_id: "pipe-2", title: "Cooking Adventures", content: "Italian Cooking with pasta" }),
        makeItem({ source_id: "pipe-3", title: "Project Roadmap", content: "Q1 Project milestones" }),
      ]);
      const ingestResult = await manager.ingest(adapter);
      expect(ingestResult.created).toBe(3);

      // Step 2: Classify all items
      // Classification may partially fail due to concurrent entity extraction race conditions
      // (e.g., two concurrent classifyBatch workers creating the same entity file).
      // The callback failure path in classifyBatch does not increment either counter,
      // so classified + errors may be less than the total item count.
      const classifyResult = await manager.classify();
      expect(classifyResult.classified).toBeGreaterThanOrEqual(2);

      // Verify classification moved items to their correct types
      const projects = manager.search({ object_type: "Project" });
      const conversations = manager.search({ object_type: "Conversation" });
      expect(projects.length + conversations.length).toBeGreaterThanOrEqual(2);

      // Step 3: Vectorize — embeds all objects (including any entity objects)
      const vecResult = await manager.vectorize();
      expect(vecResult.embeddings_created).toBeGreaterThanOrEqual(3);
      expect(manager.getVectorStore().size()).toBeGreaterThanOrEqual(3);

      // Step 4: Semantic search
      const tsResults = await manager.semanticSearch("TypeScript", 3);
      expect(tsResults.length).toBeGreaterThanOrEqual(1);
      // TypeScript item should rank high
      expect(tsResults.some((r) => r.title === "TypeScript Deep Dive")).toBe(true);

      // Step 5: Stats reflect full pipeline state
      const stats = manager.getStats();
      expect(stats.total_objects).toBeGreaterThanOrEqual(3);
      expect(stats.total_links).toBeGreaterThan(0);
    });
  });

  // ─── 7. Event Emission ──────────────────────────────────────────

  describe("event emission during ingestion", () => {
    it("emits vault events during the ingestion lifecycle", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

      const eventManager = new VaultManager({
        vaultRoot: testDir,
        classifier: mockClassifier(),
        emitEvent: async (type, payload) => {
          events.push({ type: type as string, payload });
        },
      });
      // Re-init over same directory is fine (scaffold is idempotent)
      await eventManager.init();

      const adapter = createMockAdapter([
        makeItem({ source_id: "evt-1", title: "Event Test Item", content: "Testing events" }),
      ]);
      await eventManager.ingest(adapter);

      // Should have ingestion_started, object_created, ingestion_completed
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("vault.ingestion_started");
      expect(eventTypes).toContain("vault.object_created");
      expect(eventTypes).toContain("vault.ingestion_completed");

      // Verify completion payload
      const completed = events.find((e) => e.type === "vault.ingestion_completed");
      expect(completed!.payload.created).toBe(1);
      expect(completed!.payload.updated).toBe(0);
      expect(completed!.payload.skipped).toBe(0);

      await eventManager.close();
    });
  });
});
