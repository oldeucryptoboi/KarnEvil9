import type {
  PeerObjectiveScores,
  ParetoFrontResult,
  PeerEntry,
  SelectionWeights,
  SwarmTaskConstraints,
} from "./types.js";
import { DEFAULT_SELECTION_WEIGHTS } from "./types.js";
import type { ReputationStore } from "./reputation-store.js";

/**
 * Returns true if `a` dominates `b` — a is >= b on all objectives and strictly > on at least one.
 * Higher is better for all objectives.
 */
export function dominates(a: PeerObjectiveScores, b: PeerObjectiveScores): boolean {
  const keys: (keyof Omit<PeerObjectiveScores, "node_id">)[] = ["trust", "latency", "cost", "capability"];
  let strictlyBetter = false;
  for (const k of keys) {
    if (a[k] < b[k]) return false;
    if (a[k] > b[k]) strictlyBetter = true;
  }
  return strictlyBetter;
}

/**
 * Compute the Pareto front from a set of candidates using O(n^2) non-dominated sorting.
 */
export function computeParetoFront(candidates: PeerObjectiveScores[]): {
  front: PeerObjectiveScores[];
  dominated: PeerObjectiveScores[];
} {
  if (candidates.length === 0) return { front: [], dominated: [] };

  const front: PeerObjectiveScores[] = [];
  const dominated: PeerObjectiveScores[] = [];

  for (let i = 0; i < candidates.length; i++) {
    let isDominated = false;
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      if (dominates(candidates[j]!, candidates[i]!)) {
        isDominated = true;
        break;
      }
    }
    if (isDominated) {
      dominated.push(candidates[i]!);
    } else {
      front.push(candidates[i]!);
    }
  }

  return { front, dominated };
}

/**
 * Compute NSGA-II crowding distance for each member of the front.
 * Boundary solutions get Infinity.
 */
export function crowdingDistance(front: PeerObjectiveScores[]): Map<string, number> {
  const distances = new Map<string, number>();
  if (front.length === 0) return distances;

  for (const p of front) {
    distances.set(p.node_id, 0);
  }

  if (front.length <= 2) {
    for (const p of front) {
      distances.set(p.node_id, Infinity);
    }
    return distances;
  }

  const objectives: (keyof Omit<PeerObjectiveScores, "node_id">)[] = ["trust", "latency", "cost", "capability"];

  for (const obj of objectives) {
    const sorted = [...front].sort((a, b) => a[obj] - b[obj]);
    const fMin = sorted[0]![obj];
    const fMax = sorted[sorted.length - 1]![obj];
    const range = fMax - fMin;

    // Boundary solutions get Infinity
    distances.set(sorted[0]!.node_id, Infinity);
    distances.set(sorted[sorted.length - 1]!.node_id, Infinity);

    if (range === 0) continue;

    for (let i = 1; i < sorted.length - 1; i++) {
      const current = distances.get(sorted[i]!.node_id) ?? 0;
      if (current === Infinity) continue;
      const dist = (sorted[i + 1]![obj] - sorted[i - 1]![obj]) / range;
      distances.set(sorted[i]!.node_id, current + dist);
    }
  }

  return distances;
}

/**
 * Select the best candidate from the Pareto front.
 * Uses crowding distance (highest wins). Ties broken by weighted sum.
 */
export function selectFromFront(
  front: PeerObjectiveScores[],
  weights?: SelectionWeights,
): PeerObjectiveScores {
  if (front.length === 0) {
    throw new Error("Cannot select from empty front");
  }
  if (front.length === 1) return front[0]!;

  const w = weights ?? DEFAULT_SELECTION_WEIGHTS;
  const distances = crowdingDistance(front);

  // Sort by crowding distance desc, then by weighted sum desc
  const sorted = [...front].sort((a, b) => {
    const dA = distances.get(a.node_id) ?? 0;
    const dB = distances.get(b.node_id) ?? 0;
    if (dA !== dB) {
      // Both Infinity → fall through to weighted sum
      if (dA === Infinity && dB === Infinity) {
        // fall through
      } else {
        return dB - dA;
      }
    }
    const wA = w.trust * a.trust + w.latency * a.latency + w.cost * a.cost + w.capability * a.capability;
    const wB = w.trust * b.trust + w.latency * b.latency + w.cost * b.cost + w.capability * b.capability;
    return wB - wA;
  });

  return sorted[0]!;
}

/**
 * Full Pareto selection pipeline.
 */
export function paretoSelect(
  candidates: PeerObjectiveScores[],
  weights?: SelectionWeights,
): ParetoFrontResult {
  if (candidates.length === 0) {
    throw new Error("Cannot select from empty candidate set");
  }

  if (candidates.length === 1) {
    return {
      pareto_front: [candidates[0]!],
      dominated: [],
      selected: candidates[0]!,
      selection_method: "single_solution",
    };
  }

  const { front, dominated } = computeParetoFront(candidates);

  if (front.length === 0) {
    // All equal — pick first
    return {
      pareto_front: candidates,
      dominated: [],
      selected: candidates[0]!,
      selection_method: "pareto_weighted",
    };
  }

  const selected = selectFromFront(front, weights);
  const method = front.length === 1 ? "single_solution" : "pareto_crowding";

  return {
    pareto_front: front,
    dominated,
    selected,
    selection_method: method,
  };
}

/**
 * Convert PeerEntry[] to PeerObjectiveScores[] using the same scoring logic
 * as WorkDistributor.scoreMultiObjective.
 */
export function scorePeersForPareto(params: {
  peers: PeerEntry[];
  reputationStore?: ReputationStore;
  constraints?: SwarmTaskConstraints;
}): PeerObjectiveScores[] {
  const { peers, reputationStore, constraints } = params;
  const maxCost = constraints?.max_cost_usd ?? 1.0;
  const required = constraints?.tool_allowlist ?? [];

  return peers.map((peer) => {
    const trustScore = reputationStore
      ? reputationStore.getTrustScore(peer.identity.node_id)
      : 0.5;

    const latencyScore = 1 - Math.min(Math.max(peer.last_latency_ms / 10000, 0), 1);

    const rep = reputationStore?.getReputation(peer.identity.node_id);
    const totalTasks = rep ? rep.tasks_completed + rep.tasks_failed + rep.tasks_aborted : 0;
    const avgCost = totalTasks > 0 ? rep!.total_cost_usd / totalTasks : 0;
    const costScore = 1 - Math.min(Math.max(avgCost / maxCost, 0), 1);

    let capabilityScore = 1.0;
    if (required.length > 0) {
      const intersection = required.filter((r) => peer.identity.capabilities.includes(r)).length;
      capabilityScore = intersection / required.length;
    }

    return {
      node_id: peer.identity.node_id,
      trust: trustScore,
      latency: latencyScore,
      cost: costScore,
      capability: capabilityScore,
    };
  });
}
