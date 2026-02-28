import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { VectorStore, cosineSimilarity } from "./vector-store.js";
import type { EmbedderFn } from "./types.js";

function mockEmbedder(dim: number = 4): EmbedderFn {
  return async (texts: string[]) => {
    return texts.map((text) => {
      // Deterministic mock: hash text to produce consistent vectors
      const vec = new Array(dim).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % dim] += text.charCodeAt(i) / 1000;
      }
      // Normalize
      const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
      return norm > 0 ? vec.map((v: number) => v / norm) : vec;
    });
  };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("handles equal magnitude vectors", () => {
    const a = new Float32Array([1, 1]);
    const b = new Float32Array([1, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("throws for different dimensions", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow("same dimensionality");
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe("VectorStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-vector-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
    filePath = join(tmpDir, "embeddings.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts empty", async () => {
    const store = new VectorStore(filePath);
    await store.init();
    expect(store.size()).toBe(0);
  });

  it("persists and loads embeddings", async () => {
    const store = new VectorStore(filePath);
    await store.init();
    store.setEmbedding("obj-1", new Float32Array([1, 2, 3]));
    store.setEmbedding("obj-2", new Float32Array([4, 5, 6]));
    await store.save();

    const store2 = new VectorStore(filePath);
    await store2.init();
    expect(store2.size()).toBe(2);
    expect(store2.hasEmbedding("obj-1")).toBe(true);

    const vec = store2.getEmbedding("obj-1")!;
    expect(vec[0]).toBeCloseTo(1, 3);
    expect(vec[1]).toBeCloseTo(2, 3);
    expect(vec[2]).toBeCloseTo(3, 3);
  });

  it("embeds objects via embedder function", async () => {
    const embedder = mockEmbedder(4);
    const store = new VectorStore(filePath, embedder);
    await store.init();

    const count = await store.embed(
      ["a", "b", "c"],
      async (id) => `Content for ${id}`,
    );
    expect(count).toBe(3);
    expect(store.size()).toBe(3);
    expect(store.hasEmbedding("a")).toBe(true);
  });

  it("skips already-embedded objects", async () => {
    const embedder = mockEmbedder(4);
    const store = new VectorStore(filePath, embedder);
    await store.init();

    await store.embed(["a", "b"], async (id) => `Content for ${id}`);
    const count = await store.embed(["a", "b", "c"], async (id) => `Content for ${id}`);
    expect(count).toBe(1); // only "c" is new
    expect(store.size()).toBe(3);
  });

  it("throws when embedding without an embedder", async () => {
    const store = new VectorStore(filePath);
    await store.init();
    await expect(store.embed(["a"], async () => "text")).rejects.toThrow("No embedder configured");
  });

  it("skips objects with null content", async () => {
    const embedder = mockEmbedder(4);
    const store = new VectorStore(filePath, embedder);
    await store.init();

    const count = await store.embed(
      ["a", "b"],
      async (id) => id === "a" ? "some content" : null,
    );
    expect(count).toBe(1);
    expect(store.hasEmbedding("a")).toBe(true);
    expect(store.hasEmbedding("b")).toBe(false);
  });

  it("searches by cosine similarity", async () => {
    const store = new VectorStore(filePath);
    await store.init();

    store.setEmbedding("close", new Float32Array([1, 0, 0]));
    store.setEmbedding("medium", new Float32Array([0.7, 0.7, 0]));
    store.setEmbedding("far", new Float32Array([0, 0, 1]));

    const query = new Float32Array([1, 0, 0]);
    const results = store.search(query, 3);
    expect(results[0]!.id).toBe("close");
    expect(results[0]!.score).toBeCloseTo(1, 3);
    expect(results[2]!.id).toBe("far");
  });

  it("limits search results to k", () => {
    const store = new VectorStore(filePath);
    store.setEmbedding("a", new Float32Array([1, 0]));
    store.setEmbedding("b", new Float32Array([0, 1]));
    store.setEmbedding("c", new Float32Array([0.5, 0.5]));

    const results = store.search(new Float32Array([1, 0]), 2);
    expect(results.length).toBe(2);
  });

  it("finds similar pairs above threshold", () => {
    const store = new VectorStore(filePath);

    // Two near-identical vectors and one different
    store.setEmbedding("a", new Float32Array([1, 0, 0]));
    store.setEmbedding("b", new Float32Array([0.99, 0.1, 0]));
    store.setEmbedding("c", new Float32Array([0, 0, 1]));

    const pairs = store.findSimilarPairs(0.9);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.id_a).toBe("a");
    expect(pairs[0]!.id_b).toBe("b");
    expect(pairs[0]!.score).toBeGreaterThan(0.9);
  });

  it("returns empty pairs when nothing above threshold", () => {
    const store = new VectorStore(filePath);
    store.setEmbedding("a", new Float32Array([1, 0, 0]));
    store.setEmbedding("b", new Float32Array([0, 1, 0]));

    const pairs = store.findSimilarPairs(0.99);
    expect(pairs.length).toBe(0);
  });

  it("removes embeddings", () => {
    const store = new VectorStore(filePath);
    store.setEmbedding("a", new Float32Array([1, 0]));
    expect(store.hasEmbedding("a")).toBe(true);
    expect(store.removeEmbedding("a")).toBe(true);
    expect(store.hasEmbedding("a")).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("skips malformed JSONL lines during init", async () => {
    const malformedPath = join(tmpDir, "malformed-embeddings.jsonl");
    const validLine = JSON.stringify({ id: "good-1", vector: [1, 2, 3] });
    const content = `${validLine}\n{broken json\nnot json at all\n${JSON.stringify({ id: "good-2", vector: [4, 5, 6] })}\n`;
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(malformedPath, content, "utf-8");

    const store = new VectorStore(malformedPath);
    await store.init();
    expect(store.size()).toBe(2);
    expect(store.hasEmbedding("good-1")).toBe(true);
    expect(store.hasEmbedding("good-2")).toBe(true);
  });

  it("returns the internal vectors map via getVectors", () => {
    const store = new VectorStore(filePath);
    store.setEmbedding("a", new Float32Array([1, 2]));
    store.setEmbedding("b", new Float32Array([3, 4]));

    const vectors = store.getVectors();
    expect(vectors).toBeInstanceOf(Map);
    expect(vectors.size).toBe(2);
    expect(vectors.has("a")).toBe(true);
    expect(vectors.has("b")).toBe(true);
    expect(vectors.get("a")![0]).toBeCloseTo(1, 3);
  });

  it("returns all IDs", () => {
    const store = new VectorStore(filePath);
    store.setEmbedding("x", new Float32Array([1]));
    store.setEmbedding("y", new Float32Array([2]));
    const ids = store.allIds();
    expect(ids).toContain("x");
    expect(ids).toContain("y");
    expect(ids.length).toBe(2);
  });
});
