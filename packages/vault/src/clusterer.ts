import { cosineSimilarity } from "./vector-store.js";
import type { ClusterResult, ClusterMember } from "./types.js";

export interface ClusterInput {
  id: string;
  vector: Float32Array;
}

export interface OPTICSOptions {
  minPts?: number;
  epsilon?: number;
  maxObjects?: number;
  onTruncated?: (actual: number, limit: number) => void;
}

interface OPTICSPoint {
  index: number;
  id: string;
  vector: Float32Array;
  reachabilityDistance: number;
  coreDistance: number;
  processed: boolean;
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  return 1 - cosineSimilarity(a, b);
}

export class OPTICSClusterer {
  private minPts: number;
  private epsilon: number;
  private maxObjects: number;
  private onTruncated: ((actual: number, limit: number) => void) | null;

  constructor(options?: OPTICSOptions) {
    this.minPts = options?.minPts ?? 3;
    this.epsilon = options?.epsilon ?? -1; // -1 = auto
    this.maxObjects = options?.maxObjects ?? 10000;
    this.onTruncated = options?.onTruncated ?? null;
  }

  cluster(data: ClusterInput[]): ClusterResult[] {
    if (data.length === 0) return [];
    if (data.length > this.maxObjects) {
      if (this.onTruncated) {
        this.onTruncated(data.length, this.maxObjects);
      }
      data = data.slice(0, this.maxObjects);
    }
    if (data.length < this.minPts) {
      // Everything is noise
      return [];
    }

    // Precompute distance matrix
    const n = data.length;
    const distances = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = cosineDistance(data[i]!.vector, data[j]!.vector);
        distances[i * n + j] = d;
        distances[j * n + i] = d;
      }
    }

    // Auto-epsilon: median of k-nearest distances * 2
    let epsilon = this.epsilon;
    if (epsilon < 0) {
      epsilon = this.autoEpsilon(distances, n);
    }

    // Initialize points
    const points: OPTICSPoint[] = data.map((d, i) => ({
      index: i,
      id: d.id,
      vector: d.vector,
      reachabilityDistance: Infinity,
      coreDistance: -1,
      processed: false,
    }));

    // Compute core distances
    for (let i = 0; i < n; i++) {
      const dists: number[] = [];
      for (let j = 0; j < n; j++) {
        if (i !== j) dists.push(distances[i * n + j]!);
      }
      dists.sort((a, b) => a - b);
      const kDist = dists[this.minPts - 1];
      points[i]!.coreDistance = kDist !== undefined && kDist <= epsilon ? kDist : -1;
    }

    // OPTICS ordering
    const ordering: number[] = [];
    for (let i = 0; i < n; i++) {
      if (points[i]!.processed) continue;
      this.expandClusterOrder(points, i, epsilon, distances, n, ordering);
    }

    // Extract clusters from reachability plot
    return this.extractClusters(points, ordering, epsilon, data);
  }

  private autoEpsilon(distances: Float32Array, n: number): number {
    const kDistances: number[] = [];
    for (let i = 0; i < n; i++) {
      const dists: number[] = [];
      for (let j = 0; j < n; j++) {
        if (i !== j) dists.push(distances[i * n + j]!);
      }
      dists.sort((a, b) => a - b);
      const kd = dists[this.minPts - 1];
      if (kd !== undefined) kDistances.push(kd);
    }
    kDistances.sort((a, b) => a - b);
    const median = kDistances[Math.floor(kDistances.length / 2)] ?? 0.5;
    return median * 2;
  }

  private expandClusterOrder(
    points: OPTICSPoint[],
    pointIndex: number,
    epsilon: number,
    distances: Float32Array,
    n: number,
    ordering: number[],
  ): void {
    // Priority queue as sorted array (simple for moderate n)
    const seeds: Array<{ index: number; reachDist: number }> = [];

    points[pointIndex]!.processed = true;
    ordering.push(pointIndex);

    const neighbors = this.getNeighbors(pointIndex, epsilon, distances, n);
    if (points[pointIndex]!.coreDistance >= 0) {
      this.updateSeeds(seeds, points, pointIndex, neighbors, distances, n);

      while (seeds.length > 0) {
        const current = seeds.shift()!;
        const currentPoint = points[current.index]!;

        if (currentPoint.processed) continue;
        currentPoint.processed = true;
        currentPoint.reachabilityDistance = current.reachDist;
        ordering.push(current.index);

        const currentNeighbors = this.getNeighbors(current.index, epsilon, distances, n);
        if (currentPoint.coreDistance >= 0) {
          this.updateSeeds(seeds, points, current.index, currentNeighbors, distances, n);
        }
      }
    }
  }

  private getNeighbors(
    pointIndex: number,
    epsilon: number,
    distances: Float32Array,
    n: number,
  ): number[] {
    const result: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j !== pointIndex && distances[pointIndex * n + j]! <= epsilon) {
        result.push(j);
      }
    }
    return result;
  }

  private updateSeeds(
    seeds: Array<{ index: number; reachDist: number }>,
    points: OPTICSPoint[],
    centerIndex: number,
    neighbors: number[],
    distances: Float32Array,
    n: number,
  ): void {
    const coreDist = points[centerIndex]!.coreDistance;
    for (const nb of neighbors) {
      if (points[nb]!.processed) continue;
      const newReachDist = Math.max(coreDist, distances[centerIndex * n + nb]!);
      const existing = seeds.find((s) => s.index === nb);
      if (existing) {
        if (newReachDist < existing.reachDist) {
          existing.reachDist = newReachDist;
        }
      } else {
        seeds.push({ index: nb, reachDist: newReachDist });
      }
    }
    seeds.sort((a, b) => a.reachDist - b.reachDist);
  }

  private extractClusters(
    points: OPTICSPoint[],
    ordering: number[],
    epsilon: number,
    data: ClusterInput[],
  ): ClusterResult[] {
    // Use steep threshold for cluster extraction
    const threshold = epsilon * 0.75;
    const clusters: Map<number, number[]> = new Map();
    let currentCluster = -1;

    for (const idx of ordering) {
      const point = points[idx]!;
      if (point.reachabilityDistance > threshold) {
        // Could be start of new cluster if it's a core point
        if (point.coreDistance >= 0) {
          currentCluster++;
          clusters.set(currentCluster, [idx]);
        } else {
          currentCluster = -1; // noise
        }
      } else {
        if (currentCluster >= 0) {
          clusters.get(currentCluster)!.push(idx);
        }
      }
    }

    // Convert to ClusterResult
    const results: ClusterResult[] = [];
    for (const [clusterId, memberIndices] of clusters) {
      if (memberIndices.length < this.minPts) continue;

      // Compute centroid
      const dim = data[0]!.vector.length;
      const centroid = new Float32Array(dim);
      for (const mi of memberIndices) {
        const vec = data[mi]!.vector;
        for (let d = 0; d < dim; d++) {
          centroid[d] = centroid[d]! + vec[d]! / memberIndices.length;
        }
      }

      // Find representative (closest to centroid)
      let bestDist = Infinity;
      let representativeId = data[memberIndices[0]!]!.id;
      for (const mi of memberIndices) {
        const dist = cosineDistance(data[mi]!.vector, centroid);
        if (dist < bestDist) {
          bestDist = dist;
          representativeId = data[mi]!.id;
        }
      }

      const members: ClusterMember[] = memberIndices.map((mi) => ({
        object_id: data[mi]!.id,
        classification: points[mi]!.coreDistance >= 0 ? "core" as const : "border" as const,
      }));

      results.push({
        cluster_id: clusterId,
        members,
        representative_id: representativeId,
      });
    }

    return results;
  }
}
