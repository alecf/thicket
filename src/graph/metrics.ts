import { compareStrings } from "../order.js";

/**
 * Tarjan's algorithm. Nodes are visited in sorted order and each component's
 * members are sorted, so output is identical regardless of input ordering --
 * required for a diffable report (PRD §9.4).
 *
 * Recursive. Depth is bounded by the longest simple path in the module graph,
 * which on the `auto` path is at most 64 nodes; even `granularity: "file"`
 * bounds it by the import depth of the repo, not by file count. The iterative
 * rewrite waits for a profile that says it is needed.
 */
export function stronglyConnected(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of [...(adjacency.get(v) ?? [])].sort(compareStrings)) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }

    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      out.push(component.sort(compareStrings));
    }
  };

  for (const v of [...nodes].sort(compareStrings)) if (!index.has(v)) strong(v);
  return out.sort((a, b) => compareStrings(a[0]!, b[0]!));
}

/**
 * Baldwin/MacCormack propagation cost: the density of the transitive closure.
 * The fraction of the system reachable from an average node -- i.e. the share
 * of the codebase a random change can potentially affect.
 *
 * Recursive, with the same depth bound as `stronglyConnected` above; the
 * `seen` set also makes each node's DFS visit every other node at most once.
 */
export function propagationCost(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): number {
  const n = nodes.length;
  if (n === 0) return 0;
  const idx = new Map(nodes.map((m, i) => [m, i]));
  const reach = nodes.map(() => new Set<number>());

  const dfs = (start: number, v: string, seen: Set<number>): void => {
    for (const w of adjacency.get(v) ?? []) {
      const j = idx.get(w);
      if (j === undefined || seen.has(j)) continue;
      seen.add(j);
      dfs(start, w, seen);
    }
  };
  nodes.forEach((v, i) => dfs(i, v, reach[i]!));

  const total = reach.reduce((sum, s) => sum + s.size, 0);
  return total / (n * n);
}
