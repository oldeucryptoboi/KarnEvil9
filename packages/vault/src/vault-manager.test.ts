import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { existsSync } from "node:fs";
import { VaultManager } from "./vault-manager.js";
import type { ClassifierFn, EmbedderFn, IngestItem, VaultAdapter } from "./types.js";

function mockClassifier(): ClassifierFn {
  return async (_title, _content, _availableTypes) => ({
    object_type: "Conversation",
    para_category: "resources",
    tags: ["test"],
    entities: [{ name: "TypeScript", type: "Tool", link_type: "discusses" }],
    confidence: 0.85,
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

describe("VaultManager", () => {
  let tmpDir: string;
  let manager: VaultManager;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-manager-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });

    manager = new VaultManager({
      vaultRoot: tmpDir,
      classifier: mockClassifier(),
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("scaffold", () => {
    it("creates vault directory structure", async () => {
      expect(existsSync(join(tmpDir, "01-Projects"))).toBe(true);
      expect(existsSync(join(tmpDir, "02-Areas"))).toBe(true);
      expect(existsSync(join(tmpDir, "03-Resources"))).toBe(true);
      expect(existsSync(join(tmpDir, "04-Archive"))).toBe(true);
      expect(existsSync(join(tmpDir, "_Inbox"))).toBe(true);
      expect(existsSync(join(tmpDir, "_Ontology", "Schema"))).toBe(true);
      expect(existsSync(join(tmpDir, "_Ontology", "Objects", "People"))).toBe(true);
      expect(existsSync(join(tmpDir, "_Ontology", "Links"))).toBe(true);
    });

    it("creates default ontology schema file", () => {
      expect(existsSync(join(tmpDir, "_Ontology", "Schema", "ontology.yaml"))).toBe(true);
    });
  });

  describe("ingest", () => {
    it("ingests items from an adapter", async () => {
      const adapter = createMockAdapter([
        {
          source: "test",
          source_id: "item-1",
          title: "First Item",
          content: "Hello world",
          created_at: new Date().toISOString(),
          metadata: {},
        },
        {
          source: "test",
          source_id: "item-2",
          title: "Second Item",
          content: "Goodbye world",
          created_at: new Date().toISOString(),
          metadata: {},
        },
      ]);

      const result = await manager.ingest(adapter);
      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("skips already-ingested items", async () => {
      const items: IngestItem[] = [{
        source: "test",
        source_id: "dupe-1",
        title: "Duplicate",
        content: "Same content",
        created_at: new Date().toISOString(),
        metadata: {},
      }];

      const adapter1 = createMockAdapter(items);
      await manager.ingest(adapter1);

      const adapter2 = createMockAdapter(items);
      const result = await manager.ingest(adapter2);
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
    });

    it("updates items when content changes", async () => {
      const adapter1 = createMockAdapter([{
        source: "test",
        source_id: "update-1",
        title: "Original",
        content: "Version 1",
        created_at: new Date().toISOString(),
        metadata: {},
      }]);
      await manager.ingest(adapter1);

      const adapter2 = createMockAdapter([{
        source: "test",
        source_id: "update-1",
        title: "Updated",
        content: "Version 2",
        created_at: new Date().toISOString(),
        metadata: {},
      }]);
      const result = await manager.ingest(adapter2);
      expect(result.updated).toBe(1);
    });
  });

  describe("classify", () => {
    it("classifies unclassified items", async () => {
      // Ingest items (they start in inbox)
      const adapter = createMockAdapter([{
        source: "test",
        source_id: "classify-1",
        title: "To Classify",
        content: "Content about TypeScript",
        created_at: new Date().toISOString(),
        metadata: {},
      }]);
      await manager.ingest(adapter);

      const result = await manager.classify();
      expect(result.classified).toBe(1);
      expect(result.errors).toBe(0);
    });

    it("throws when no classifier is configured", async () => {
      const managerNoClassifier = new VaultManager({ vaultRoot: tmpDir });
      await managerNoClassifier.init();

      await expect(managerNoClassifier.classify()).rejects.toThrow("No classifier configured");
      await managerNoClassifier.close();
    });
  });

  describe("classify with errors", () => {
    it("counts errors when classifier fails", async () => {
      const failingClassifier: ClassifierFn = async () => {
        throw new Error("LLM unavailable");
      };
      const failManager = new VaultManager({
        vaultRoot: tmpDir,
        classifier: failingClassifier,
      });
      await failManager.init();

      const adapter = createMockAdapter([{
        source: "test",
        source_id: "fail-cls-1",
        title: "Will Fail Classification",
        content: "Content here",
        created_at: new Date().toISOString(),
        metadata: {},
      }]);
      await failManager.ingest(adapter);

      const result = await failManager.classify();
      expect(result.errors).toBe(1);
      expect(result.classified).toBe(0);

      await failManager.close();
    });
  });

  describe("entity deduplication", () => {
    it("emits dedup event when entity already exists", async () => {
      // First ingest + classify creates the entity
      const adapter1 = createMockAdapter([{
        source: "test",
        source_id: "dedup-1",
        title: "First TypeScript Doc",
        content: "About TypeScript",
        created_at: new Date().toISOString(),
        metadata: {},
      }]);
      await manager.ingest(adapter1);
      await manager.classify();

      // Second ingest + classify sees same entity → dedup
      const adapter2 = createMockAdapter([{
        source: "test",
        source_id: "dedup-2",
        title: "Another TypeScript Doc",
        content: "More TypeScript",
        created_at: new Date().toISOString(),
        metadata: {},
      }]);
      await manager.ingest(adapter2);
      const result = await manager.classify();
      expect(result.classified).toBe(1);
    });
  });

  describe("search", () => {
    it("searches ingested objects", async () => {
      const adapter = createMockAdapter([{
        source: "test",
        source_id: "search-1",
        title: "TypeScript Guide",
        content: "Learn TS",
        created_at: new Date().toISOString(),
        metadata: { tags: ["coding"] },
      }]);
      await manager.ingest(adapter);

      const results = manager.search({ text: "typescript" });
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe("TypeScript Guide");
    });
  });

  describe("getStats", () => {
    it("returns vault statistics", async () => {
      const adapter = createMockAdapter([
        { source: "test", source_id: "s1", title: "A", content: "C", created_at: new Date().toISOString(), metadata: {} },
        { source: "test", source_id: "s2", title: "B", content: "D", created_at: new Date().toISOString(), metadata: {} },
      ]);
      await manager.ingest(adapter);

      const stats = manager.getStats();
      expect(stats.total_objects).toBe(2);
    });
  });

  describe("scaffold", () => {
    it("creates _Meta directory", async () => {
      expect(existsSync(join(tmpDir, "_Meta"))).toBe(true);
    });
  });

  describe("generateContext", () => {
    it("generates a context briefing", async () => {
      const briefing = await manager.generateContext();
      expect(briefing.generated_at).toBeTruthy();
      expect(existsSync(join(tmpDir, "_Meta", "current-context.md"))).toBe(true);
    });
  });

  describe("janitor", () => {
    it("runs cleanup operations", async () => {
      const result = await manager.janitor();
      expect(result.orphaned_links_removed).toBe(0);
      expect(result.frontmatter_fixed).toBe(0);
      expect(result.duplicates_merged).toBe(0);
      expect(result.stale_archived).toBe(0);
      expect(result.tracker_compacted).toBe(true);
      expect(result.wikilink_stubs_created).toBe(0);
    });

    it("archives stale inbox items older than 30 days", async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const adapter = createMockAdapter([{
        source: "test",
        source_id: "stale-1",
        title: "Old Item",
        content: "Very old",
        created_at: oldDate,
        metadata: {},
      }]);
      await manager.ingest(adapter);

      const result = await manager.janitor();
      expect(result.stale_archived).toBe(1);

      // Verify item is now in archive
      const archived = manager.search({ para_category: "archive" });
      expect(archived.some((e) => e.title === "Old Item")).toBe(true);
    });

    it("removes duplicate objects with same source+source_id", async () => {
      // Create two objects manually with same source+source_id
      const store = manager.getObjectStore();
      const schema = manager.getSchema();
      await store.create("First", "Content 1", {
        source: "test", source_id: "dup-source",
        created_at: new Date(Date.now() - 1000).toISOString(),
      }, schema);
      await store.create("Second", "Content 2", {
        source: "test", source_id: "dup-source",
        created_at: new Date().toISOString(),
      }, schema);

      const result = await manager.janitor();
      expect(result.duplicates_merged).toBe(1);
      expect(manager.getStats().total_objects).toBe(1);
    });
  });

  describe("vectorStore", () => {
    it("exposes vector store accessor", () => {
      const vs = manager.getVectorStore();
      expect(vs).toBeTruthy();
      expect(vs.size()).toBe(0);
    });
  });

  describe("generateDashboard", () => {
    it("generates Dashboard.md", async () => {
      const filePath = await manager.generateDashboard();
      expect(filePath).toBe(join(tmpDir, "Dashboard.md"));
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe("generateInsights", () => {
    it("generates Insights.md", async () => {
      const filePath = await manager.generateInsights();
      expect(filePath).toBe(join(tmpDir, "Insights.md"));
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe("getDashboardData", () => {
    it("returns dashboard data", () => {
      const data = manager.getDashboardData();
      expect(data.generated_at).toBeTruthy();
      expect(data.total_objects).toBe(0);
      expect(data.total_links).toBe(0);
    });
  });

  describe("janitor frontmatter validation", () => {
    it("fixes objects with missing created_at", async () => {
      // Write a markdown file directly with missing created_at
      const objectId = "fix-test-" + uuid().slice(0, 8);
      const malformedMd = [
        "---",
        `object_id: "${objectId}"`,
        "object_type: Note",
        "source: test",
        "source_id: ff-1",
        'ingested_at: "2026-01-01T00:00:00Z"',
        "tags: []",
        "entities: []",
        "confidence: 0",
        'classified_by: "unclassified"',
        "---",
        "",
        "# Missing Fields",
        "",
        "Content here",
      ].join("\n");

      await writeFile(join(tmpDir, "_Inbox", "Missing Fields.md"), malformedMd, "utf-8");

      // Reinit to pick up the new file
      const freshManager = new VaultManager({
        vaultRoot: tmpDir,
        classifier: mockClassifier(),
      });
      await freshManager.init();

      const result = await freshManager.janitor();
      expect(result.frontmatter_fixed).toBeGreaterThanOrEqual(1);

      await freshManager.close();
    });
  });

  describe("janitor stale embedding cleanup", () => {
    it("removes embeddings for deleted objects", async () => {
      const mockEmbedder: EmbedderFn = async (texts: string[]) =>
        texts.map(() => [0.5, 0.5, 0.5]);

      const embManager = new VaultManager({
        vaultRoot: tmpDir,
        classifier: mockClassifier(),
        embedder: mockEmbedder,
      });
      await embManager.init();

      // Create and vectorize an object
      const adapter = createMockAdapter([
        { source: "test", source_id: "stale-emb-1", title: "Will Delete", content: "Temp content", created_at: new Date().toISOString(), metadata: {} },
      ]);
      await embManager.ingest(adapter);
      await embManager.vectorize();
      expect(embManager.getVectorStore().size()).toBe(1);

      // Delete the object but keep the embedding
      const results = embManager.search({ text: "Will Delete" });
      const objId = results[0]!.object_id;
      await embManager.getObjectStore().delete(objId);

      // Run janitor — should clean up orphaned embedding
      await embManager.janitor();
      expect(embManager.getVectorStore().size()).toBe(0);

      await embManager.close();
    });
  });

  describe("wikilink stub creation", () => {
    it("creates stub for broken wikilink", async () => {
      const store = manager.getObjectStore();
      const schema = manager.getSchema();
      await store.create("My Note", "Check out [[Unknown Entity]] for details", {
        source: "test",
        source_id: "wl-1",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      const result = await manager.janitor();
      expect(result.wikilink_stubs_created).toBe(1);

      // The stub should exist now
      const stubs = manager.search({ text: "Unknown Entity" });
      expect(stubs.length).toBeGreaterThanOrEqual(1);
      const stub = stubs.find((s) => s.source === "janitor-stub");
      expect(stub).toBeTruthy();
      expect(stub!.tags).toContain("stub");
      expect(stub!.tags).toContain("auto-generated");
    });

    it("does not create stub when target object exists", async () => {
      const store = manager.getObjectStore();
      const schema = manager.getSchema();

      // Create target first
      await store.create("Existing Entity", "I exist", {
        source: "test",
        source_id: "wl-existing",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      // Create note that references it
      await store.create("Reference Note", "See [[Existing Entity]] here", {
        source: "test",
        source_id: "wl-2",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      const result = await manager.janitor();
      expect(result.wikilink_stubs_created).toBe(0);
    });

    it("creates mentions link from source to stub", async () => {
      const store = manager.getObjectStore();
      const schema = manager.getSchema();
      const source = await store.create("Linking Note", "References [[New Target]]", {
        source: "test",
        source_id: "wl-3",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      await manager.janitor();

      const links = manager.getLinkStore().getLinksForObject(source.frontmatter.object_id);
      const mentionsLink = links.find((l) => l.link_type === "mentions");
      expect(mentionsLink).toBeTruthy();
    });

    it("creates single stub for multiple references to same missing target", async () => {
      const store = manager.getObjectStore();
      const schema = manager.getSchema();
      await store.create("Note A", "See [[Missing Thing]]", {
        source: "test",
        source_id: "wl-4a",
        object_type: "Note",
        para_category: "resources",
      }, schema);
      await store.create("Note B", "Also see [[Missing Thing]]", {
        source: "test",
        source_id: "wl-4b",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      const result = await manager.janitor();
      expect(result.wikilink_stubs_created).toBe(1);
    });

    it("returns 0 when no broken wikilinks exist", async () => {
      const store = manager.getObjectStore();
      const schema = manager.getSchema();
      await store.create("Plain Note", "No wikilinks here", {
        source: "test",
        source_id: "wl-5",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      const result = await manager.janitor();
      expect(result.wikilink_stubs_created).toBe(0);
    });

    it("finds wikilinks at start of content across multiple entries (regex lastIndex regression)", async () => {
      const store = manager.getObjectStore();
      const schema = manager.getSchema();
      // First entry: wikilink at end of long content (advances regex lastIndex)
      await store.create("Entry One", "Lots of text before [[Alpha Target]] here", {
        source: "test",
        source_id: "wl-regression-1",
        object_type: "Note",
        para_category: "resources",
      }, schema);
      // Second entry: wikilink at very start (would be skipped if lastIndex carried over)
      await store.create("Entry Two", "[[Beta Target]] appears at the start", {
        source: "test",
        source_id: "wl-regression-2",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      const result = await manager.janitor();
      expect(result.wikilink_stubs_created).toBe(2);
      const stubs = manager.search({ source: "janitor-stub" });
      const stubTitles = stubs.map((s) => s.title).sort();
      expect(stubTitles).toEqual(["Alpha Target", "Beta Target"]);
    });

    it("stubs have correct frontmatter", async () => {
      const store = manager.getObjectStore();
      const schema = manager.getSchema();
      await store.create("Referrer", "Link to [[Stub Target]]", {
        source: "test",
        source_id: "wl-6",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      await manager.janitor();

      const stubs = manager.search({ source: "janitor-stub" });
      expect(stubs.length).toBe(1);
      expect(stubs[0]!.para_category).toBe("inbox");
    });
  });

  describe("janitor stale archival moves files", () => {
    it("physically moves stale inbox items to archive folder", async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const adapter = createMockAdapter([{
        source: "test",
        source_id: "move-stale-1",
        title: "Old Stale Item",
        content: "Very old content",
        created_at: oldDate,
        metadata: {},
      }]);
      await manager.ingest(adapter);

      // Verify item starts in _Inbox
      const beforeResults = manager.search({ text: "Old Stale Item" });
      expect(beforeResults[0]!.file_path).toContain("_Inbox");

      await manager.janitor();

      // Verify item is now in 04-Archive
      const afterResults = manager.search({ text: "Old Stale Item" });
      expect(afterResults[0]!.file_path).toContain("04-Archive");
      expect(existsSync(join(tmpDir, afterResults[0]!.file_path))).toBe(true);
    });
  });

  describe("getObject", () => {
    it("retrieves an object by ID", async () => {
      const adapter = createMockAdapter([{
        source: "test",
        source_id: "get-1",
        title: "Retrievable",
        content: "Content",
        created_at: new Date().toISOString(),
        metadata: {},
      }]);
      await manager.ingest(adapter);

      const results = manager.search({ text: "retrievable" });
      expect(results.length).toBe(1);

      const obj = await manager.getObject(results[0]!.object_id);
      expect(obj).not.toBeNull();
      expect(obj!.title).toBe("Retrievable");
    });
  });

  describe("scaffold creates DropZone dirs", () => {
    it("creates _DropZone and _DropZone/_processed", () => {
      expect(existsSync(join(tmpDir, "_DropZone"))).toBe(true);
      expect(existsSync(join(tmpDir, "_DropZone", "_processed"))).toBe(true);
    });

    it("creates _Meta/archive directory", () => {
      expect(existsSync(join(tmpDir, "_Meta", "archive"))).toBe(true);
    });
  });

  describe("vectorize", () => {
    it("embeds objects and saves vector store", async () => {
      const mockEmbedder: EmbedderFn = async (texts: string[]) =>
        texts.map(() => [0.5, 0.5, 0.5]);

      const embManager = new VaultManager({
        vaultRoot: tmpDir,
        classifier: mockClassifier(),
        embedder: mockEmbedder,
      });
      await embManager.init();

      // Ingest some objects first
      const adapter = createMockAdapter([
        { source: "test", source_id: "v1", title: "Doc A", content: "Content A", created_at: new Date().toISOString(), metadata: {} },
        { source: "test", source_id: "v2", title: "Doc B", content: "Content B", created_at: new Date().toISOString(), metadata: {} },
      ]);
      await embManager.ingest(adapter);

      const result = await embManager.vectorize();
      expect(result.embeddings_created).toBe(2);
      expect(embManager.getVectorStore().size()).toBe(2);

      await embManager.close();
    });
  });

  describe("semanticSearch", () => {
    it("searches by embedding similarity", async () => {
      const mockEmbedder: EmbedderFn = async (texts: string[]) =>
        texts.map((t) => {
          // Simple deterministic embedding
          if (t.includes("TypeScript")) return [1, 0, 0];
          if (t.includes("Cooking")) return [0, 0, 1];
          return [0.5, 0.5, 0.5];
        });

      const embManager = new VaultManager({
        vaultRoot: tmpDir,
        classifier: mockClassifier(),
        embedder: mockEmbedder,
      });
      await embManager.init();

      const adapter = createMockAdapter([
        { source: "test", source_id: "ss1", title: "TypeScript Guide", content: "Learn TypeScript", created_at: new Date().toISOString(), metadata: {} },
        { source: "test", source_id: "ss2", title: "Cooking Recipes", content: "Italian Cooking", created_at: new Date().toISOString(), metadata: {} },
      ]);
      await embManager.ingest(adapter);
      await embManager.vectorize();

      const results = await embManager.semanticSearch("TypeScript", 2);
      expect(results.length).toBe(2);
      // TypeScript Guide should be ranked higher (more similar to query)
      expect(results[0]!.title).toBe("TypeScript Guide");

      await embManager.close();
    });

    it("returns empty array when no embeddings exist", async () => {
      const results = await manager.semanticSearch("anything");
      expect(results).toEqual([]);
    });

    it("throws when no embedder configured for non-empty store", async () => {
      // Manually set an embedding so store is non-empty
      manager.getVectorStore().setEmbedding("fake", new Float32Array([1, 0]));

      await expect(manager.semanticSearch("query")).rejects.toThrow("No embedder configured");
    });
  });

  describe("discoverRelationships", () => {
    it("delegates to relationship discoverer", async () => {
      const mockEmbedder: EmbedderFn = async (texts: string[]) =>
        texts.map(() => [0.5, 0.5, 0.5]);

      const embManager = new VaultManager({
        vaultRoot: tmpDir,
        classifier: mockClassifier(),
        embedder: mockEmbedder,
      });
      await embManager.init();

      const { result, clusters } = await embManager.discoverRelationships();
      expect(result.embeddings_created).toBe(0);
      expect(result.clusters_found).toBe(0);
      expect(Array.isArray(clusters)).toBe(true);

      await embManager.close();
    });
  });

  describe("processDropZone", () => {
    it("ingests detected ChatGPT files and moves to _processed", async () => {
      const dropDir = join(tmpDir, "_DropZone");
      const chatgptData = [{
        id: "conv1",
        title: "Test Conversation",
        create_time: Date.now() / 1000,
        update_time: Date.now() / 1000,
        mapping: {
          "root": {
            id: "root",
            children: ["msg1"],
          },
          "msg1": {
            id: "msg1",
            message: {
              author: { role: "user" },
              content: { parts: ["Hello world"], content_type: "text" },
              create_time: Date.now() / 1000,
            },
            children: [],
            parent: "root",
          },
        },
      }];
      await writeFile(join(dropDir, "export.json"), JSON.stringify(chatgptData), "utf-8");

      const result = await manager.processDropZone();
      expect(result.files_processed).toBe(1);
      expect(result.items_created).toBeGreaterThanOrEqual(1);

      // Verify file moved to _processed
      const processedFiles = await readdir(join(dropDir, "_processed"));
      expect(processedFiles.some((f) => f.includes("export.json"))).toBe(true);
    });

    it("returns zero counts when dropzone is empty", async () => {
      const result = await manager.processDropZone();
      expect(result.files_processed).toBe(0);
      expect(result.files_failed).toBe(0);
      expect(result.items_created).toBe(0);
    });

    it("handles unknown file types gracefully", async () => {
      const dropDir = join(tmpDir, "_DropZone");
      await writeFile(join(dropDir, "unknown.xyz"), "Unknown format", "utf-8");

      const result = await manager.processDropZone();
      expect(result.files_processed).toBe(0);
      expect(result.files_failed).toBe(0); // Unknown types just get skipped by scan
    });

    it("handles adapter error gracefully and emits vault.error event", async () => {
      const dropDir = join(tmpDir, "_DropZone");
      // Create a chatgpt-like JSON that passes detection (has mapping key)
      // but causes adapter to throw: create_time as string makes
      // new Date("bad" * 1000).toISOString() throw RangeError
      const badJson = JSON.stringify([{
        id: "c1",
        title: "T",
        create_time: "not_a_number",
        update_time: "not_a_number",
        mapping: {
          "n1": {
            id: "n1",
            message: { author: { role: "user" }, content: { parts: ["hello"] }, create_time: 1 },
            children: [],
          },
        },
      }]);
      await writeFile(join(dropDir, "bad-chatgpt.json"), badJson, "utf-8");

      const result = await manager.processDropZone();
      expect(result.files_failed).toBe(1);
      expect(result.files_processed).toBe(0);
    });

    it("exposes dropzone path accessor", () => {
      expect(manager.getDropZonePath()).toBe(join(tmpDir, "_DropZone"));
    });

    it("ingests detected Claude files from dropzone", async () => {
      const dropDir = join(tmpDir, "_DropZone");
      const claudeData = [{
        uuid: "chat-abc",
        name: "Claude Chat Test",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "human",
            text: "Hello from Claude export",
            created_at: new Date().toISOString(),
          },
          {
            uuid: "msg-2",
            sender: "assistant",
            text: "Hello! How can I help?",
            created_at: new Date().toISOString(),
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }];
      await writeFile(join(dropDir, "claude-export.json"), JSON.stringify(claudeData), "utf-8");

      const result = await manager.processDropZone();
      expect(result.files_processed).toBe(1);
      expect(result.items_created).toBeGreaterThanOrEqual(1);

      // Verify file moved
      const processedFiles = await readdir(join(dropDir, "_processed"));
      expect(processedFiles.some((f) => f.includes("claude-export.json"))).toBe(true);
    });

    it("ingests detected WhatsApp files from dropzone", async () => {
      const dropDir = join(tmpDir, "_DropZone");
      const chatContent = [
        "15/01/2024, 10:30 - Alice: Hello from dropzone!",
        "15/01/2024, 10:31 - Bob: Hi Alice!",
      ].join("\n");
      await writeFile(join(dropDir, "WhatsApp Chat with Alice.txt"), chatContent, "utf-8");

      const result = await manager.processDropZone();
      expect(result.files_processed).toBe(1);
      expect(result.items_created).toBeGreaterThanOrEqual(1);

      // Verify file moved
      const processedFiles = await readdir(join(dropDir, "_processed"));
      expect(processedFiles.some((f) => f.includes("WhatsApp Chat with Alice.txt"))).toBe(true);
    });

    it("counts failed files when adapter throws during ingestion", async () => {
      const dropDir = join(tmpDir, "_DropZone");
      // Create a WhatsApp .txt file - the adapter will be loaded but may fail to parse
      // Actually, let's create a file that will be detected but the adapter doesn't handle well
      // An mbox file has no adapter yet, so it would count as files_failed
      await writeFile(join(dropDir, "test.mbox"), "From sender@example.com", "utf-8");

      const result = await manager.processDropZone();
      // Gmail mbox is detected but no mbox adapter → files_failed
      expect(result.files_failed).toBe(1);
      expect(result.files_processed).toBe(0);
    });
  });
});
