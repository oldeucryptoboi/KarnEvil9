import { readFile, writeFile, readdir, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { v4 as uuid } from "uuid";
import type { VaultObject, VaultObjectFrontmatter, ParaCategory } from "./types.js";
import { PARA_FOLDERS } from "./types.js";
import { serializeVaultObject, deserializeVaultObject, sanitizeFileName } from "./markdown-serializer.js";
import type { OntologySchema } from "./types.js";

export interface IndexEntry {
  object_id: string;
  object_type: string;
  source: string;
  source_id: string;
  title: string;
  tags: string[];
  entities: string[];
  para_category: ParaCategory;
  file_path: string;
  created_at: string;
  ingested_at: string;
}

export class ObjectStore {
  private vaultRoot: string;
  private index = new Map<string, IndexEntry>();
  private sourceIndex = new Map<string, string>(); // "source:source_id" → object_id

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
  }

  async init(): Promise<void> {
    await this.rebuildIndex();
  }

  async rebuildIndex(): Promise<void> {
    this.index.clear();
    this.sourceIndex.clear();

    const dirs = [
      ...Object.values(PARA_FOLDERS).map((f) => join(this.vaultRoot, f)),
      join(this.vaultRoot, "_Ontology", "Objects"),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      await this.scanDirectory(dir);
    }
  }

  private async scanDirectory(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const content = await readFile(fullPath, "utf-8");
          const obj = deserializeVaultObject(content, relative(this.vaultRoot, fullPath));
          this.addToIndex(obj);
        } catch {
          // Skip malformed files
        }
      }
    }
  }

  private addToIndex(obj: VaultObject): void {
    const entry: IndexEntry = {
      object_id: obj.frontmatter.object_id,
      object_type: obj.frontmatter.object_type,
      source: obj.frontmatter.source,
      source_id: obj.frontmatter.source_id,
      title: obj.title,
      tags: obj.frontmatter.tags,
      entities: obj.frontmatter.entities,
      para_category: obj.frontmatter.para_category,
      file_path: obj.file_path,
      created_at: obj.frontmatter.created_at,
      ingested_at: obj.frontmatter.ingested_at,
    };
    this.index.set(entry.object_id, entry);
    this.sourceIndex.set(`${entry.source}:${entry.source_id}`, entry.object_id);
  }

  private removeFromIndex(objectId: string): void {
    const entry = this.index.get(objectId);
    if (entry) {
      this.sourceIndex.delete(`${entry.source}:${entry.source_id}`);
      this.index.delete(objectId);
    }
  }

  async create(
    title: string,
    content: string,
    frontmatter: Partial<VaultObjectFrontmatter>,
    schema: OntologySchema,
  ): Promise<VaultObject> {
    const objectId = frontmatter.object_id ?? uuid();
    const now = new Date().toISOString();
    const objectType = frontmatter.object_type ?? "Note";
    const paraCategory = frontmatter.para_category ?? "inbox";

    const fm: VaultObjectFrontmatter = {
      object_id: objectId,
      object_type: objectType,
      source: frontmatter.source ?? "manual",
      source_id: frontmatter.source_id ?? objectId,
      created_at: frontmatter.created_at ?? now,
      ingested_at: frontmatter.ingested_at ?? now,
      tags: frontmatter.tags ?? [],
      entities: frontmatter.entities ?? [],
      para_category: paraCategory,
      confidence: frontmatter.confidence ?? 0,
      classified_by: frontmatter.classified_by ?? "unclassified",
      ...frontmatter,
    };

    const filePath = this.computeFilePath(objectType, paraCategory, title, schema);
    const obj: VaultObject = { frontmatter: fm, title, content, file_path: filePath, links: [] };

    const absPath = join(this.vaultRoot, filePath);
    await mkdir(join(absPath, ".."), { recursive: true });

    // Atomic write
    const tmpPath = absPath + ".tmp";
    await writeFile(tmpPath, serializeVaultObject(obj), "utf-8");
    await rename(tmpPath, absPath);

    this.addToIndex(obj);
    return obj;
  }

  async update(objectId: string, updates: { title?: string; content?: string; frontmatter?: Partial<VaultObjectFrontmatter> }): Promise<VaultObject | null> {
    const existing = await this.get(objectId);
    if (!existing) return null;

    const updated: VaultObject = {
      ...existing,
      title: updates.title ?? existing.title,
      content: updates.content ?? existing.content,
      frontmatter: { ...existing.frontmatter, ...updates.frontmatter },
    };

    const absPath = join(this.vaultRoot, existing.file_path);
    const tmpPath = absPath + ".tmp";
    await writeFile(tmpPath, serializeVaultObject(updated), "utf-8");
    await rename(tmpPath, absPath);

    this.addToIndex(updated);
    return updated;
  }

  async get(objectId: string): Promise<VaultObject | null> {
    const entry = this.index.get(objectId);
    if (!entry) return null;

    const absPath = join(this.vaultRoot, entry.file_path);
    if (!existsSync(absPath)) {
      this.removeFromIndex(objectId);
      return null;
    }

    const content = await readFile(absPath, "utf-8");
    return deserializeVaultObject(content, entry.file_path);
  }

  async delete(objectId: string): Promise<boolean> {
    const entry = this.index.get(objectId);
    if (!entry) return false;

    const absPath = join(this.vaultRoot, entry.file_path);
    try {
      await unlink(absPath);
    } catch {
      // File already gone
    }
    this.removeFromIndex(objectId);
    return true;
  }

  getBySourceId(source: string, sourceId: string): string | undefined {
    return this.sourceIndex.get(`${source}:${sourceId}`);
  }

  search(query: {
    text?: string;
    object_type?: string;
    para_category?: ParaCategory;
    tags?: string[];
    source?: string;
    limit?: number;
  }): IndexEntry[] {
    let results = Array.from(this.index.values());

    if (query.object_type) {
      results = results.filter((e) => e.object_type === query.object_type);
    }
    if (query.para_category) {
      results = results.filter((e) => e.para_category === query.para_category);
    }
    if (query.source) {
      results = results.filter((e) => e.source === query.source);
    }
    if (query.tags && query.tags.length > 0) {
      results = results.filter((e) => query.tags!.some((t) => e.tags.includes(t)));
    }
    if (query.text) {
      const lower = query.text.toLowerCase();
      results = results.filter(
        (e) =>
          e.title.toLowerCase().includes(lower) ||
          e.tags.some((t) => t.toLowerCase().includes(lower)) ||
          e.entities.some((ent) => ent.toLowerCase().includes(lower)),
      );
    }

    results.sort((a, b) => b.ingested_at.localeCompare(a.ingested_at));

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  getStats(): { total: number; by_type: Record<string, number>; by_category: Record<string, number> } {
    const by_type: Record<string, number> = {};
    const by_category: Record<string, number> = {};

    for (const entry of this.index.values()) {
      by_type[entry.object_type] = (by_type[entry.object_type] ?? 0) + 1;
      by_category[entry.para_category] = (by_category[entry.para_category] ?? 0) + 1;
    }

    return { total: this.index.size, by_type, by_category };
  }

  size(): number {
    return this.index.size;
  }

  private computeFilePath(
    objectType: string,
    paraCategory: ParaCategory,
    title: string,
    schema: OntologySchema,
  ): string {
    const isEntity = schema.object_types.some(
      (ot) => ot.name === objectType && ["Person", "Tool", "Concept", "Organization"].includes(ot.name),
    );

    const safeName = sanitizeFileName(title) + ".md";

    if (isEntity) {
      const typeDef = schema.object_types.find((ot) => ot.name === objectType);
      const folder = typeDef?.folder ?? objectType;
      return join("_Ontology", "Objects", folder, safeName);
    }

    const paraFolder = PARA_FOLDERS[paraCategory];
    return join(paraFolder, safeName);
  }
}
