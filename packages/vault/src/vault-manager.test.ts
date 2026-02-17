import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { existsSync } from "node:fs";
import { VaultManager } from "./vault-manager.js";
import type { ClassifierFn, IngestItem, VaultAdapter } from "./types.js";

function mockClassifier(): ClassifierFn {
  return async (title, content, availableTypes) => ({
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

  describe("generateContext", () => {
    it("generates a context briefing", async () => {
      const briefing = await manager.generateContext();
      expect(briefing.generated_at).toBeTruthy();
      expect(existsSync(join(tmpDir, "current-context.md"))).toBe(true);
    });
  });

  describe("janitor", () => {
    it("runs cleanup operations", async () => {
      const result = await manager.janitor();
      expect(result.orphaned_links_removed).toBe(0);
      expect(result.tracker_compacted).toBe(true);
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
});
