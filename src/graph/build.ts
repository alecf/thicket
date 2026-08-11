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
   * The single file most of this edge's weight lands on, and how much.
   *
   * An edge is a bare number until you know whether it is one import or two
   * hundred spread over a package. On a real 12-module tangle `actions → app`
   * was 45 import sites ALL landing on one re-export file -- a single
   * specifier rewrite that deletes the edge outright -- while a 3-site edge
   * was three unrelated hooks and a redesign. The cut chooser, ranking by
   * weight, preferred the second.
   */
  topTarget: { path: string; weight: number };
  /**
   * How much of this edge is not a dependency on `to` at all, but on something
   * `to` re-exports.
   *
   * Such an edge can be DISSOLVED rather than cut: repoint the specifier at the
   * origin and it disappears, with no semantic change, because a re-export is
   * the same binding. That is strictly cheaper than any cut, which needs a
   * design decision. On a real 12-module tangle four inbound edges to one
   * module were 100% this.
   */
  passThrough: number;
  /** Where most of that forwarded weight actually comes from. */
  origin?: string;
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

/**
 * The heaviest imported file on an edge. Ties break by path so the answer is a
 * function of the graph and not of file iteration order (AGENTS.md §1).
 */
function topTargetOf(targets: ReadonlyMap<string, number>): { path: string; weight: number } {
  let best = { path: "", weight: 0 };
  for (const [path, weight] of [...targets].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (weight > best.weight) best = { path, weight };
  }
  return best;
}

/** Most frequent origin, ties broken by path so the answer is stable. */
function commonestOrigin(origins: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const o of origins) counts.set(o, (counts.get(o) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [path, count] of [...counts].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (count > bestCount) {
      best = path;
      bestCount = count;
    }
  }
  return best;
}

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
    {
      weight: number;
      erased: number;
      files: Set<string>;
      typeOnly: boolean;
      /** Weight per imported FILE, so the edge can name where it concentrates. */
      targets: Map<string, number>;
      passThrough: number;
      origins: string[];
    }
  >();
  for (const file of project.files()) {
    const from = moduleOf[file.path]!;
    for (const detail of project.importDetailsOf(file)) {
      const { target, symbols, erased, erasable } = detail;
      const to = moduleOf[target];
      // An import of a file outside the analyzed set has no module.
      if (to === undefined) continue;
      // Intra-module imports are not tangle: grouping is precisely the claim
      // that those files belong together.
      if (to === from) continue;
      const key = `${from}${KEY_SEP}${to}`;
      const prior = weights.get(key);
      const targets = prior?.targets ?? new Map<string, number>();
      // A side-effect import binds no names yet is a real edge, so it must
      // still register as a target -- otherwise an edge made only of those has
      // no top target at all.
      targets.set(target, (targets.get(target) ?? 0) + Math.max(symbols, 1));
      weights.set(key, {
        weight: (prior?.weight ?? 0) + symbols,
        erased: (prior?.erased ?? 0) + erased,
        files: (prior?.files ?? new Set<string>()).add(file.path),
        targets,
        passThrough: (prior?.passThrough ?? 0) + detail.passThrough,
        origins:
          detail.origin === undefined
            ? (prior?.origins ?? [])
            : [...(prior?.origins ?? []), detail.origin],
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
        topTarget: topTargetOf(edge.targets),
        passThrough: edge.passThrough,
        ...(edge.origins.length > 0 ? { origin: commonestOrigin(edge.origins) } : {}),
        typeOnly: edge.typeOnly,
      };
    })
    .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));

  const adjacency = new Map<string, string[]>(modules.map((m) => [m, []]));
  for (const e of edges) adjacency.get(e.from)!.push(e.to);

  return { granularity: label, modules, edges, adjacency, moduleOf };
}
