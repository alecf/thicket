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
  sharedImports: string[];
  /** Files outside the cluster that import one of its files. */
  dependents: number;
}

/** File -> files it imports, and the reverse. Built once per run. */
export interface ImportIndex {
  imports: ReadonlyMap<string, readonly string[]>;
  importers: ReadonlyMap<string, readonly string[]>;
}

export function buildImportIndex(
  files: readonly string[],
  importsOf: (file: string) => readonly string[],
): ImportIndex {
  const imports = new Map<string, readonly string[]>();
  const importers = new Map<string, string[]>();
  for (const file of files) {
    const targets = importsOf(file);
    imports.set(file, targets);
    for (const target of targets) {
      const list = importers.get(target);
      if (list) list.push(file);
      else importers.set(target, [file]);
    }
  }
  return { imports, importers };
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
  const dependents = new Set<string>();
  for (const file of clusterFiles) {
    for (const importer of index.importers.get(file) ?? []) {
      if (!inCluster.has(importer)) dependents.add(importer);
    }
  }

  return { sharedImports: sharedImports(clusterFiles, index, fileCount, inCluster), dependents: dependents.size };
}

function sharedImports(
  clusterFiles: readonly string[],
  index: ImportIndex,
  fileCount: number,
  inCluster: ReadonlySet<string>,
): string[] {
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
    .slice(0, MAX_SHARED_IMPORTS);
}
