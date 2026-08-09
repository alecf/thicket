import type { Project } from "../extract/ts-adapter.js";
import { compareStrings } from "../order.js";
import { selectGranularity } from "./granularity.js";
import { groupByDepth } from "./grouping.js";

export interface ModuleEdge {
  from: string;
  to: string;
  /**
   * Distinct symbols the `from` module imports out of the `to` module,
   * summed over its files. Counting imports instead would make nearly every
   * weight 1 and lose the difference between pulling one constant and pulling
   * thirty (PRD §7.2).
   */
  weight: number;
}

export interface ModuleGraph {
  granularity: string;
  modules: string[];
  edges: ModuleEdge[];
  adjacency: Map<string, string[]>;
  moduleOf: Record<string, string>;
}

export interface GraphOptions {
  /** `auto` selects per PRD §7.1; a number forces that directory depth. */
  granularity?: "auto" | "file" | number;
}

/**
 * Separator for the composite (from, to) map key. NUL cannot occur in a path
 * segment on any supported platform, so the key round-trips unambiguously even
 * for a module name containing spaces or slashes. Written as an escape: a raw
 * NUL byte in the source is invisible in every diff and editor.
 */
const KEY_SEP = "\u0000";

export function buildModuleGraph(project: Project, opts: GraphOptions = {}): ModuleGraph {
  const paths = project.files().map((f) => f.path);

  let moduleOf: Record<string, string>;
  let label: string;
  const g = opts.granularity ?? "auto";
  if (g === "file") {
    moduleOf = Object.fromEntries(paths.map((p) => [p, p]));
    label = "file";
  } else if (typeof g === "number") {
    moduleOf = groupByDepth(paths, g);
    label = `dir:${g}`;
  } else {
    const chosen = selectGranularity(paths);
    moduleOf = chosen.moduleOf;
    label = chosen.label;
  }

  const weights = new Map<string, number>();
  for (const file of project.files()) {
    const from = moduleOf[file.path]!;
    for (const { target, symbols } of project.importDetailsOf(file)) {
      const to = moduleOf[target];
      // An import of a file outside the analyzed set has no module.
      if (to === undefined) continue;
      // Intra-module imports are not tangle: grouping is precisely the claim
      // that those files belong together.
      if (to === from) continue;
      const key = `${from}${KEY_SEP}${to}`;
      weights.set(key, (weights.get(key) ?? 0) + symbols);
    }
  }

  const modules = [...new Set(Object.values(moduleOf))].sort(compareStrings);
  const edges: ModuleEdge[] = [...weights.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split(KEY_SEP) as [string, string];
      return { from, to, weight };
    })
    .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));

  const adjacency = new Map<string, string[]>(modules.map((m) => [m, []]));
  for (const e of edges) adjacency.get(e.from)!.push(e.to);

  return { granularity: label, modules, edges, adjacency, moduleOf };
}
