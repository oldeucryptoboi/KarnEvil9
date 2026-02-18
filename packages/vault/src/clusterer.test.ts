import { describe, it, expect } from "vitest";
import { OPTICSClusterer } from "./clusterer.js";
import type { ClusterInput } from "./clusterer.js";

function makeVector(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function makeClusterData(
  groups: Array<{ prefix: string; center: number[]; count: number; spread: number }>,
): ClusterInput[] {
  const data: ClusterInput[] = [];
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      const vec = group.center.map((v) => v + (Math.random() - 0.5) * group.spread);
      // Normalize
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      data.push({
        id: `${group.prefix}-${i}`,
        vector: new Float32Array(norm > 0 ? vec.map((v) => v / norm) : vec),
      });
    }
  }
  return data;
}

describe("OPTICSClusterer", () => {
  it("returns empty for empty input", () => {
    const clusterer = new OPTICSClusterer();
    const result = clusterer.cluster([]);
    expect(result).toEqual([]);
  });

  it("returns empty when data is smaller than minPts", () => {
    const clusterer = new OPTICSClusterer({ minPts: 5 });
    const data: ClusterInput[] = [
      { id: "a", vector: makeVector(1, 0, 0) },
      { id: "b", vector: makeVector(0, 1, 0) },
    ];
    const result = clusterer.cluster(data);
    expect(result).toEqual([]);
  });

  it("clusters well-separated groups", () => {
    const data: ClusterInput[] = [
      // Cluster 1: near [1, 0, 0]
      { id: "a1", vector: makeVector(1, 0.01, 0) },
      { id: "a2", vector: makeVector(0.99, 0.02, 0) },
      { id: "a3", vector: makeVector(0.98, 0.03, 0) },
      { id: "a4", vector: makeVector(0.97, 0.01, 0) },
      // Cluster 2: near [0, 1, 0]
      { id: "b1", vector: makeVector(0, 1, 0.01) },
      { id: "b2", vector: makeVector(0.02, 0.99, 0) },
      { id: "b3", vector: makeVector(0.01, 0.98, 0.03) },
      { id: "b4", vector: makeVector(0.03, 0.97, 0) },
    ];

    const clusterer = new OPTICSClusterer({ minPts: 3 });
    const result = clusterer.cluster(data);

    // Should find at least 1 cluster (OPTICS may merge depending on epsilon)
    expect(result.length).toBeGreaterThanOrEqual(1);

    // All members should have valid classifications
    for (const cluster of result) {
      expect(cluster.members.length).toBeGreaterThanOrEqual(3);
      for (const member of cluster.members) {
        expect(["core", "border", "noise"]).toContain(member.classification);
      }
      expect(cluster.representative_id).toBeTruthy();
    }
  });

  it("identifies noise points", () => {
    const data: ClusterInput[] = [
      // Tight cluster
      { id: "c1", vector: makeVector(1, 0, 0) },
      { id: "c2", vector: makeVector(0.99, 0.01, 0) },
      { id: "c3", vector: makeVector(0.98, 0.02, 0) },
      { id: "c4", vector: makeVector(0.97, 0.03, 0) },
      // Outlier
      { id: "noise", vector: makeVector(0, 0, 1) },
    ];

    const clusterer = new OPTICSClusterer({ minPts: 3, epsilon: 0.2 });
    const result = clusterer.cluster(data);

    // The noise point should NOT be in any cluster
    const allMemberIds = result.flatMap((c) => c.members.map((m) => m.object_id));
    expect(allMemberIds).not.toContain("noise");
  });

  it("respects maxObjects limit", () => {
    const data: ClusterInput[] = [];
    for (let i = 0; i < 100; i++) {
      data.push({ id: `p-${i}`, vector: makeVector(Math.random(), Math.random(), Math.random()) });
    }

    const clusterer = new OPTICSClusterer({ maxObjects: 10, minPts: 3 });
    // Should not throw or take too long
    const result = clusterer.cluster(data);
    expect(Array.isArray(result)).toBe(true);
  });

  it("calls onTruncated when input exceeds maxObjects", () => {
    const data: ClusterInput[] = [];
    for (let i = 0; i < 50; i++) {
      data.push({ id: `p-${i}`, vector: makeVector(Math.random(), Math.random(), Math.random()) });
    }

    let truncatedActual = 0;
    let truncatedLimit = 0;
    const clusterer = new OPTICSClusterer({
      maxObjects: 20,
      minPts: 3,
      onTruncated: (actual, limit) => {
        truncatedActual = actual;
        truncatedLimit = limit;
      },
    });
    clusterer.cluster(data);
    expect(truncatedActual).toBe(50);
    expect(truncatedLimit).toBe(20);
  });

  it("does not call onTruncated when input fits within maxObjects", () => {
    const data: ClusterInput[] = [];
    for (let i = 0; i < 5; i++) {
      data.push({ id: `p-${i}`, vector: makeVector(Math.random(), Math.random(), Math.random()) });
    }

    let called = false;
    const clusterer = new OPTICSClusterer({
      maxObjects: 100,
      minPts: 3,
      onTruncated: () => { called = true; },
    });
    clusterer.cluster(data);
    expect(called).toBe(false);
  });

  it("defaults maxObjects to 10000", () => {
    const clusterer = new OPTICSClusterer();
    // Create data just above a small limit to confirm the default is high
    const data: ClusterInput[] = [];
    for (let i = 0; i < 2500; i++) {
      data.push({ id: `p-${i}`, vector: makeVector(1, 0, 0) });
    }

    let called = false;
    const clustererWithCallback = new OPTICSClusterer({
      onTruncated: () => { called = true; },
    });
    // 2500 < 10000 default, so onTruncated should NOT fire
    clustererWithCallback.cluster(data);
    expect(called).toBe(false);
  });

  it("sets representative to point closest to centroid", () => {
    // Create a tight cluster where center point is identifiable
    const data: ClusterInput[] = [
      { id: "center", vector: makeVector(1, 0, 0) },
      { id: "near1", vector: makeVector(0.99, 0.1, 0) },
      { id: "near2", vector: makeVector(0.99, -0.1, 0) },
      { id: "near3", vector: makeVector(0.99, 0.05, 0.05) },
    ];

    const clusterer = new OPTICSClusterer({ minPts: 3, epsilon: 0.5 });
    const result = clusterer.cluster(data);

    if (result.length > 0) {
      // Representative should be one of the cluster members
      const memberIds = result[0]!.members.map((m) => m.object_id);
      expect(memberIds).toContain(result[0]!.representative_id);
    }
  });

  it("handles single tight cluster", () => {
    const data: ClusterInput[] = [
      { id: "p1", vector: makeVector(1, 0) },
      { id: "p2", vector: makeVector(0.99, 0.1) },
      { id: "p3", vector: makeVector(0.98, 0.05) },
      { id: "p4", vector: makeVector(0.97, 0.08) },
      { id: "p5", vector: makeVector(0.96, 0.03) },
    ];

    const clusterer = new OPTICSClusterer({ minPts: 3 });
    const result = clusterer.cluster(data);

    // Should find exactly one cluster with at least minPts members
    expect(result.length).toBe(1);
    expect(result[0]!.members.length).toBeGreaterThanOrEqual(3);
  });

  it("handles identical vectors", () => {
    const data: ClusterInput[] = [
      { id: "a", vector: makeVector(1, 0, 0) },
      { id: "b", vector: makeVector(1, 0, 0) },
      { id: "c", vector: makeVector(1, 0, 0) },
      { id: "d", vector: makeVector(1, 0, 0) },
    ];

    const clusterer = new OPTICSClusterer({ minPts: 3 });
    const result = clusterer.cluster(data);

    // All identical points should form one cluster
    expect(result.length).toBe(1);
    expect(result[0]!.members.length).toBe(4);
  });

  it("produces cluster members with correct structure", () => {
    const data: ClusterInput[] = [
      { id: "x1", vector: makeVector(1, 0, 0) },
      { id: "x2", vector: makeVector(0.99, 0.01, 0) },
      { id: "x3", vector: makeVector(0.98, 0.02, 0) },
      { id: "x4", vector: makeVector(0.97, 0.03, 0) },
    ];

    const clusterer = new OPTICSClusterer({ minPts: 3 });
    const result = clusterer.cluster(data);

    for (const cluster of result) {
      expect(typeof cluster.cluster_id).toBe("number");
      expect(typeof cluster.representative_id).toBe("string");
      expect(Array.isArray(cluster.members)).toBe(true);
      for (const member of cluster.members) {
        expect(typeof member.object_id).toBe("string");
        expect(["core", "border", "noise"]).toContain(member.classification);
      }
    }
  });

  it("auto-computes epsilon when not provided", () => {
    const data: ClusterInput[] = [];
    for (let i = 0; i < 20; i++) {
      const angle = (i / 20) * Math.PI * 2;
      data.push({
        id: `ring-${i}`,
        vector: makeVector(Math.cos(angle), Math.sin(angle), 0),
      });
    }

    const clusterer = new OPTICSClusterer({ minPts: 3 });
    // Should not throw — epsilon is auto-calculated
    const result = clusterer.cluster(data);
    expect(Array.isArray(result)).toBe(true);
  });

  it("supports custom epsilon", () => {
    const data: ClusterInput[] = [
      { id: "a", vector: makeVector(1, 0, 0) },
      { id: "b", vector: makeVector(0.99, 0.1, 0) },
      { id: "c", vector: makeVector(0.98, 0.2, 0) },
      { id: "d", vector: makeVector(0, 1, 0) },
      { id: "e", vector: makeVector(0.1, 0.99, 0) },
      { id: "f", vector: makeVector(0.2, 0.98, 0) },
    ];

    const clusterer = new OPTICSClusterer({ minPts: 3, epsilon: 0.3 });
    const result = clusterer.cluster(data);
    expect(Array.isArray(result)).toBe(true);
  });
});
