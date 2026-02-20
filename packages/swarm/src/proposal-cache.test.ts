import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProposalCache } from "./proposal-cache.js";
import type { DecompositionProposal } from "./types.js";

function makeProposal(overrides: Partial<DecompositionProposal> = {}): DecompositionProposal {
  return {
    proposal_id: "prop-1",
    original_task_text: "do something",
    decomposition: {
      original_task_text: "do something",
      sub_tasks: [],
      execution_order: [],
    },
    estimated_total_cost_usd: 0.1,
    estimated_total_duration_ms: 5000,
    verifiability_score: 0.8,
    confidence: 0.9,
    generation_strategy: "mock",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("ProposalCache", () => {
  let cache: ProposalCache;

  beforeEach(() => {
    cache = new ProposalCache();
    vi.restoreAllMocks();
  });

  // ─── store and get ──────────────────────────────────────────────

  it("should store and retrieve proposals", () => {
    const proposals = [makeProposal(), makeProposal({ proposal_id: "prop-2" })];
    cache.store("Do something", proposals, "prop-1");

    const result = cache.get("Do something");
    expect(result).toBeDefined();
    expect(result!.proposals).toHaveLength(2);
    expect(result!.best_proposal_id).toBe("prop-1");
    expect(result!.proposals[0]!.proposal_id).toBe("prop-1");
    expect(result!.proposals[1]!.proposal_id).toBe("prop-2");
  });

  // ─── has ────────────────────────────────────────────────────────

  it("should return true for cached entries and false for missing", () => {
    const proposals = [makeProposal()];
    cache.store("cached task", proposals, "prop-1");

    expect(cache.has("cached task")).toBe(true);
    expect(cache.has("missing task")).toBe(false);
  });

  // ─── TTL expiry ─────────────────────────────────────────────────

  it("should not return entries after TTL expires", () => {
    const proposals = [makeProposal()];
    cache.store("expiring task", proposals, "prop-1", 100);

    expect(cache.get("expiring task")).toBeDefined();
    expect(cache.has("expiring task")).toBe(true);

    // Advance time past TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);

    expect(cache.get("expiring task")).toBeUndefined();
    expect(cache.has("expiring task")).toBe(false);

    vi.useRealTimers();
  });

  // ─── max_entries eviction ───────────────────────────────────────

  it("should evict the oldest entry when at max capacity", () => {
    const smallCache = new ProposalCache({ max_entries: 2 });
    const proposals = [makeProposal()];

    // Store two entries with a small time gap
    smallCache.store("first task", proposals, "prop-1");
    // Nudge time forward so "first" is oldest
    const originalNow = Date.now;
    let tick = 0;
    vi.spyOn(Date, "now").mockImplementation(() => originalNow() + ++tick * 10);

    smallCache.store("second task", proposals, "prop-1");
    smallCache.store("third task", proposals, "prop-1");

    // "first task" should have been evicted
    expect(smallCache.has("first task")).toBe(false);
    expect(smallCache.has("second task")).toBe(true);
    expect(smallCache.has("third task")).toBe(true);
    expect(smallCache.size).toBe(2);
  });

  // ─── clear ──────────────────────────────────────────────────────

  it("should clear all entries", () => {
    cache.store("task a", [makeProposal()], "prop-1");
    cache.store("task b", [makeProposal()], "prop-1");
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has("task a")).toBe(false);
    expect(cache.has("task b")).toBe(false);
  });

  // ─── cleanup ────────────────────────────────────────────────────

  it("should remove expired entries on cleanup", () => {
    const proposals = [makeProposal()];
    cache.store("short-lived", proposals, "prop-1", 50);
    cache.store("long-lived", proposals, "prop-1", 999999);

    expect(cache.size).toBe(2);

    vi.useFakeTimers();
    vi.advanceTimersByTime(100);

    const removed = cache.cleanup();
    expect(removed).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.has("short-lived")).toBe(false);
    expect(cache.has("long-lived")).toBe(true);

    vi.useRealTimers();
  });

  // ─── normalizeKey ───────────────────────────────────────────────

  it("should normalize keys as case-insensitive and trimmed", () => {
    const proposals = [makeProposal()];
    cache.store("  Hello World  ", proposals, "prop-1");

    expect(cache.get("hello world")).toBeDefined();
    expect(cache.get("HELLO WORLD")).toBeDefined();
    expect(cache.get("  HELLO WORLD  ")).toBeDefined();
    expect(cache.has("Hello World")).toBe(true);
  });

  // ─── size getter ────────────────────────────────────────────────

  it("should report correct size", () => {
    expect(cache.size).toBe(0);

    cache.store("task 1", [makeProposal()], "prop-1");
    expect(cache.size).toBe(1);

    cache.store("task 2", [makeProposal()], "prop-2");
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
