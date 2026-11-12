import { compareStrings } from "../order.js";
import { stronglyConnected } from "./metrics.js";
import type { Packages } from "./packages.js";

/**
 * Which of a finding's own files must not hold the shared version.
 *
 * The obvious home for extracted code is the file of one of the copies. Two
 * things make that home wrong, and neither shows in the finding:
 *
 *  - **A cycle.** The other copies would import the home. If the home already
 *    reaches one of them, that import closes a cycle, or grows one.
 *  - **A package boundary.** Another copy sits in a package that cannot
 *    import the home's package.
 *
 * thicket warns and does not suggest. The prototype that picked a home was
 * rated right 55% of the time by blind judges, below the 70% bar: judges
 * wanted a purpose-named new file, which the import graph cannot name. The
 * same judges rated 88% of the homes this check flags as wrong. See
 * docs/plans/2026-11-11-placement.md.
 */

export type AvoidReason =
  /** The home already reaches `with`, a file holding another copy. */
  | { kind: "cycle"; with: string }
  /** Module `from` would import module `to`, which already reaches it. */
  | { kind: "module-cycle"; from: string; to: string }
  /** Package `from` holds another copy and cannot import the home's package. */
  | { kind: "package"; from: string };

export interface AvoidHome {
  file: string;
  reason: AvoidReason;
}

export interface Placement {
  /** Copy files that must not hold the shared version, sorted by path. */
  avoid: AvoidHome[];
  /** The distinct packages the copies sit in, sorted. */
  packages: string[];
  /** How many copy files were checked, and how many there are. */
  checked: number;
  files: number;
}

export interface PlacementGraphInput {
  files: readonly string[];
  importsOf(path: string): readonly string[];
  moduleOf(path: string): string | undefined;
  modules: readonly string[];
  moduleAdjacency: ReadonlyMap<string, readonly string[]>;
  packages: Packages;
}

export interface PlacementGraph extends PlacementGraphInput {
  /** The id of the file cycle `path` is in, or undefined when it is in none. */
  fileComponent(path: string): number | undefined;
  moduleComponent(module: string): number | undefined;
  /**
   * Which of `targets` the file `from` reaches through imports. The walk runs
   * over the graph of cycles, with each cycle one node, so a 700-file cycle
   * costs one step instead of 700.
   */
  reachedFrom(from: string, targets: readonly string[]): Set<string>;
}

/** Index the cycles once, so each finding's check is a walk and no more. */
export function placementGraph(input: PlacementGraphInput): PlacementGraph {
  const componentIndex = (nodes: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>) => {
    const out = new Map<string, number>();
    stronglyConnected(nodes, adjacency).forEach((scc, i) => {
      if (scc.length > 1) for (const n of scc) out.set(n, i);
    });
    return out;
  };
  const fileAdjacency = new Map(input.files.map((f) => [f, input.importsOf(f)]));
  const fileComponents = new Map<string, number>();
  const componentOf = new Map<string, number>();
  stronglyConnected(input.files, fileAdjacency).forEach((scc, i) => {
    for (const n of scc) {
      componentOf.set(n, i);
      if (scc.length > 1) fileComponents.set(n, i);
    }
  });
  // The graph of cycles: component -> the components it imports, deduplicated.
  const condensed = new Map<number, number[]>();
  for (const [from, tos] of fileAdjacency) {
    const a = componentOf.get(from)!;
    const out = new Set(condensed.get(a) ?? []);
    for (const to of tos) {
      const b = componentOf.get(to);
      if (b !== undefined && b !== a) out.add(b);
    }
    condensed.set(a, [...out]);
  }
  const moduleComponents = componentIndex(input.modules, input.moduleAdjacency);
  return {
    ...input,
    // Read once here: the checks ask for the same files' imports many times.
    importsOf: (p) => fileAdjacency.get(p) ?? input.importsOf(p),
    fileComponent: (p) => fileComponents.get(p),
    moduleComponent: (m) => moduleComponents.get(m),
    reachedFrom(from, targets) {
      const start = componentOf.get(from);
      const wanted = new Map<number, string[]>();
      for (const t of targets) {
        const c = componentOf.get(t);
        if (c === undefined) continue;
        wanted.set(c, [...(wanted.get(c) ?? []), t]);
      }
      const hit = new Set<string>();
      if (start === undefined || wanted.size === 0) return hit;
      const seen = new Set<number>([start]);
      const queue = [start];
      let found = 0;
      while (queue.length > 0 && found < wanted.size) {
        for (const m of condensed.get(queue.pop()!) ?? []) {
          if (seen.has(m)) continue;
          seen.add(m);
          const ts = wanted.get(m);
          if (ts !== undefined) {
            found++;
            for (const t of ts) hit.add(t);
          }
          queue.push(m);
        }
      }
      return hit;
    },
  };
}

/**
 * Copy files checked per finding. Each check walks the import graph from one
 * file, and a finding can span a hundred files. A finding over more files
 * says how many it checked.
 */
export const MAX_HOMES_CHECKED = 24;

/** Everything `from` reaches through `next`, stopping once every target is found. */
function reached(
  from: string,
  next: (n: string) => readonly string[],
  targets: ReadonlySet<string>,
): Set<string> {
  const hit = new Set<string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0 && hit.size < targets.size) {
    const n = queue.pop()!;
    for (const m of next(n)) {
      if (seen.has(m)) continue;
      seen.add(m);
      if (targets.has(m)) hit.add(m);
      queue.push(m);
    }
  }
  return hit;
}

export function placementOf(
  copyFiles: readonly string[],
  g: PlacementGraph,
  maxHomes: number = MAX_HOMES_CHECKED,
): Placement {
  const files = [...new Set(copyFiles)].sort(compareStrings);
  const homes = files.slice(0, maxHomes);
  const packages = [...new Set(files.map((f) => g.packages.of(f)))].sort(compareStrings);
  const avoid: AvoidHome[] = [];

  for (const home of homes) {
    const others = files.filter((f) => f !== home);
    // An edge that already exists changes nothing, and neither does one inside
    // a cycle the two files already share.
    const sameCycle = (u: string) => {
      const c = g.fileComponent(home);
      return c !== undefined && c === g.fileComponent(u);
    };
    const newEdgeFrom = others.filter((u) => !g.importsOf(u).includes(home) && !sameCycle(u));
    const fileHit = g.reachedFrom(home, newEdgeFrom);
    const closes = newEdgeFrom.filter((u) => fileHit.has(u));
    if (closes.length > 0) {
      avoid.push({ file: home, reason: { kind: "cycle", with: closes[0]! } });
      continue;
    }

    // The same question one level up. The report's tangle section counts
    // module cycles, and a file path is not needed to close one.
    const to = g.moduleOf(home);
    if (to !== undefined) {
      const sameModuleCycle = (m: string) => {
        const c = g.moduleComponent(to);
        return c !== undefined && c === g.moduleComponent(m);
      };
      const fromModules = [
        ...new Set(
          others
            .map((u) => g.moduleOf(u))
            .filter((m): m is string => m !== undefined && m !== to)
            .filter((m) => !(g.moduleAdjacency.get(m) ?? []).includes(to) && !sameModuleCycle(m)),
        ),
      ].sort(compareStrings);
      const moduleHit = reached(to, (m) => g.moduleAdjacency.get(m) ?? [], new Set(fromModules));
      const from = fromModules.find((m) => moduleHit.has(m));
      if (from !== undefined) {
        avoid.push({ file: home, reason: { kind: "module-cycle", from, to } });
        continue;
      }
    }

    const homePackage = g.packages.of(home);
    const blocked = [...new Set(others.map((u) => g.packages.of(u)))]
      .sort(compareStrings)
      .find((p) => !g.packages.canImport(p, homePackage));
    if (blocked !== undefined) avoid.push({ file: home, reason: { kind: "package", from: blocked } });
  }

  return { avoid, packages, checked: homes.length, files: files.length };
}
