import type { DecompositionProposal } from "./types.js";

export interface ProposalCacheConfig {
  max_entries?: number;
  default_ttl_ms?: number;
}

interface CacheEntry {
  proposals: DecompositionProposal[];
  best_proposal_id: string;
  stored_at: number;
  ttl_ms: number;
}

export class ProposalCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;
  private defaultTtlMs: number;

  constructor(config?: ProposalCacheConfig) {
    this.maxEntries = config?.max_entries ?? 100;
    this.defaultTtlMs = config?.default_ttl_ms ?? 600000;
  }

  store(
    taskText: string,
    proposals: DecompositionProposal[],
    bestProposalId: string,
    ttlMs?: number,
  ): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, entry] of this.cache) {
        if (entry.stored_at < oldestTime) {
          oldestTime = entry.stored_at;
          oldestKey = key;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const key = this.normalizeKey(taskText);
    this.cache.set(key, {
      proposals,
      best_proposal_id: bestProposalId,
      stored_at: Date.now(),
      ttl_ms: ttlMs ?? this.defaultTtlMs,
    });
  }

  get(taskText: string): { proposals: DecompositionProposal[]; best_proposal_id: string } | undefined {
    const key = this.normalizeKey(taskText);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.stored_at > entry.ttl_ms) {
      this.cache.delete(key);
      return undefined;
    }

    return { proposals: entry.proposals, best_proposal_id: entry.best_proposal_id };
  }

  has(taskText: string): boolean {
    const key = this.normalizeKey(taskText);
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check TTL
    if (Date.now() - entry.stored_at > entry.ttl_ms) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.stored_at > entry.ttl_ms) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.cache.size;
  }

  private normalizeKey(taskText: string): string {
    return taskText.trim().toLowerCase();
  }
}
