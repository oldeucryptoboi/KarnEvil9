/**
 * BFS pathfinding for the interactive fiction room graph.
 *
 * Extracted from scripts/apple2-zork-swarm.ts to be reusable across
 * the IFPlanner and any future navigation component.
 */

export interface BfsStep {
  direction: string;
  destination: string;
}

/**
 * Find the shortest path through a directed room graph using BFS.
 *
 * @param dirGraph  - room → direction → destination room mapping
 * @param start     - current room name
 * @param target    - destination room name
 * @param blocked   - per-room list of permanently blocked directions
 * @returns Array of steps from start to target, null if unreachable, [] if already there
 */
export function bfsPath(
  dirGraph: Record<string, Record<string, string>>,
  start: string,
  target: string,
  blocked: Record<string, string[] | Set<string>> = {},
): BfsStep[] | null {
  if (!start || !target || start === target) return [];
  const queue: Array<{ room: string; path: BfsStep[] }> = [{ room: start, path: [] }];
  const visited = new Set<string>([start]);
  while (queue.length > 0) {
    const { room, path } = queue.shift()!;
    const blockedHere = blocked[room];
    for (const [dir, dest] of Object.entries(dirGraph[room] ?? {})) {
      if (blockedHere && (Array.isArray(blockedHere) ? blockedHere.includes(dir) : blockedHere.has(dir))) continue;
      const newPath: BfsStep[] = [...path, { direction: dir, destination: dest }];
      if (dest === target) return newPath;
      if (!visited.has(dest)) {
        visited.add(dest);
        queue.push({ room: dest, path: newPath });
      }
    }
  }
  return null;
}
