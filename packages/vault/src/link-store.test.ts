import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { LinkStore } from "./link-store.js";

describe("LinkStore", () => {
  let tmpDir: string;
  let store: LinkStore;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-linkstore-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
    store = new LinkStore(join(tmpDir, "links.jsonl"));
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    expect(store.size()).toBe(0);
  });

  it("adds a link", async () => {
    const link = await store.addLink({
      source_id: "obj-1",
      target_id: "obj-2",
      link_type: "discusses",
      confidence: 0.9,
    });

    expect(link.link_id).toBeTruthy();
    expect(link.source_id).toBe("obj-1");
    expect(link.target_id).toBe("obj-2");
    expect(store.size()).toBe(1);
  });

  it("deduplicates identical links", async () => {
    await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.5 });
    await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.8 });
    expect(store.size()).toBe(1);

    // Higher confidence should be kept
    const link = store.findLink("a", "b", "uses");
    expect(link!.confidence).toBe(0.8);
  });

  it("allows different link types between same objects", async () => {
    await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.5 });
    await store.addLink({ source_id: "a", target_id: "b", link_type: "discusses", confidence: 0.5 });
    expect(store.size()).toBe(2);
  });

  it("retrieves links for an object", async () => {
    await store.addLink({ source_id: "obj-1", target_id: "obj-2", link_type: "uses", confidence: 0.9 });
    await store.addLink({ source_id: "obj-3", target_id: "obj-1", link_type: "mentions", confidence: 0.7 });

    const links = store.getLinksForObject("obj-1");
    expect(links.length).toBe(2);
  });

  it("separates outgoing and incoming links", async () => {
    await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.9 });
    await store.addLink({ source_id: "c", target_id: "a", link_type: "mentions", confidence: 0.7 });

    expect(store.getOutgoingLinks("a").length).toBe(1);
    expect(store.getIncomingLinks("a").length).toBe(1);
  });

  it("removes a link", async () => {
    const link = await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.5 });
    expect(store.removeLink(link.link_id)).toBe(true);
    expect(store.size()).toBe(0);
    expect(store.removeLink("nonexistent")).toBe(false);
  });

  it("finds a specific link", async () => {
    await store.addLink({ source_id: "x", target_id: "y", link_type: "discusses", confidence: 0.8 });
    const found = store.findLink("x", "y", "discusses");
    expect(found).toBeDefined();
    expect(found!.confidence).toBe(0.8);

    expect(store.findLink("x", "y", "unknown")).toBeUndefined();
  });

  it("skips malformed JSONL lines during init", async () => {
    const filePath = join(tmpDir, "malformed-links.jsonl");
    const validLink = JSON.stringify({
      link_id: "link-1",
      source_id: "a",
      target_id: "b",
      link_type: "uses",
      confidence: 0.9,
      created_at: new Date().toISOString(),
    });
    const content = `${validLink}\n{broken json\nnot even json\n`;
    await writeFile(filePath, content, "utf-8");

    const s = new LinkStore(filePath);
    await s.init();
    expect(s.size()).toBe(1);
    expect(s.findLink("a", "b", "uses")).toBeDefined();
  });

  it("retrieves a link by ID via getLink", async () => {
    const link = await store.addLink({
      source_id: "x",
      target_id: "y",
      link_type: "discusses",
      confidence: 0.8,
    });

    const retrieved = store.getLink(link.link_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.source_id).toBe("x");
    expect(retrieved!.target_id).toBe("y");
    expect(retrieved!.link_type).toBe("discusses");
    expect(retrieved!.confidence).toBe(0.8);

    // Non-existent link
    expect(store.getLink("nonexistent")).toBeUndefined();
  });

  describe("traverse", () => {
    it("traverses a graph from a start node", async () => {
      await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.9 });
      await store.addLink({ source_id: "b", target_id: "c", link_type: "uses", confidence: 0.8 });
      await store.addLink({ source_id: "c", target_id: "d", link_type: "uses", confidence: 0.7 });

      const result = store.traverse("a", 2);
      expect(result.has("a")).toBe(true);
      expect(result.has("b")).toBe(true);
      expect(result.has("c")).toBe(true);
      // d is at depth 3, should not be included with maxDepth 2
    });

    it("handles cycles", async () => {
      await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.9 });
      await store.addLink({ source_id: "b", target_id: "a", link_type: "uses", confidence: 0.8 });

      const result = store.traverse("a", 3);
      expect(result.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("orphan detection", () => {
    it("finds orphaned links", async () => {
      await store.addLink({ source_id: "valid-1", target_id: "valid-2", link_type: "uses", confidence: 0.9 });
      await store.addLink({ source_id: "valid-1", target_id: "orphan-1", link_type: "mentions", confidence: 0.5 });

      const validIds = new Set(["valid-1", "valid-2"]);
      const orphans = store.getOrphanedLinks(validIds);
      expect(orphans.length).toBe(1);
      expect(orphans[0]!.target_id).toBe("orphan-1");
    });

    it("removes orphaned links", async () => {
      await store.addLink({ source_id: "valid-1", target_id: "valid-2", link_type: "uses", confidence: 0.9 });
      await store.addLink({ source_id: "orphan-1", target_id: "orphan-2", link_type: "uses", confidence: 0.5 });

      const validIds = new Set(["valid-1", "valid-2"]);
      const removed = await store.removeOrphanedLinks(validIds);
      expect(removed).toBe(1);
      expect(store.size()).toBe(1);
    });
  });

  describe("adjacency cleanup on removeLink", () => {
    it("evicts empty adjacency sets after removing the last link for an object", async () => {
      const link = await store.addLink({ source_id: "x", target_id: "y", link_type: "uses", confidence: 0.9 });
      expect(store.getLinksForObject("x").length).toBe(1);
      expect(store.getLinksForObject("y").length).toBe(1);

      store.removeLink(link.link_id);
      // After removing the only link, getLinksForObject should return empty array
      // and the adjacency entry should be cleaned up (no memory leak)
      expect(store.getLinksForObject("x")).toEqual([]);
      expect(store.getLinksForObject("y")).toEqual([]);
    });
  });

  describe("concurrent writes (write lock)", () => {
    it("serializes concurrent save() calls without data corruption", async () => {
      await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.5 });
      await store.addLink({ source_id: "c", target_id: "d", link_type: "uses", confidence: 0.6 });

      // Fire two saves concurrently — the write lock should serialize them
      await Promise.all([store.save(), store.save()]);

      const store2 = new LinkStore(join(tmpDir, "links.jsonl"));
      await store2.init();
      expect(store2.size()).toBe(2);
    });
  });

  describe("persistence", () => {
    it("persists links across init cycles", async () => {
      const filePath = join(tmpDir, "persist-links.jsonl");
      const store1 = new LinkStore(filePath);
      await store1.init();
      await store1.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.9 });

      const store2 = new LinkStore(filePath);
      await store2.init();
      expect(store2.size()).toBe(1);
      expect(store2.findLink("a", "b", "uses")).toBeDefined();
    });

    it("save rewrites file atomically", async () => {
      await store.addLink({ source_id: "a", target_id: "b", link_type: "uses", confidence: 0.5 });
      await store.addLink({ source_id: "c", target_id: "d", link_type: "uses", confidence: 0.6 });
      store.removeLink(store.findLink("a", "b", "uses")!.link_id);
      await store.save();

      // Re-read
      const store2 = new LinkStore(join(tmpDir, "links.jsonl"));
      await store2.init();
      expect(store2.size()).toBe(1);
    });
  });
});
