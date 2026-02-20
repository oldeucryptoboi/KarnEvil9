import { describe, it, expect } from "vitest";
import {
  dominates,
  computeParetoFront,
  crowdingDistance,
  selectFromFront,
  paretoSelect,
  scorePeersForPareto,
} from "./pareto-selector.js";
import type { PeerObjectiveScores, PeerEntry, SelectionWeights } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────

function makeScores(
  id: string,
  trust: number,
  latency: number,
  cost: number,
  capability: number,
): PeerObjectiveScores {
  return { node_id: id, trust, latency, cost, capability };
}

const mockPeer = (
  id: string,
  latency = 500,
  capabilities: string[] = ["read-file"],
): PeerEntry => ({
  identity: {
    node_id: id,
    display_name: id,
    api_url: `http://${id}:3100`,
    capabilities,
    version: "0.1.0",
  },
  status: "active",
  last_heartbeat_at: new Date().toISOString(),
  last_latency_ms: latency,
  joined_at: new Date().toISOString(),
  consecutive_failures: 0,
});

// ─── dominates ────────────────────────────────────────────────────

describe("dominates", () => {
  it("returns true when a strictly dominates b on all dimensions", () => {
    const a = makeScores("a", 0.9, 0.9, 0.9, 0.9);
    const b = makeScores("b", 0.5, 0.5, 0.5, 0.5);
    expect(dominates(a, b)).toBe(true);
  });

  it("returns true when a is better on one dimension and equal on the rest", () => {
    const a = makeScores("a", 0.8, 0.6, 0.6, 0.6);
    const b = makeScores("b", 0.6, 0.6, 0.6, 0.6);
    expect(dominates(a, b)).toBe(true);
  });

  it("returns false when a equals b on all dimensions", () => {
    const a = makeScores("a", 0.7, 0.7, 0.7, 0.7);
    const b = makeScores("b", 0.7, 0.7, 0.7, 0.7);
    expect(dominates(a, b)).toBe(false);
  });

  it("returns false when a is worse in one dimension", () => {
    const a = makeScores("a", 0.9, 0.9, 0.4, 0.9);
    const b = makeScores("b", 0.5, 0.5, 0.5, 0.5);
    expect(dominates(a, b)).toBe(false);
  });

  it("returns false when b dominates a", () => {
    const a = makeScores("a", 0.3, 0.3, 0.3, 0.3);
    const b = makeScores("b", 0.8, 0.8, 0.8, 0.8);
    expect(dominates(a, b)).toBe(false);
  });
});

// ─── computeParetoFront ───────────────────────────────────────────

describe("computeParetoFront", () => {
  it("returns empty front and dominated for empty input", () => {
    const result = computeParetoFront([]);
    expect(result.front).toEqual([]);
    expect(result.dominated).toEqual([]);
  });

  it("returns single candidate on the front", () => {
    const c = makeScores("solo", 0.8, 0.8, 0.8, 0.8);
    const result = computeParetoFront([c]);
    expect(result.front).toHaveLength(1);
    expect(result.front[0]!.node_id).toBe("solo");
    expect(result.dominated).toHaveLength(0);
  });

  it("places all non-dominated candidates on the front", () => {
    // Two candidates that don't dominate each other (trade-off)
    const a = makeScores("a", 1.0, 0.5, 0.5, 0.5);
    const b = makeScores("b", 0.5, 1.0, 0.5, 0.5);
    const result = computeParetoFront([a, b]);
    expect(result.front).toHaveLength(2);
    expect(result.dominated).toHaveLength(0);
  });

  it("correctly separates dominated candidates", () => {
    const a = makeScores("a", 0.9, 0.9, 0.9, 0.9);
    const b = makeScores("b", 0.5, 0.5, 0.5, 0.5);
    const c = makeScores("c", 0.3, 0.3, 0.3, 0.3);
    const result = computeParetoFront([a, b, c]);
    expect(result.front).toHaveLength(1);
    expect(result.front[0]!.node_id).toBe("a");
    expect(result.dominated).toHaveLength(2);
    const dominatedIds = result.dominated.map((d) => d.node_id).sort();
    expect(dominatedIds).toEqual(["b", "c"]);
  });

  it("puts all candidates on the front when all have equal scores", () => {
    const a = makeScores("a", 0.5, 0.5, 0.5, 0.5);
    const b = makeScores("b", 0.5, 0.5, 0.5, 0.5);
    const c = makeScores("c", 0.5, 0.5, 0.5, 0.5);
    const result = computeParetoFront([a, b, c]);
    expect(result.front).toHaveLength(3);
    expect(result.dominated).toHaveLength(0);
  });

  it("handles mixed Pareto front with some dominated", () => {
    // a and b form the front (trade-off), c is dominated by a
    const a = makeScores("a", 1.0, 0.5, 0.8, 0.8);
    const b = makeScores("b", 0.5, 1.0, 0.8, 0.8);
    const c = makeScores("c", 0.4, 0.4, 0.7, 0.7);
    const result = computeParetoFront([a, b, c]);
    expect(result.front).toHaveLength(2);
    expect(result.dominated).toHaveLength(1);
    expect(result.dominated[0]!.node_id).toBe("c");
  });
});

// ─── crowdingDistance ──────────────────────────────────────────────

describe("crowdingDistance", () => {
  it("returns empty map for empty front", () => {
    const result = crowdingDistance([]);
    expect(result.size).toBe(0);
  });

  it("returns Infinity for a single element", () => {
    const front = [makeScores("a", 0.5, 0.5, 0.5, 0.5)];
    const result = crowdingDistance(front);
    expect(result.get("a")).toBe(Infinity);
  });

  it("returns Infinity for two elements", () => {
    const front = [
      makeScores("a", 0.3, 0.7, 0.5, 0.5),
      makeScores("b", 0.7, 0.3, 0.5, 0.5),
    ];
    const result = crowdingDistance(front);
    expect(result.get("a")).toBe(Infinity);
    expect(result.get("b")).toBe(Infinity);
  });

  it("gives boundary solutions Infinity and interior solutions finite distance", () => {
    const front = [
      makeScores("low", 0.1, 0.1, 0.1, 0.1),
      makeScores("mid", 0.5, 0.5, 0.5, 0.5),
      makeScores("high", 0.9, 0.9, 0.9, 0.9),
    ];
    const result = crowdingDistance(front);
    expect(result.get("low")).toBe(Infinity);
    expect(result.get("high")).toBe(Infinity);
    const midDist = result.get("mid")!;
    expect(midDist).toBeGreaterThan(0);
    expect(Number.isFinite(midDist)).toBe(true);
  });

  it("computes different crowding distances for unevenly spaced interior points", () => {
    const front = [
      makeScores("a", 0.0, 0.0, 0.0, 0.0),
      makeScores("b", 0.2, 0.2, 0.2, 0.2),
      makeScores("c", 0.8, 0.8, 0.8, 0.8),
      makeScores("d", 1.0, 1.0, 1.0, 1.0),
    ];
    const result = crowdingDistance(front);
    // Boundary solutions get Infinity
    expect(result.get("a")).toBe(Infinity);
    expect(result.get("d")).toBe(Infinity);
    // Interior points get finite distances
    const bDist = result.get("b")!;
    const cDist = result.get("c")!;
    expect(Number.isFinite(bDist)).toBe(true);
    expect(Number.isFinite(cDist)).toBe(true);
    // c spans a wider gap (0.2 to 1.0 = 0.8) than b (0.0 to 0.8 = 0.8) — same in this case
    // Each objective contributes (upper - lower) / range
    // For b: (0.8 - 0.0) / 1.0 = 0.8 per objective = 4 * 0.8 = 3.2
    // For c: (1.0 - 0.2) / 1.0 = 0.8 per objective = 4 * 0.8 = 3.2
    expect(bDist).toBeCloseTo(3.2, 5);
    expect(cDist).toBeCloseTo(3.2, 5);
  });
});

// ─── selectFromFront ──────────────────────────────────────────────

describe("selectFromFront", () => {
  it("throws on empty front", () => {
    expect(() => selectFromFront([])).toThrow("Cannot select from empty front");
  });

  it("returns the only element for single-element front", () => {
    const sole = makeScores("sole", 0.8, 0.8, 0.8, 0.8);
    const result = selectFromFront([sole]);
    expect(result.node_id).toBe("sole");
  });

  it("selects between two elements using weighted sum (both have Infinity crowding)", () => {
    const a = makeScores("a", 0.9, 0.9, 0.9, 0.9);
    const b = makeScores("b", 0.1, 0.1, 0.1, 0.1);
    const result = selectFromFront([a, b]);
    expect(result.node_id).toBe("a");
  });

  it("selects boundary solution over interior when boundary has higher weighted sum", () => {
    // With 3+ elements, boundary gets Infinity crowding, interior gets finite
    // Both boundary solutions get Infinity, so the one with higher weighted sum wins
    const low = makeScores("low", 0.1, 0.1, 0.1, 0.1);
    const mid = makeScores("mid", 0.5, 0.5, 0.5, 0.5);
    const high = makeScores("high", 0.9, 0.9, 0.9, 0.9);
    const result = selectFromFront([low, mid, high]);
    // high has the best weighted sum among the Infinity-distance boundary solutions
    expect(result.node_id).toBe("high");
  });

  it("respects custom weights when breaking ties", () => {
    // Two boundary solutions with Infinity crowding distance
    const a = makeScores("a", 1.0, 0.0, 0.0, 0.0);
    const b = makeScores("b", 0.0, 1.0, 0.0, 0.0);
    // Weight trust heavily
    const weights: SelectionWeights = { trust: 1.0, latency: 0.0, cost: 0.0, capability: 0.0 };
    const result = selectFromFront([a, b], weights);
    expect(result.node_id).toBe("a");
  });
});

// ─── paretoSelect ─────────────────────────────────────────────────

describe("paretoSelect", () => {
  it("throws on empty candidate set", () => {
    expect(() => paretoSelect([])).toThrow("Cannot select from empty candidate set");
  });

  it("returns single_solution for one candidate", () => {
    const c = makeScores("solo", 0.7, 0.7, 0.7, 0.7);
    const result = paretoSelect([c]);
    expect(result.selection_method).toBe("single_solution");
    expect(result.selected.node_id).toBe("solo");
    expect(result.pareto_front).toHaveLength(1);
    expect(result.dominated).toHaveLength(0);
  });

  it("returns pareto_crowding when front has multiple candidates", () => {
    // Trade-off: a good on trust, b good on latency
    const a = makeScores("a", 1.0, 0.2, 0.5, 0.5);
    const b = makeScores("b", 0.2, 1.0, 0.5, 0.5);
    const c = makeScores("c", 0.1, 0.1, 0.1, 0.1);
    const result = paretoSelect([a, b, c]);
    expect(result.selection_method).toBe("pareto_crowding");
    expect(result.pareto_front).toHaveLength(2);
    expect(result.dominated).toHaveLength(1);
    expect(result.dominated[0]!.node_id).toBe("c");
    // Selected should be one of the front members
    const frontIds = result.pareto_front.map((p) => p.node_id);
    expect(frontIds).toContain(result.selected.node_id);
  });

  it("returns single_solution when front has exactly one member", () => {
    const a = makeScores("a", 0.9, 0.9, 0.9, 0.9);
    const b = makeScores("b", 0.1, 0.1, 0.1, 0.1);
    const result = paretoSelect([a, b]);
    expect(result.selection_method).toBe("single_solution");
    expect(result.selected.node_id).toBe("a");
    expect(result.pareto_front).toHaveLength(1);
    expect(result.dominated).toHaveLength(1);
  });

  it("handles all equal candidates", () => {
    const a = makeScores("a", 0.5, 0.5, 0.5, 0.5);
    const b = makeScores("b", 0.5, 0.5, 0.5, 0.5);
    const c = makeScores("c", 0.5, 0.5, 0.5, 0.5);
    const result = paretoSelect([a, b, c]);
    // All equal means none dominated, all on front
    expect(result.pareto_front).toHaveLength(3);
    expect(result.dominated).toHaveLength(0);
    expect(result.selection_method).toBe("pareto_crowding");
  });

  it("uses custom weights for final selection", () => {
    const a = makeScores("a", 1.0, 0.0, 0.5, 0.5);
    const b = makeScores("b", 0.0, 1.0, 0.5, 0.5);
    // Both on front; heavily weight trust so a should win
    const weights: SelectionWeights = { trust: 1.0, latency: 0.0, cost: 0.0, capability: 0.0 };
    const result = paretoSelect([a, b], weights);
    expect(result.selected.node_id).toBe("a");
  });
});

// ─── scorePeersForPareto ──────────────────────────────────────────

describe("scorePeersForPareto", () => {
  it("converts a PeerEntry without reputation data using defaults", () => {
    const peers = [mockPeer("node-1", 500)];
    const scores = scorePeersForPareto({ peers });
    expect(scores).toHaveLength(1);
    const s = scores[0]!;
    expect(s.node_id).toBe("node-1");
    // Default trust is 0.5 when no reputation store
    expect(s.trust).toBe(0.5);
    // latency = 1 - (500 / 10000) = 0.95
    expect(s.latency).toBeCloseTo(0.95, 5);
    // Without reputation, avgCost=0, costScore = 1 - 0/1 = 1
    expect(s.cost).toBe(1);
    // No required capabilities => 1.0
    expect(s.capability).toBe(1.0);
  });

  it("converts a PeerEntry with reputation data from ReputationStore", () => {
    const peers = [mockPeer("node-r", 1000)];
    // Create a mock reputation store
    const mockRepStore = {
      getTrustScore: (nodeId: string) => (nodeId === "node-r" ? 0.85 : 0.5),
      getReputation: (nodeId: string) =>
        nodeId === "node-r"
          ? {
              node_id: "node-r",
              tasks_completed: 8,
              tasks_failed: 2,
              tasks_aborted: 0,
              total_duration_ms: 50000,
              total_tokens_used: 10000,
              total_cost_usd: 5.0,
              avg_latency_ms: 5000,
              consecutive_successes: 3,
              consecutive_failures: 0,
              last_outcome_at: new Date().toISOString(),
              trust_score: 0.85,
            }
          : undefined,
    } as any;

    const scores = scorePeersForPareto({ peers, reputationStore: mockRepStore });
    expect(scores).toHaveLength(1);
    const s = scores[0]!;
    expect(s.trust).toBe(0.85);
    // latency = 1 - (1000 / 10000) = 0.9
    expect(s.latency).toBeCloseTo(0.9, 5);
    // avgCost = 5.0 / 10 = 0.5, costScore = 1 - 0.5/1.0 = 0.5
    expect(s.cost).toBeCloseTo(0.5, 5);
    expect(s.capability).toBe(1.0);
  });

  it("computes capability score based on constraints tool_allowlist", () => {
    const peers = [mockPeer("node-c", 200, ["read-file", "write-file"])];
    const constraints = { tool_allowlist: ["read-file", "write-file", "shell-exec"] };
    const scores = scorePeersForPareto({ peers, constraints });
    const s = scores[0]!;
    // peer has 2 of 3 required tools
    expect(s.capability).toBeCloseTo(2 / 3, 5);
  });

  it("gives full capability score when peer has all required tools", () => {
    const peers = [mockPeer("node-all", 200, ["read-file", "write-file"])];
    const constraints = { tool_allowlist: ["read-file", "write-file"] };
    const scores = scorePeersForPareto({ peers, constraints });
    expect(scores[0]!.capability).toBe(1.0);
  });

  it("gives zero capability score when peer has none of the required tools", () => {
    const peers = [mockPeer("node-none", 200, ["http-request"])];
    const constraints = { tool_allowlist: ["read-file", "write-file"] };
    const scores = scorePeersForPareto({ peers, constraints });
    expect(scores[0]!.capability).toBe(0);
  });

  it("clamps latency score between 0 and 1 for extreme values", () => {
    // Very high latency -> score should be 0
    const slowPeers = [mockPeer("slow", 20000)];
    const slowScores = scorePeersForPareto({ peers: slowPeers });
    expect(slowScores[0]!.latency).toBe(0);

    // Zero latency -> score should be 1
    const fastPeers = [mockPeer("fast", 0)];
    const fastScores = scorePeersForPareto({ peers: fastPeers });
    expect(fastScores[0]!.latency).toBe(1);
  });

  it("uses max_cost_usd from constraints for cost normalization", () => {
    const peers = [mockPeer("node-cost", 500)];
    const mockRepStore = {
      getTrustScore: () => 0.5,
      getReputation: () => ({
        node_id: "node-cost",
        tasks_completed: 5,
        tasks_failed: 0,
        tasks_aborted: 0,
        total_duration_ms: 10000,
        total_tokens_used: 5000,
        total_cost_usd: 10.0,
        avg_latency_ms: 2000,
        consecutive_successes: 5,
        consecutive_failures: 0,
        last_outcome_at: new Date().toISOString(),
        trust_score: 0.5,
      }),
    } as any;

    // avgCost = 10.0 / 5 = 2.0, with max_cost_usd=10 -> costScore = 1 - 2/10 = 0.8
    const scores = scorePeersForPareto({
      peers,
      reputationStore: mockRepStore,
      constraints: { max_cost_usd: 10 },
    });
    expect(scores[0]!.cost).toBeCloseTo(0.8, 5);
  });
});
