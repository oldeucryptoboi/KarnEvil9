import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { ObjectStore } from "./object-store.js";
import { getDefaultSchema } from "./ontology-schema.js";

describe("ObjectStore", () => {
  let tmpDir: string;
  let store: ObjectStore;
  const schema = getDefaultSchema();

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-objstore-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
    store = new ObjectStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    expect(store.size()).toBe(0);
  });

  it("creates and retrieves an object", async () => {
    const obj = await store.create("Test Note", "Hello world", {
      source: "test",
      source_id: "t1",
      object_type: "Note",
      para_category: "inbox",
    }, schema);

    expect(obj.frontmatter.object_id).toBeTruthy();
    expect(obj.title).toBe("Test Note");
    expect(store.size()).toBe(1);

    const retrieved = await store.get(obj.frontmatter.object_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Test Note");
    expect(retrieved!.content).toContain("Hello world");
  });

  it("creates entity objects in _Ontology folder", async () => {
    const obj = await store.create("TypeScript", "A programming language", {
      source: "entity",
      source_id: "typescript",
      object_type: "Tool",
      para_category: "resources",
    }, schema);

    expect(obj.file_path).toContain("_Ontology/Objects/Tools");
  });

  it("creates non-entity objects in PARA folders", async () => {
    const obj = await store.create("My Note", "Content here", {
      source: "manual",
      source_id: "note1",
      object_type: "Note",
      para_category: "resources",
    }, schema);

    expect(obj.file_path).toContain("03-Resources");
  });

  it("updates an existing object", async () => {
    const obj = await store.create("Original", "Original content", {
      source: "test",
      source_id: "u1",
    }, schema);

    const updated = await store.update(obj.frontmatter.object_id, {
      title: "Updated Title",
      content: "Updated content",
    });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated Title");

    const retrieved = await store.get(obj.frontmatter.object_id);
    expect(retrieved!.content).toContain("Updated content");
  });

  it("returns null when updating non-existent object", async () => {
    const result = await store.update("nonexistent", { title: "X" });
    expect(result).toBeNull();
  });

  it("deletes an object", async () => {
    const obj = await store.create("To Delete", "Bye", { source: "test", source_id: "d1" }, schema);
    expect(store.size()).toBe(1);

    const deleted = await store.delete(obj.frontmatter.object_id);
    expect(deleted).toBe(true);
    expect(store.size()).toBe(0);

    const retrieved = await store.get(obj.frontmatter.object_id);
    expect(retrieved).toBeNull();
  });

  it("returns false when deleting non-existent object", async () => {
    expect(await store.delete("nonexistent")).toBe(false);
  });

  it("looks up by source ID", async () => {
    const obj = await store.create("Source Test", "Content", {
      source: "chatgpt",
      source_id: "conv_123",
    }, schema);

    const found = store.getBySourceId("chatgpt", "conv_123");
    expect(found).toBe(obj.frontmatter.object_id);

    expect(store.getBySourceId("chatgpt", "unknown")).toBeUndefined();
  });

  describe("search", () => {
    beforeEach(async () => {
      await store.create("TypeScript Guide", "Learn TS", {
        source: "test",
        source_id: "s1",
        object_type: "Note",
        para_category: "resources",
        tags: ["coding", "typescript"],
        entities: ["TypeScript"],
      }, schema);

      await store.create("Project Alpha", "Active project", {
        source: "test",
        source_id: "s2",
        object_type: "Project",
        para_category: "projects",
        tags: ["work"],
      }, schema);

      await store.create("Meeting Notes", "Discussed topics", {
        source: "chatgpt",
        source_id: "s3",
        object_type: "Conversation",
        para_category: "inbox",
        tags: ["meeting"],
        entities: ["Express"],
      }, schema);
    });

    it("searches by text", () => {
      const results = store.search({ text: "typescript" });
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe("TypeScript Guide");
    });

    it("filters by object type", () => {
      const results = store.search({ object_type: "Project" });
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe("Project Alpha");
    });

    it("filters by para category", () => {
      const results = store.search({ para_category: "inbox" });
      expect(results.length).toBe(1);
    });

    it("filters by source", () => {
      const results = store.search({ source: "chatgpt" });
      expect(results.length).toBe(1);
    });

    it("filters by tags", () => {
      const results = store.search({ tags: ["coding"] });
      expect(results.length).toBe(1);
    });

    it("limits results", () => {
      const results = store.search({ limit: 1 });
      expect(results.length).toBe(1);
    });

    it("returns empty for no match", () => {
      const results = store.search({ text: "nonexistent" });
      expect(results.length).toBe(0);
    });
  });

  describe("getStats", () => {
    it("returns accurate statistics", async () => {
      await store.create("Note 1", "Content", { source: "test", source_id: "x1", object_type: "Note", para_category: "resources" }, schema);
      await store.create("Note 2", "Content", { source: "test", source_id: "x2", object_type: "Note", para_category: "inbox" }, schema);
      await store.create("Person 1", "Content", { source: "test", source_id: "x3", object_type: "Person", para_category: "resources" }, schema);

      const stats = store.getStats();
      expect(stats.total).toBe(3);
      expect(stats.by_type["Note"]).toBe(2);
      expect(stats.by_type["Person"]).toBe(1);
      expect(stats.by_category["resources"]).toBe(2);
      expect(stats.by_category["inbox"]).toBe(1);
    });
  });

  describe("rebuildIndex", () => {
    it("rebuilds from disk after clearing", async () => {
      await store.create("Persistent", "Data", { source: "test", source_id: "r1" }, schema);
      expect(store.size()).toBe(1);

      // Create new store pointing to same dir
      const store2 = new ObjectStore(tmpDir);
      await store2.init();
      expect(store2.size()).toBe(1);
    });
  });
});
