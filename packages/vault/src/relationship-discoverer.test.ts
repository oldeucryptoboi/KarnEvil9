import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { RelationshipDiscoverer } from "./relationship-discoverer.js";
import { VectorStore } from "./vector-store.js";
import { OPTICSClusterer } from "./clusterer.js";
import { ObjectStore } from "./object-store.js";
import { LinkStore } from "./link-store.js";
import { getDefaultSchema } from "./ontology-schema.js";
import type { EmbedderFn, ClassifierFn } from "./types.js";

function mockEmbedder(dim: number = 4): EmbedderFn {
  return async (texts: string[]) => {
    return texts.map((text) => {
      const vec = new Array(dim).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % dim] += text.charCodeAt(i) / 1000;
      }
      const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
      return norm > 0 ? vec.map((v: number) => v / norm) : vec;
    });
  };
}

function mockClassifier(): ClassifierFn {
  return async (_title, _content, _types) => ({
    object_type: "Concept",
    para_category: "resources",
    tags: [],
    entities: [{ name: "related", type: "Concept", link_type: "discusses" }],
    confidence: 0.8,
  });
}

describe("RelationshipDiscoverer", () => {
  let tmpDir: string;
  let objectStore: ObjectStore;
  let linkStore: LinkStore;
  let vectorStore: VectorStore;
  let clusterer: OPTICSClusterer;
  const schema = getDefaultSchema();

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-rel-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "_Ontology", "Links"), { recursive: true });

    objectStore = new ObjectStore(tmpDir);
    await objectStore.init();

    linkStore = new LinkStore(join(tmpDir, "_Ontology", "Links", "links.jsonl"));
    await linkStore.init();

    vectorStore = new VectorStore(
      join(tmpDir, "_Ontology", "Links", "embeddings.jsonl"),
      mockEmbedder(4),
    );
    await vectorStore.init();

    clusterer = new OPTICSClusterer({ minPts: 3 });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers relationships between similar objects", async () => {
    // Create objects with similar content
    await objectStore.create("TypeScript Guide", "TypeScript is great for web development", {
      source: "test", source_id: "ts-1",
    }, schema);
    await objectStore.create("TypeScript Tutorial", "Learn TypeScript for web development", {
      source: "test", source_id: "ts-2",
    }, schema);
    await objectStore.create("TypeScript Handbook", "TypeScript handbook for web developers", {
      source: "test", source_id: "ts-3",
    }, schema);
    // Dissimilar object
    await objectStore.create("Cooking Recipes", "Italian pasta recipes with tomato sauce", {
      source: "test", source_id: "cook-1",
    }, schema);

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
    });

    const { result } = await discoverer.discover({ cosine_threshold: 0.5 });
    expect(result.embeddings_created).toBe(4);
    expect(result.relationships_discovered).toBeGreaterThanOrEqual(0);
    expect(result.links_created).toBe(result.relationships_discovered);
  });

  it("does not create duplicate links", async () => {
    const obj1 = await objectStore.create("Doc A", "Content A", {
      source: "test", source_id: "a",
    }, schema);
    const obj2 = await objectStore.create("Doc B", "Content B", {
      source: "test", source_id: "b",
    }, schema);

    // Pre-create a link
    await linkStore.addLink({
      source_id: obj1.frontmatter.object_id,
      target_id: obj2.frontmatter.object_id,
      link_type: "related_to",
      confidence: 0.9,
    });

    // Set embeddings manually to ensure high similarity
    vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
    vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.1, 0, 0]));

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
    });

    const { result } = await discoverer.discover({ cosine_threshold: 0.5 });
    // The existing link should be deduped
    expect(result.links_created).toBe(0);
  });

  it("deduplicates links in reverse direction (target→source already exists)", async () => {
    const obj1 = await objectStore.create("Doc P", "Content P", {
      source: "test", source_id: "p",
    }, schema);
    const obj2 = await objectStore.create("Doc Q", "Content Q", {
      source: "test", source_id: "q",
    }, schema);

    // Pre-create a link in REVERSE direction: obj2 → obj1
    await linkStore.addLink({
      source_id: obj2.frontmatter.object_id,
      target_id: obj1.frontmatter.object_id,
      link_type: "related_to",
      confidence: 0.9,
    });

    // Set embeddings so they are highly similar (pair will be obj1→obj2 based on iteration order)
    vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
    vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.1, 0, 0]));

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
    });

    const { result } = await discoverer.discover({ cosine_threshold: 0.5 });
    // The reverse-direction existing link should be detected as a duplicate
    expect(result.links_created).toBe(0);
  });

  it("uses classifier for relationship labeling when available", async () => {
    const obj1 = await objectStore.create("Doc X", "Topic X", {
      source: "test", source_id: "x",
    }, schema);
    const obj2 = await objectStore.create("Doc Y", "Topic X related", {
      source: "test", source_id: "y",
    }, schema);

    // Set very similar embeddings
    vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
    vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
      classifier: mockClassifier(),
    });

    const { result } = await discoverer.discover({ cosine_threshold: 0.9 });
    expect(result.links_created).toBeGreaterThanOrEqual(1);

    // Check that the link was labeled by the classifier
    const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
    if (links.length > 0) {
      expect(links[0]!.link_type).toBe("discusses");
    }
  });

  it("works without classifier (label_via_llm=false) — uses heuristic labels", async () => {
    const obj1 = await objectStore.create("A", "Same", { source: "test", source_id: "1" }, schema);
    const obj2 = await objectStore.create("B", "Same", { source: "test", source_id: "2" }, schema);

    vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
    vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
    });

    const { result } = await discoverer.discover({ cosine_threshold: 0.9, label_via_llm: false });
    if (result.links_created > 0) {
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      // Default object_type is "Note", two Notes with no special metadata → "related_to"
      expect(links[0]!.link_type).toBe("related_to");
    }
  });

  it("emits vault.relationships_discovered event", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const emitEvent = async (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    };

    await objectStore.create("A", "Content", { source: "test", source_id: "1" }, schema);

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
      emitEvent: emitEvent as any,
    });

    await discoverer.discover();
    expect(events.some((e) => e.type === "vault.relationships_discovered")).toBe(true);
  });

  it("returns cluster information", async () => {
    // Create enough similar objects for clustering
    for (let i = 0; i < 5; i++) {
      const obj = await objectStore.create(`Doc ${i}`, `TypeScript content ${i}`, {
        source: "test", source_id: `cluster-${i}`,
      }, schema);
      // All very similar vectors
      vectorStore.setEmbedding(obj.frontmatter.object_id, new Float32Array([1, 0.01 * i, 0, 0]));
    }

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer: new OPTICSClusterer({ minPts: 3, epsilon: 0.5 }),
      objectStore,
      linkStore,
    });

    const { clusters } = await discoverer.discover();
    expect(Array.isArray(clusters)).toBe(true);
  });

  it("handles empty vault gracefully", async () => {
    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
    });

    const { result } = await discoverer.discover();
    expect(result.embeddings_created).toBe(0);
    expect(result.clusters_found).toBe(0);
    expect(result.relationships_discovered).toBe(0);
    expect(result.links_created).toBe(0);
  });

  it("labels relationships in batches when label_batch_size is set", async () => {
    // Create 4 objects with similar embeddings to produce multiple pairs
    const objs = [];
    for (let i = 0; i < 4; i++) {
      const obj = await objectStore.create(`Batch Doc ${i}`, `Batch content ${i}`, {
        source: "test", source_id: `batch-${i}`,
      }, schema);
      objs.push(obj);
      vectorStore.setEmbedding(obj.frontmatter.object_id, new Float32Array([1, 0.01 * i, 0, 0]));
    }

    let classifierCallCount = 0;
    const batchClassifier: ClassifierFn = async (_title, _content, _types) => {
      classifierCallCount++;
      // Return entities for multiple pairs
      return {
        object_type: "Concept",
        para_category: "resources",
        tags: [],
        entities: [
          { name: "r1", type: "Concept", link_type: "discusses" },
          { name: "r2", type: "Concept", link_type: "uses" },
          { name: "r3", type: "Concept", link_type: "mentions" },
          { name: "r4", type: "Concept", link_type: "depends_on" },
          { name: "r5", type: "Concept", link_type: "related_to" },
          { name: "r6", type: "Concept", link_type: "part_of" },
        ],
        confidence: 0.8,
      };
    };

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
      classifier: batchClassifier,
    });

    const { result } = await discoverer.discover({
      cosine_threshold: 0.9,
      label_batch_size: 3,
    });

    // Should have created links
    expect(result.links_created).toBeGreaterThanOrEqual(1);
    // With batch size 3, should make fewer calls than # of pairs
    if (result.links_created > 3) {
      expect(classifierCallCount).toBeLessThan(result.links_created);
    }
  });

  it("falls back to related_to when batch classifier returns partial results", async () => {
    const obj1 = await objectStore.create("Partial A", "Content A", { source: "test", source_id: "pa" }, schema);
    const obj2 = await objectStore.create("Partial B", "Content B", { source: "test", source_id: "pb" }, schema);

    vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
    vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

    // Return empty entities — should fall back to "related_to"
    const partialClassifier: ClassifierFn = async () => ({
      object_type: "Concept",
      para_category: "resources",
      tags: [],
      entities: [],
      confidence: 0.5,
    });

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
      classifier: partialClassifier,
    });

    const { result } = await discoverer.discover({ cosine_threshold: 0.9, label_batch_size: 5 });
    if (result.links_created > 0) {
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      expect(links[0]!.link_type).toBe("related_to");
    }
  });

  describe("heuristic labeling", () => {
    it("labels Conversation → Conversation as preceded_by", async () => {
      const obj1 = await objectStore.create("Chat Jan 1", "We discussed the project timeline", {
        source: "test", source_id: "conv-1", object_type: "Conversation",
      }, schema);
      const obj2 = await objectStore.create("Chat Jan 2", "Follow-up on the project timeline", {
        source: "test", source_id: "conv-2", object_type: "Conversation",
      }, schema);

      vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
      vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

      const discoverer = new RelationshipDiscoverer({
        vectorStore, clusterer, objectStore, linkStore,
      });

      const { result } = await discoverer.discover({ cosine_threshold: 0.9, label_via_llm: false });
      expect(result.links_created).toBeGreaterThanOrEqual(1);
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      expect(links[0]!.link_type).toBe("preceded_by");
    });

    it("labels Project → Tool as uses", async () => {
      const obj1 = await objectStore.create("My App", "A web application project", {
        source: "test", source_id: "proj-1", object_type: "Project",
      }, schema);
      const obj2 = await objectStore.create("React", "A JavaScript UI library", {
        source: "test", source_id: "tool-1", object_type: "Tool",
      }, schema);

      vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
      vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

      const discoverer = new RelationshipDiscoverer({
        vectorStore, clusterer, objectStore, linkStore,
      });

      const { result } = await discoverer.discover({ cosine_threshold: 0.9, label_via_llm: false });
      expect(result.links_created).toBeGreaterThanOrEqual(1);
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      expect(links[0]!.link_type).toBe("uses");
    });

    it("labels Note → Concept as discusses", async () => {
      const obj1 = await objectStore.create("My Notes", "Notes about machine learning", {
        source: "test", source_id: "note-1", object_type: "Note",
      }, schema);
      const obj2 = await objectStore.create("Machine Learning", "ML is a subset of AI", {
        source: "test", source_id: "concept-1", object_type: "Concept",
      }, schema);

      vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
      vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

      const discoverer = new RelationshipDiscoverer({
        vectorStore, clusterer, objectStore, linkStore,
      });

      const { result } = await discoverer.discover({ cosine_threshold: 0.9, label_via_llm: false });
      expect(result.links_created).toBeGreaterThanOrEqual(1);
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      expect(links[0]!.link_type).toBe("discusses");
    });

    it("labels cross-entity mention as mentions", async () => {
      const obj1 = await objectStore.create("Meeting Notes", "Discussed various topics", {
        source: "test", source_id: "ent-1", object_type: "Document",
        entities: ["Alice"],
      }, schema);
      const obj2 = await objectStore.create("Alice", "Alice is a team member", {
        source: "test", source_id: "ent-2", object_type: "Document",
      }, schema);

      vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
      vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

      const discoverer = new RelationshipDiscoverer({
        vectorStore, clusterer, objectStore, linkStore,
      });

      const { result } = await discoverer.discover({ cosine_threshold: 0.9, label_via_llm: false });
      expect(result.links_created).toBeGreaterThanOrEqual(1);
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      expect(links[0]!.link_type).toBe("mentions");
    });

    it("falls back to related_to for unknown type combinations", async () => {
      const obj1 = await objectStore.create("Doc Alpha", "Some generic content here", {
        source: "test", source_id: "gen-1", object_type: "Document",
      }, schema);
      const obj2 = await objectStore.create("Doc Beta", "Some other generic content", {
        source: "test", source_id: "gen-2", object_type: "Document",
      }, schema);

      vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
      vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

      const discoverer = new RelationshipDiscoverer({
        vectorStore, clusterer, objectStore, linkStore,
      });

      const { result } = await discoverer.discover({ cosine_threshold: 0.9, label_via_llm: false });
      expect(result.links_created).toBeGreaterThanOrEqual(1);
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      expect(links[0]!.link_type).toBe("related_to");
    });

    it("uses heuristic fallback when label_via_llm=true but no classifier provided", async () => {
      const obj1 = await objectStore.create("Chat A", "Conversation about deployment", {
        source: "test", source_id: "fb-1", object_type: "Conversation",
      }, schema);
      const obj2 = await objectStore.create("Chat B", "Conversation about deployment follow-up", {
        source: "test", source_id: "fb-2", object_type: "Conversation",
      }, schema);

      vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
      vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

      const discoverer = new RelationshipDiscoverer({
        vectorStore, clusterer, objectStore, linkStore,
        // No classifier provided
      });

      const { result } = await discoverer.discover({ cosine_threshold: 0.9, label_via_llm: true });
      expect(result.links_created).toBeGreaterThanOrEqual(1);
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      // Should use heuristic (preceded_by for Conversation→Conversation), not default "related_to"
      expect(links[0]!.link_type).toBe("preceded_by");
    });
  });

  it("respects max_candidates limit", async () => {
    for (let i = 0; i < 10; i++) {
      await objectStore.create(`Doc ${i}`, `Content ${i}`, {
        source: "test", source_id: `max-${i}`,
      }, schema);
    }

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
    });

    const { result } = await discoverer.discover({ max_candidates: 5 });
    // Should only embed up to 5 objects
    expect(result.embeddings_created).toBeLessThanOrEqual(5);
  });

  it("gracefully handles classifier errors", async () => {
    const obj1 = await objectStore.create("A", "Content", { source: "test", source_id: "1" }, schema);
    const obj2 = await objectStore.create("B", "Content", { source: "test", source_id: "2" }, schema);

    vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0, 0, 0]));
    vectorStore.setEmbedding(obj2.frontmatter.object_id, new Float32Array([0.99, 0.05, 0, 0]));

    const failingClassifier: ClassifierFn = async () => {
      throw new Error("API error");
    };

    const discoverer = new RelationshipDiscoverer({
      vectorStore,
      clusterer,
      objectStore,
      linkStore,
      classifier: failingClassifier,
    });

    // Should not throw — falls back to "related_to"
    const { result } = await discoverer.discover({ cosine_threshold: 0.9 });
    if (result.links_created > 0) {
      const links = linkStore.getLinksForObject(obj1.frontmatter.object_id);
      expect(links[0]!.link_type).toBe("related_to");
    }
  });
});
