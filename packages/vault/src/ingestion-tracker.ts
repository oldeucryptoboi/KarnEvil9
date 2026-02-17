import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { IngestionRecord } from "./types.js";

export class IngestionTracker {
  private filePath: string;
  private records = new Map<string, IngestionRecord>(); // "source:source_id" → record

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      return;
    }

    const content = await readFile(this.filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as IngestionRecord;
        this.records.set(`${record.source}:${record.source_id}`, record);
      } catch {
        // Skip malformed lines
      }
    }
  }

  hasBeenIngested(source: string, sourceId: string): boolean {
    return this.records.has(`${source}:${sourceId}`);
  }

  hasContentChanged(source: string, sourceId: string, content: string): boolean {
    const record = this.records.get(`${source}:${sourceId}`);
    if (!record) return true;
    return record.content_hash !== this.computeHash(content);
  }

  async track(source: string, sourceId: string, content: string, objectId: string): Promise<IngestionRecord> {
    const record: IngestionRecord = {
      source,
      source_id: sourceId,
      content_hash: this.computeHash(content),
      object_id: objectId,
      ingested_at: new Date().toISOString(),
    };

    this.records.set(`${source}:${sourceId}`, record);

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(record) + "\n", "utf-8");

    return record;
  }

  getRecord(source: string, sourceId: string): IngestionRecord | undefined {
    return this.records.get(`${source}:${sourceId}`);
  }

  getObjectId(source: string, sourceId: string): string | undefined {
    return this.records.get(`${source}:${sourceId}`)?.object_id;
  }

  async compact(): Promise<void> {
    // Re-write with latest records (deduplicates)
    await mkdir(dirname(this.filePath), { recursive: true });
    const content = Array.from(this.records.values())
      .map((r) => JSON.stringify(r))
      .join("\n") + (this.records.size > 0 ? "\n" : "");

    const tmpPath = this.filePath + ".tmp";
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, this.filePath);
  }

  size(): number {
    return this.records.size;
  }

  private computeHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
