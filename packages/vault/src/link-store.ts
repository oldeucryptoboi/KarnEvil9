import { readFile, mkdir, rename, appendFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { v4 as uuid } from "uuid";
import type { VaultLink } from "./types.js";

export class LinkStore {
  private filePath: string;
  private links = new Map<string, VaultLink>();
  private adjacency = new Map<string, Set<string>>(); // object_id → Set<link_id>

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
        const link = JSON.parse(line) as VaultLink;
        this.links.set(link.link_id, link);
        this.addToAdjacency(link);
      } catch {
        // Skip malformed lines
      }
    }
  }

  async addLink(partial: Omit<VaultLink, "link_id" | "created_at"> & { link_id?: string; created_at?: string }): Promise<VaultLink> {
    const link: VaultLink = {
      link_id: partial.link_id ?? uuid(),
      source_id: partial.source_id,
      target_id: partial.target_id,
      link_type: partial.link_type,
      confidence: partial.confidence,
      created_at: partial.created_at ?? new Date().toISOString(),
    };

    // Deduplicate: same source + target + type
    const existing = this.findLink(link.source_id, link.target_id, link.link_type);
    if (existing) {
      // Update confidence if higher
      if (link.confidence > existing.confidence) {
        existing.confidence = link.confidence;
        await this.save();
      }
      return existing;
    }

    this.links.set(link.link_id, link);
    this.addToAdjacency(link);

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(link) + "\n", "utf-8");

    return link;
  }

  removeLink(linkId: string): boolean {
    const link = this.links.get(linkId);
    if (!link) return false;
    this.links.delete(linkId);
    this.removeFromAdjacency(link);
    return true;
  }

  getLink(linkId: string): VaultLink | undefined {
    return this.links.get(linkId);
  }

  getLinksForObject(objectId: string): VaultLink[] {
    const linkIds = this.adjacency.get(objectId);
    if (!linkIds) return [];
    return Array.from(linkIds)
      .map((id) => this.links.get(id))
      .filter((l): l is VaultLink => l !== undefined);
  }

  getOutgoingLinks(objectId: string): VaultLink[] {
    return this.getLinksForObject(objectId).filter((l) => l.source_id === objectId);
  }

  getIncomingLinks(objectId: string): VaultLink[] {
    return this.getLinksForObject(objectId).filter((l) => l.target_id === objectId);
  }

  findLink(sourceId: string, targetId: string, linkType: string): VaultLink | undefined {
    for (const link of this.links.values()) {
      if (link.source_id === sourceId && link.target_id === targetId && link.link_type === linkType) {
        return link;
      }
    }
    return undefined;
  }

  traverse(startId: string, maxDepth: number = 2): Map<string, VaultLink[]> {
    const visited = new Set<string>();
    const result = new Map<string, VaultLink[]>();

    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const links = this.getLinksForObject(id);
      if (links.length > 0) {
        result.set(id, links);
      }

      if (depth < maxDepth) {
        for (const link of links) {
          const nextId = link.source_id === id ? link.target_id : link.source_id;
          if (!visited.has(nextId)) {
            queue.push({ id: nextId, depth: depth + 1 });
          }
        }
      }
    }

    return result;
  }

  getOrphanedLinks(validObjectIds: Set<string>): VaultLink[] {
    return Array.from(this.links.values()).filter(
      (l) => !validObjectIds.has(l.source_id) || !validObjectIds.has(l.target_id),
    );
  }

  async removeOrphanedLinks(validObjectIds: Set<string>): Promise<number> {
    const orphans = this.getOrphanedLinks(validObjectIds);
    for (const link of orphans) {
      this.links.delete(link.link_id);
      this.removeFromAdjacency(link);
    }
    if (orphans.length > 0) {
      await this.save();
    }
    return orphans.length;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const content = Array.from(this.links.values())
      .map((l) => JSON.stringify(l))
      .join("\n") + (this.links.size > 0 ? "\n" : "");

    const tmpPath = this.filePath + ".tmp";
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(content, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }

  size(): number {
    return this.links.size;
  }

  allLinks(): VaultLink[] {
    return Array.from(this.links.values());
  }

  private addToAdjacency(link: VaultLink): void {
    if (!this.adjacency.has(link.source_id)) {
      this.adjacency.set(link.source_id, new Set());
    }
    this.adjacency.get(link.source_id)!.add(link.link_id);

    if (!this.adjacency.has(link.target_id)) {
      this.adjacency.set(link.target_id, new Set());
    }
    this.adjacency.get(link.target_id)!.add(link.link_id);
  }

  private removeFromAdjacency(link: VaultLink): void {
    this.adjacency.get(link.source_id)?.delete(link.link_id);
    this.adjacency.get(link.target_id)?.delete(link.link_id);
  }
}
