import { readFile, rename, mkdir, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbedderFn } from "./types.js";

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("Vectors must have same dimensionality");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface SimilarPair {
  id_a: string;
  id_b: string;
  score: number;
}

export class VectorStore {
  private vectors: Map<string, Float32Array> = new Map();
  private filePath: string;
  private embedder: EmbedderFn | null;

  constructor(filePath: string, embedder?: EmbedderFn) {
    this.filePath = filePath;
    this.embedder = embedder ?? null;
  }

  async init(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const raw = await readFile(this.filePath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as { id: string; vector: number[] };
        this.vectors.set(record.id, new Float32Array(record.vector));
      } catch {
        // skip malformed lines
      }
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const lines: string[] = [];
    for (const [id, vec] of this.vectors) {
      lines.push(JSON.stringify({ id, vector: Array.from(vec) }));
    }
    const tmpPath = this.filePath + ".tmp";
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(lines.join("\n") + "\n", "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }

  async embed(
    objectIds: string[],
    contentProvider: (id: string) => Promise<string | null>,
  ): Promise<number> {
    if (!this.embedder) throw new Error("No embedder configured");

    const BATCH_SIZE = 100;
    let created = 0;

    // Collect texts for unembedded objects
    const toEmbed: Array<{ id: string; text: string }> = [];
    for (const id of objectIds) {
      if (this.vectors.has(id)) continue;
      const text = await contentProvider(id);
      if (text) toEmbed.push({ id, text });
    }

    // Batch embed
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE);
      const texts = batch.map((b) => b.text);
      const vectors = await this.embedder(texts);
      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (vec) {
          this.vectors.set(batch[j]!.id, new Float32Array(vec));
          created++;
        }
      }
    }

    return created;
  }

  search(queryVector: Float32Array, k: number = 10): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];
    for (const [id, vec] of this.vectors) {
      const score = cosineSimilarity(queryVector, vec);
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  findSimilarPairs(threshold: number = 0.85): SimilarPair[] {
    const ids = Array.from(this.vectors.keys());
    const pairs: SimilarPair[] = [];

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const vecA = this.vectors.get(ids[i]!);
        const vecB = this.vectors.get(ids[j]!);
        if (!vecA || !vecB) continue;
        const score = cosineSimilarity(vecA, vecB);
        if (score >= threshold) {
          pairs.push({ id_a: ids[i]!, id_b: ids[j]!, score });
        }
      }
    }

    pairs.sort((a, b) => b.score - a.score);
    return pairs;
  }

  size(): number {
    return this.vectors.size;
  }

  getEmbedder(): EmbedderFn | null {
    return this.embedder;
  }

  hasEmbedding(objectId: string): boolean {
    return this.vectors.has(objectId);
  }

  getEmbedding(objectId: string): Float32Array | undefined {
    return this.vectors.get(objectId);
  }

  removeEmbedding(objectId: string): boolean {
    return this.vectors.delete(objectId);
  }

  setEmbedding(objectId: string, vector: Float32Array): void {
    this.vectors.set(objectId, vector);
  }

  allIds(): string[] {
    return Array.from(this.vectors.keys());
  }

  getVectors(): Map<string, Float32Array> {
    return this.vectors;
  }
}
