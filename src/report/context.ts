import { compareStrings } from "../order.js";

/**
 * Facts about a duplication cluster's surroundings, which decide whether a
 * finding is a morning's work or a quarter's.
 *
 * Three agents given a report and asked whether its top finding was actionable
 * independently named the same missing fact: the report says "here are 19
 * identical things" and nothing about the code around them. In one case a base
 * class with exactly the right generic factory methods already existed and
 * every copy already imported it, which is the difference between "design a new
 * abstraction" and "delete the overrides". In another the duplicated block was
 * already installed globally by a setup file, making all 115 copies dead code.
 *
 * Neither is derivable from the cluster alone, and both cost one lookup.
 */
export interface FindingContext {
  /**
   * Repo files that EVERY file in the cluster imports, most-specific first.
   *
   * Where the copies' shared vocabulary already lives, which is where an
   * extraction would go — and often where the abstraction already is.
   */
  sharedImports: SharedImport[];
  /** What reaches into the cluster from outside it. */
  dependents: Dependents;
}

export interface SharedImport {
  /** The file the copies actually import. */
  path: string;
  /**
   * Where that file forwards to, when it is a re-export shim standing in front
   * of the real thing.
   *
   * Naming only `path` was the failure this fixes. A real finding named
   * `models/member/vitals/VitalObservation.ts` as the abstraction its 19
   * copies share; that file is nine lines of `export * from`, and the 1012-line
   * base class the whole refactor turns on -- generic static factories already
   * written -- was one hop further on. The field exists to point at the
   * abstraction and it was stopping at the signpost.
   */
  forwardsTo?: string;
}

export interface Dependents {
  /** Files outside the cluster that import one of its files. */
  direct: number;
  /**
   * Further files that reach the cluster only through a re-export barrel among
   * those direct dependents.
   *
   * Without this the count is a floor presented as a total: a real 19-file
   * cluster was reported as reached by 5 files, of which one was an `index.ts`
   * that 17 more files went through. "5 files" reads as contained; it was not.
   */
  throughBarrels: number;
  /** The barrels responsible, sorted and capped. */
  barrels: string[];
}

/** File -> files it imports, the reverse, and which files are pure forwarders. */
export interface ImportIndex {
  imports: ReadonlyMap<string, readonly string[]>;
  importers: ReadonlyMap<string, readonly string[]>;
  /**
   * File -> what it re-exports, for files that ONLY re-export. Empty for a file
   * that declares anything of its own, because then what the copies share may
   * be the part it declares rather than the part it forwards.
   */
  reexports: ReadonlyMap<string, readonly string[]>;
}

export function buildImportIndex(
  files: readonly string[],
  importsOf: (file: string) => readonly string[],
  reexportsOf: (file: string) => readonly string[] = () => [],
): ImportIndex {
  const imports = new Map<string, readonly string[]>();
  const importers = new Map<string, string[]>();
  const reexports = new Map<string, readonly string[]>();
  for (const file of files) {
    const targets = importsOf(file);
    imports.set(file, targets);
    const forwarded = reexportsOf(file);
    if (forwarded.length > 0) reexports.set(file, forwarded);
    for (const target of targets) {
      const list = importers.get(target);
      if (list) list.push(file);
      else importers.set(target, [file]);
    }
  }
  return { imports, importers, reexports };
}

/**
 * Shim hops followed before giving up.
 *
 * A bound rather than a cycle check because it is both: two shims that forward
 * to each other terminate here instead of spinning, and three hops is already
 * past any real `export * from` chain -- the deepest observed is two, a
 * package barrel in front of a workspace re-export.
 */
const MAX_SHIM_HOPS = 3;

/**
 * The module a re-export shim stands in front of, or `undefined` if `path` is
 * not one.
 *
 * A shim forwards exactly one module and imports nothing else. A barrel that
 * forwards thirty is not followed: there is no single module it stands for, and
 * naming one of the thirty would be a guess dressed as a fact.
 */
function forwardTarget(path: string, index: ImportIndex): string | undefined {
  let current = path;
  for (let hop = 0; hop < MAX_SHIM_HOPS; hop++) {
    const forwarded = index.reexports.get(current);
    if (forwarded?.length !== 1) break;
    const next = forwarded[0]!;
    if (next === path) break; // forwards back to where we started
    current = next;
  }
  return current === path ? undefined : current;
}

/** True when every import this file makes is something it re-exports. */
function isBarrel(path: string, index: ImportIndex): boolean {
  return (index.reexports.get(path)?.length ?? 0) > 0;
}

/**
 * Shared imports named before the rest are dropped.
 *
 * A pointer, not an inventory: the reader needs to know the shared base class
 * exists, and three entries is enough to say so without turning a finding into
 * a dependency listing.
 */
const MAX_SHARED_IMPORTS = 3;

/**
 * Share of the codebase OUTSIDE the cluster above which a common import says
 * nothing.
 *
 * A module imported by most of the repository -- a logger, a `cn()` helper, the
 * framework's own re-export barrel -- is common to every cluster and therefore
 * distinguishes none of them. The fact worth printing is "these copies share
 * something the rest of the codebase does not", so the measure has to exclude
 * the copies: they all import it by construction, and counting them makes a
 * cluster of 3 files in a repo of 6 suppress its own answer.
 */
const UBIQUITY_LIMIT = 0.2;

export function findingContext(
  clusterFiles: readonly string[],
  index: ImportIndex,
  fileCount: number,
): FindingContext {
  const inCluster = new Set(clusterFiles);

  // Files outside the cluster that reach into it. One grep, and it is what
  // turns "this looks big" into "this is contained": a cluster nothing else
  // imports can be rewritten without touching a caller.
  const direct = new Set<string>();
  for (const file of clusterFiles) {
    for (const importer of index.importers.get(file) ?? []) {
      if (!inCluster.has(importer)) direct.add(importer);
    }
  }

  // And what the barrels among them hide. A re-export barrel is one file in
  // the direct count and an arbitrary number of real consumers behind it.
  const barrels = [...direct].filter((d) => isBarrel(d, index)).sort(compareStrings);
  const behind = new Set<string>();
  for (const barrel of barrels) {
    for (const importer of index.importers.get(barrel) ?? []) {
      // Counted once, and never twice: a file importing both the barrel and a
      // member is already in the direct count.
      if (!inCluster.has(importer) && !direct.has(importer)) behind.add(importer);
    }
  }

  return {
    sharedImports: sharedImports(clusterFiles, index, fileCount, inCluster),
    dependents: {
      direct: direct.size,
      throughBarrels: behind.size,
      barrels: barrels.slice(0, MAX_BARRELS_NAMED),
    },
  };
}

/**
 * Barrels named before they are only counted. One is the overwhelmingly common
 * case (a package index); naming more than a couple turns a one-line fact into
 * a listing.
 */
const MAX_BARRELS_NAMED = 2;

function sharedImports(
  clusterFiles: readonly string[],
  index: ImportIndex,
  fileCount: number,
  inCluster: ReadonlySet<string>,
): SharedImport[] {
  // A single file's import list is not something its copies "share" -- it is
  // just that file's imports, and printing it says nothing about the cluster.
  const distinct = new Set(clusterFiles);
  if (distinct.size < 2) return [];

  // No filtering of cluster members here: a member survives the intersection
  // only if EVERY member imports it, itself included, and no file imports
  // itself. Guarding against it would be unreachable code with an untestable
  // guard, which is worse than the case it defends against.
  let common: Set<string> | undefined;
  for (const file of distinct) {
    const targets = new Set(index.imports.get(file) ?? []);
    if (common === undefined) common = targets;
    else for (const target of common) if (!targets.has(target)) common.delete(target);
    if (common.size === 0) return [];
  }

  const ceiling = Math.max(0, fileCount - distinct.size) * UBIQUITY_LIMIT;
  return [...(common ?? [])]
    .filter((target) => {
      const outside = (index.importers.get(target) ?? []).filter((f) => !inCluster.has(f));
      return outside.length <= ceiling;
    })
    .sort(compareStrings)
    .slice(0, MAX_SHARED_IMPORTS)
    .map((path) => {
      const forwardsTo = forwardTarget(path, index);
      return forwardsTo === undefined ? { path } : { path, forwardsTo };
    });
}
