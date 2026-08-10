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
  /**
   * Files in `from` that carry the edge, sorted. The weight counts symbols and
   * the work counts files, and the two differ by up to 2x on real edges -- 12
   * symbols across 7 files is seven edits, not twelve. A reader triaging a
   * tangle needs the second number and cannot derive it from the first.
   */
  files: string[];
  /**
   * How many of `weight` are erased at compile time.
   *
   * The count, not just the all-or-nothing verdict below it: a real 7-module
   * tangle carried an edge of 5 bindings that was four `import type`s and one
   * runtime import in a single file. Relocating that file erases the edge
   * entirely, and `typeOnly: false` alone gives the reader no reason to look.
   */
  erased: number;
  /**
   * True when every import making up this edge is erased at compile time.
   *
   * NOT `erased === weight`. A side-effect `import "./x.js"` binds no names, so
   * it contributes nothing to either count and vanishes from that comparison --
   * an edge carrying one of those beside one `import type` would report as
   * erasable, telling a reader a live module-init dependency can be cut by
   * moving a types file.
   * Such an edge is not a runtime dependency at all, so a cycle built from them
   * has no initialization hazard and is usually fixed by moving a types file.
   */
  typeOnly: boolean;
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

  const weights = new Map<
    string,
    { weight: number; erased: number; files: Set<string>; typeOnly: boolean }
  >();
  for (const file of project.files()) {
    const from = moduleOf[file.path]!;
    for (const { target, symbols, erased, erasable } of project.importDetailsOf(file)) {
      const to = moduleOf[target];
      // An import of a file outside the analyzed set has no module.
      if (to === undefined) continue;
      // Intra-module imports are not tangle: grouping is precisely the claim
      // that those files belong together.
      if (to === from) continue;
      const key = `${from}${KEY_SEP}${to}`;
      const prior = weights.get(key);
      weights.set(key, {
        weight: (prior?.weight ?? 0) + symbols,
        erased: (prior?.erased ?? 0) + erased,
        files: (prior?.files ?? new Set<string>()).add(file.path),
        // One runtime import anywhere across the module pair makes the whole
        // edge real, however many type-only imports accompany it.
        typeOnly: (prior?.typeOnly ?? true) && erasable,
      });
    }
  }

  const modules = [...new Set(Object.values(moduleOf))].sort(compareStrings);
  const edges: ModuleEdge[] = [...weights.entries()]
    .map(([key, edge]) => {
      const [from, to] = key.split(KEY_SEP) as [string, string];
      return {
        from,
        to,
        weight: edge.weight,
        files: [...edge.files].sort(compareStrings),
        erased: edge.erased,
        typeOnly: edge.typeOnly,
      };
    })
    .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));

  const adjacency = new Map<string, string[]>(modules.map((m) => [m, []]));
  for (const e of edges) adjacency.get(e.from)!.push(e.to);

  return { granularity: label, modules, edges, adjacency, moduleOf };
}
