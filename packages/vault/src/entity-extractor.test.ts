import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { EntityExtractor } from "./entity-extractor.js";
import { ObjectStore } from "./object-store.js";
import { LinkStore } from "./link-store.js";
import { Deduplicator } from "./deduplicator.js";
import { getDefaultSchema } from "./ontology-schema.js";
import type { ClassificationResult } from "./types.js";

describe("EntityExtractor", () => {
  let tmpDir: string;
  let objectStore: ObjectStore;
  let linkStore: LinkStore;
  let deduplicator: Deduplicator;
  let extractor: EntityExtractor;
  const schema = getDefaultSchema();

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-entity-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });

    objectStore = new ObjectStore(tmpDir);
    await objectStore.init();

    linkStore = new LinkStore(join(tmpDir, "links.jsonl"));
    await linkStore.init();

    deduplicator = new Deduplicator(join(tmpDir, "aliases.yaml"));
    await deduplicator.init();

    extractor = new EntityExtractor(objectStore, linkStore, deduplicator, schema);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts entities and creates objects + links", async () => {
    // Create source object
    const source = await objectStore.create("Test Conversation", "Discussing TypeScript", {
      source: "test",
      source_id: "conv-1",
      object_type: "Conversation",
    }, schema);

    const classification: ClassificationResult = {
      object_type: "Conversation",
      para_category: "resources",
      tags: ["coding"],
      entities: [
        { name: "TypeScript", type: "Tool", link_type: "discusses" },
        { name: "Express", type: "Tool", link_type: "uses" },
      ],
      confidence: 0.9,
    };

    const result = await extractor.extractAndLink(source.frontmatter.object_id, classification);

    expect(result.entities.length).toBe(2);
    expect(result.entities[0]!.canonical_name).toBe("typescript");
    expect(result.entities[0]!.is_new).toBe(true);
    expect(result.entities[1]!.canonical_name).toBe("express");
    expect(result.entities[1]!.is_new).toBe(true);

    expect(result.links_created.length).toBe(2);
    expect(result.links_created[0]!.link_type).toBe("discusses");
    expect(result.links_created[1]!.link_type).toBe("uses");

    // Entity objects should be created in store
    expect(objectStore.size()).toBe(3); // source + 2 entities
  });

  it("deduplicates known entities", async () => {
    // Pre-create entity
    await objectStore.create("typescript", "A programming language", {
      source: "entity",
      source_id: "typescript",
      object_type: "Tool",
    }, schema);

    const source = await objectStore.create("Discussion", "About TS", {
      source: "test",
      source_id: "conv-2",
    }, schema);

    const classification: ClassificationResult = {
      object_type: "Conversation",
      para_category: "resources",
      tags: [],
      entities: [
        { name: "TypeScript", type: "Tool", link_type: "discusses" },
      ],
      confidence: 0.8,
    };

    const result = await extractor.extractAndLink(source.frontmatter.object_id, classification);

    expect(result.entities[0]!.is_new).toBe(false);
    expect(result.links_created.length).toBe(1);
    // Should not create a duplicate entity
    expect(objectStore.size()).toBe(2); // source + pre-existing entity
  });

  it("registers aliases for deduplication", async () => {
    const source = await objectStore.create("Chat", "Content", {
      source: "test",
      source_id: "conv-3",
    }, schema);

    const classification: ClassificationResult = {
      object_type: "Conversation",
      para_category: "inbox",
      tags: [],
      entities: [
        { name: "React.js", type: "Tool", link_type: "discusses" },
      ],
      confidence: 0.7,
    };

    await extractor.extractAndLink(source.frontmatter.object_id, classification);

    // "react.js" should now resolve to "react.js" (itself, as canonical)
    const canonical = deduplicator.resolve("React.js");
    expect(canonical).toBe("react.js");
  });

  it("handles empty entity list", async () => {
    const source = await objectStore.create("Empty", "No entities", {
      source: "test",
      source_id: "conv-4",
    }, schema);

    const classification: ClassificationResult = {
      object_type: "Note",
      para_category: "inbox",
      tags: [],
      entities: [],
      confidence: 0.5,
    };

    const result = await extractor.extractAndLink(source.frontmatter.object_id, classification);
    expect(result.entities.length).toBe(0);
    expect(result.links_created.length).toBe(0);
  });
});
