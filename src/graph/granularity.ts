import { groupByDepth } from "./grouping.js";

export interface Granularity {
  label: string; // e.g. "dir:2" or "file"
  moduleCount: number;
  moduleOf: Record<string, string>; // path -> module name
}

const MIN_MODULES = 8;
const MAX_MODULES = 64;

/**
 * Pick the granularity whose module count lands nearest sqrt(file count),
 * clamped to [8, 64].
 *
 * Coarse boundaries (tsconfig project, package.json) bury 76-100% of edges as
 * intra-module and reveal no cycles at all; file granularity produces a large
 * DAG with no cycles either. The useful level sits between, and sqrt(n)
 * predicted it on both repos measured. See PRD §2.6 / §7.1.
 *
 * `file` is the last rung of the candidate ladder (PRD §7.1) and exists for
 * flat layouts: a repo whose sources all sit in one directory groups to
 * exactly one module at EVERY directory depth, and a 1-node graph can express
 * neither an edge nor a cycle. It is evaluated by the same nearest-to-target
 * rule as the depths and, because ties keep the incumbent, only wins when it
 * is strictly closer to the target than every directory depth.
 */
export function selectGranularity(paths: readonly string[], maxDepth = 6): Granularity {
  // No files means no modules; there is nothing for the ladder to measure.
  if (paths.length === 0) return { label: "dir:1", moduleCount: 0, moduleOf: {} };

  const target = Math.min(
    MAX_MODULES,
    Math.max(MIN_MODULES, Math.round(Math.sqrt(paths.length))),
  );

  let best: Granularity | undefined;
  let bestDistance = Infinity;

  const consider = (candidate: Granularity): void => {
    const distance = Math.abs(candidate.moduleCount - target);
    // Strictly-better wins, so the coarsest granularity is preferred on ties.
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  };

  for (let depth = 1; depth <= maxDepth; depth++) {
    const moduleOf = groupByDepth(paths, depth);
    const moduleCount = new Set(Object.values(moduleOf)).size;
    consider({ label: `dir:${depth}`, moduleCount, moduleOf });
    if (moduleCount >= paths.length) break; // finer depths cannot help
  }

  const byFile = Object.fromEntries(paths.map((p) => [p, p]));
  // Counted from the map, not from paths.length, so a repeated path cannot
  // inflate the count above the number of distinct modules.
  consider({ label: "file", moduleCount: Object.keys(byFile).length, moduleOf: byFile });

  return best!;
}
