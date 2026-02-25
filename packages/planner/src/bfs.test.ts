import { describe, it, expect } from "vitest";
import { bfsPath } from "./bfs.js";

describe("bfsPath", () => {
  const simpleGraph: Record<string, Record<string, string>> = {
    "Room A": { north: "Room B", east: "Room C" },
    "Room B": { south: "Room A", east: "Room D" },
    "Room C": { west: "Room A" },
    "Room D": { west: "Room B" },
  };

  it("returns [] when start equals target", () => {
    expect(bfsPath(simpleGraph, "Room A", "Room A")).toEqual([]);
  });

  it("returns [] when start or target is empty", () => {
    expect(bfsPath(simpleGraph, "", "Room A")).toEqual([]);
    expect(bfsPath(simpleGraph, "Room A", "")).toEqual([]);
  });

  it("finds a direct one-step path", () => {
    const path = bfsPath(simpleGraph, "Room A", "Room B");
    expect(path).toEqual([{ direction: "north", destination: "Room B" }]);
  });

  it("finds a multi-step shortest path", () => {
    const path = bfsPath(simpleGraph, "Room A", "Room D");
    expect(path).toEqual([
      { direction: "north", destination: "Room B" },
      { direction: "east", destination: "Room D" },
    ]);
  });

  it("returns null for unreachable targets", () => {
    // Room C → Room A → Room B → Room D is reachable in simpleGraph,
    // so use a disconnected graph instead
    const disconnected: Record<string, Record<string, string>> = {
      "A": { east: "B" },
      "B": {},
      "C": { east: "D" },
      "D": {},
    };
    const path = bfsPath(disconnected, "A", "D");
    expect(path).toBeNull();
  });

  it("returns null when target is not in the graph at all", () => {
    const path = bfsPath(simpleGraph, "Room A", "Room Z");
    expect(path).toBeNull();
  });

  it("returns null when start has no edges", () => {
    const graph = { "Isolated": {} };
    expect(bfsPath(graph, "Isolated", "Room A")).toBeNull();
  });

  it("handles blocked directions (array format)", () => {
    const blocked = { "Room A": ["north"] };
    const path = bfsPath(simpleGraph, "Room A", "Room B", blocked);
    // north is blocked, so must go Room A → east → Room C ... but Room C can't reach Room B
    expect(path).toBeNull();
  });

  it("handles blocked directions (Set format)", () => {
    const blocked = { "Room A": new Set(["north"]) };
    const path = bfsPath(simpleGraph, "Room A", "Room B", blocked);
    expect(path).toBeNull();
  });

  it("finds an alternate path when primary is blocked", () => {
    // Diamond graph: A→B (north), A→C (east), B→D (east), C→D (north)
    const diamond: Record<string, Record<string, string>> = {
      "A": { north: "B", east: "C" },
      "B": { east: "D" },
      "C": { north: "D" },
      "D": {},
    };
    const blocked = { "A": ["north"] };
    const path = bfsPath(diamond, "A", "D", blocked);
    expect(path).toEqual([
      { direction: "east", destination: "C" },
      { direction: "north", destination: "D" },
    ]);
  });

  it("handles cycles without infinite loops", () => {
    const cyclic: Record<string, Record<string, string>> = {
      "A": { east: "B" },
      "B": { east: "C" },
      "C": { east: "A", north: "D" },
      "D": {},
    };
    const path = bfsPath(cyclic, "A", "D");
    expect(path).toEqual([
      { direction: "east", destination: "B" },
      { direction: "east", destination: "C" },
      { direction: "north", destination: "D" },
    ]);
  });

  it("handles empty graph", () => {
    expect(bfsPath({}, "A", "B")).toBeNull();
  });

  it("handles start not in graph (no edges for start)", () => {
    expect(bfsPath(simpleGraph, "Unknown", "Room A")).toBeNull();
  });

  it("finds shortest path when multiple paths exist", () => {
    // A→B (1 step) and A→C→D→B (3 steps)
    const multi: Record<string, Record<string, string>> = {
      "A": { north: "B", east: "C" },
      "B": {},
      "C": { north: "D" },
      "D": { west: "B" },
    };
    const path = bfsPath(multi, "A", "B");
    expect(path).toHaveLength(1);
    expect(path).toEqual([{ direction: "north", destination: "B" }]);
  });
});
