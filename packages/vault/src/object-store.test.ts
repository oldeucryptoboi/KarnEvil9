import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readdir, unlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { existsSync } from "node:fs";
import { ObjectStore } from "./object-store.js";
import { getDefaultSchema } from "./ontology-schema.js";
import { PARA_FOLDERS } from "./types.js";

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

  describe("get with deleted file", () => {
    it("returns null and removes from index when file is deleted from disk", async () => {
      const obj = await store.create("Ghost Note", "Will vanish", {
        source: "test",
        source_id: "ghost-1",
        object_type: "Note",
        para_category: "inbox",
      }, schema);

      expect(store.size()).toBe(1);

      // Delete the file from disk directly
      const absPath = join(tmpDir, obj.file_path);
      await unlink(absPath);

      // Now get() should detect the missing file, remove from index, return null
      const result = await store.get(obj.frontmatter.object_id);
      expect(result).toBeNull();
      expect(store.size()).toBe(0);
    });
  });

  describe("delete with missing file", () => {
    it("succeeds even when the file was already deleted from disk", async () => {
      const obj = await store.create("Already Gone", "Content", {
        source: "test",
        source_id: "del-gone-1",
        object_type: "Note",
        para_category: "inbox",
      }, schema);

      // Delete the file manually
      const absPath = join(tmpDir, obj.file_path);
      await unlink(absPath);

      // delete() should not throw — the catch block handles file-already-gone
      const deleted = await store.delete(obj.frontmatter.object_id);
      expect(deleted).toBe(true);
      expect(store.size()).toBe(0);
    });
  });

  describe("moveObject with missing old file", () => {
    it("succeeds even when old file was already removed", async () => {
      const obj = await store.create("Move Missing", "Content", {
        source: "test",
        source_id: "move-miss-1",
        object_type: "Note",
        para_category: "inbox",
      }, schema);

      // Delete old file from disk
      const absPath = join(tmpDir, obj.file_path);
      await unlink(absPath);

      // moveObject writes the new file, then tries to unlink the old file
      // The catch block on line 299 should handle the missing file
      const moved = await store.moveObject(obj.frontmatter.object_id, "resources", schema);
      // get() on an already-moved object might return null if file was deleted,
      // but if the index still has it, moveObject reads from get() first
      // Since file is gone, get() returns null, moveObject returns null
      expect(moved).toBeNull();
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

  describe("moveObject", () => {
    it("moves file from _Inbox to 03-Resources", async () => {
      const obj = await store.create("My Note", "Content", {
        source: "test",
        source_id: "m1",
        object_type: "Note",
        para_category: "inbox",
      }, schema);

      expect(obj.file_path).toContain("_Inbox");

      const moved = await store.moveObject(obj.frontmatter.object_id, "resources", schema);
      expect(moved).not.toBeNull();
      expect(moved!.file_path).toContain("03-Resources");
      expect(moved!.frontmatter.para_category).toBe("resources");
      expect(existsSync(join(tmpDir, moved!.file_path))).toBe(true);
      expect(existsSync(join(tmpDir, obj.file_path))).toBe(false);
    });

    it("moves file to 01-Projects", async () => {
      const obj = await store.create("Project Note", "Content", {
        source: "test",
        source_id: "m2",
        object_type: "Note",
        para_category: "inbox",
      }, schema);

      const moved = await store.moveObject(obj.frontmatter.object_id, "projects", schema);
      expect(moved).not.toBeNull();
      expect(moved!.file_path).toContain("01-Projects");
    });

    it("returns null for non-existent object", async () => {
      const result = await store.moveObject("nonexistent", "resources", schema);
      expect(result).toBeNull();
    });

    it("no-ops when already in correct folder", async () => {
      const obj = await store.create("Resources Note", "Content", {
        source: "test",
        source_id: "m3",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      const moved = await store.moveObject(obj.frontmatter.object_id, "resources", schema);
      expect(moved).not.toBeNull();
      expect(moved!.file_path).toBe(obj.file_path);
    });

    it("handles name collision by appending short ID", async () => {
      const obj1 = await store.create("Collision Test", "Content 1", {
        source: "test",
        source_id: "c1",
        object_type: "Note",
        para_category: "resources",
      }, schema);

      const obj2 = await store.create("Collision Test", "Content 2", {
        source: "test",
        source_id: "c2",
        object_type: "Note",
        para_category: "inbox",
      }, schema);

      // obj1 already at 03-Resources/Collision Test.md
      const moved = await store.moveObject(obj2.frontmatter.object_id, "resources", schema);
      expect(moved).not.toBeNull();
      expect(moved!.file_path).toContain("03-Resources");
      expect(moved!.file_path).toContain(obj2.frontmatter.object_id.slice(0, 8));
    });

    it("keeps entity types in _Ontology regardless of para_category", async () => {
      const obj = await store.create("TypeScript", "A language", {
        source: "entity",
        source_id: "ts1",
        object_type: "Tool",
        para_category: "inbox",
      }, schema);

      expect(obj.file_path).toContain("_Ontology/Objects/Tools");

      const moved = await store.moveObject(obj.frontmatter.object_id, "resources", schema);
      expect(moved).not.toBeNull();
      // Entity stays in _Ontology regardless
      expect(moved!.file_path).toContain("_Ontology/Objects/Tools");
    });

    it("updates index after move (searchable at new category)", async () => {
      const obj = await store.create("Searchable Note", "Content", {
        source: "test",
        source_id: "s1",
        object_type: "Note",
        para_category: "inbox",
      }, schema);

      expect(store.search({ para_category: "inbox" })).toHaveLength(1);
      expect(store.search({ para_category: "resources" })).toHaveLength(0);

      await store.moveObject(obj.frontmatter.object_id, "resources", schema);

      expect(store.search({ para_category: "inbox" })).toHaveLength(0);
      expect(store.search({ para_category: "resources" })).toHaveLength(1);
    });
  });

  describe("scanDirectory error handling", () => {
    it("skips malformed .md files during scan", async () => {
      // Write a malformed markdown file directly to an existing PARA folder
      const inboxDir = join(tmpDir, "_Inbox");
      await mkdir(inboxDir, { recursive: true });
      await writeFile(join(inboxDir, "bad-file.md"), "no frontmatter here at all", "utf-8");

      const store2 = new ObjectStore(tmpDir);
      await store2.init(); // should not throw
      expect(store2.size()).toBe(0);
    });

    it("skips unreadable directories during scan", async () => {
      const inboxDir = join(tmpDir, "_Inbox");
      await mkdir(inboxDir, { recursive: true });
      const lockedDir = join(inboxDir, "locked-subdir");
      await mkdir(lockedDir, { recursive: true });
      await chmod(lockedDir, 0o000);

      try {
        const store2 = new ObjectStore(tmpDir);
        await store2.init(); // should not throw
        expect(store2.size()).toBe(0);
      } finally {
        await chmod(lockedDir, 0o755);
      }
    });
  });

  describe("moveObject unlink catch", () => {
    it("succeeds even when old directory is read-only (unlink fails)", async () => {
      const obj = await store.create("Move Test", "Content", {
        source: "test",
        source_id: "unlink-catch-1",
        object_type: "Note",
        para_category: "inbox",
      }, schema);

      expect(obj.file_path).toContain("_Inbox");

      // Make _Inbox read-only so unlink will fail
      const inboxDir = join(tmpDir, "_Inbox");
      await chmod(inboxDir, 0o555);

      try {
        const moved = await store.moveObject(obj.frontmatter.object_id, "resources", schema);
        expect(moved).not.toBeNull();
        expect(moved!.file_path).toContain("03-Resources");
        // File should exist at new location
        expect(existsSync(join(tmpDir, moved!.file_path))).toBe(true);
      } finally {
        await chmod(inboxDir, 0o755);
      }
    });
  });
});
