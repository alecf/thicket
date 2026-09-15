import { compareStrings } from "../order.js";
import { dirParts, groupByDepth } from "./grouping.js";

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

/**
 * One workspace's share of the analyzed files. `dir` is its repo-relative
 * POSIX directory, or `""` for the files that belong to no workspace -- a root
 * config's own sources, typically a `scripts/` or `tools/` tree.
 */
export interface WorkspaceGroup {
  dir: string;
  paths: readonly string[];
}

/**
 * Label for the per-workspace path. Constant, unlike `dir:N`, because the
 * depth now differs per workspace and no single number describes the run.
 */
const ACROSS_LABEL = "workspace";

/** The module a path belongs to at `depth` directories below its workspace. */
function moduleNameAt(dir: string, path: string, depth: number): string {
  const below = dir === "" ? path : path.slice(dir.length + 1);
  const name = [dir, ...dirParts(below).slice(0, depth)].filter((s) => s.length > 0).join("/");
  return name === "" ? "<root>" : name;
}

/**
 * Split `paths` by the workspace that owns each one.
 *
 * Ownership is the LONGEST directory containing the file, so a workspace
 * nested inside another (`deep/a/b/gamma` under `deep/a`) keeps its own files
 * rather than donating them upward. Containment is tested with a trailing
 * separator, so `pack` never claims a file in `package` -- the same
 * whole-segment rule the root pin uses, and the same trap.
 *
 * Groups come back sorted by directory with the root group last, and a group
 * with no analyzed file is dropped rather than emitted empty: a workspace
 * `--filter` excluded contributes no module, which is what makes the remaining
 * workspaces' names independent of it.
 */
export function workspaceGroups(
  paths: readonly string[],
  dirs: readonly string[],
): WorkspaceGroup[] {
  // Longest first so the nested workspace is found before its parent. Ties
  // break by name, which cannot change any assignment -- two directories of
  // equal length cannot both contain one path -- and keeps the scan canonical.
  const byLength = [...new Set(dirs)].sort(
    (a, b) => b.length - a.length || compareStrings(a, b),
  );
  const owned = new Map<string, string[]>(byLength.map((d) => [d, []]));
  const rootGroup: string[] = [];
  for (const path of paths) {
    const owner = byLength.find((d) => path.startsWith(`${d}/`));
    if (owner === undefined) rootGroup.push(path);
    else owned.get(owner)!.push(path);
  }
  const groups = [...owned]
    .map(([dir, ws]) => ({ dir, paths: ws }))
    .filter((g) => g.paths.length > 0)
    .sort((a, b) => compareStrings(a.dir, b.dir));
  return rootGroup.length > 0 ? [...groups, { dir: "", paths: rootGroup }] : groups;
}

/**
 * Pick a directory depth per workspace so that every module, in any workspace,
 * holds roughly the same number of files.
 *
 * One depth for the whole tree makes a large workspace's subdirectory a peer
 * of a small workspace's entire source tree -- the "peers at different scales"
 * failure directory depth already has within a single project, which a
 * monorepo reproduces at the top level. Measured on the fixture in
 * `tests/granularity.test.ts`: 400 files in one workspace beside 12 in
 * another, one global depth gives modules of 20 files and modules of 1; a
 * depth per workspace gives 20 and 12.
 *
 * Two properties matter more than the split itself, because `UB-CYC-*` ids
 * derive from module names (PRD §9.1) and a report is read by diffing it
 * against the last one:
 *
 * - **The target is a property of the repository, not of the run.** Hence
 *   `repoFileCount` rather than a count of `groups`: `--filter` down to one
 *   workspace would otherwise shrink the target and re-cut the workspace that
 *   survived the filter. Omitting it falls back to the analyzed set, which is
 *   right for a caller that has no other number and wrong for a filtered run.
 * - **No prefix is stripped across workspaces.** `groupByDepth` drops the
 *   longest common directory prefix, so a repo whose workspaces all sit under
 *   `pkg/` names its modules `big/src/g0`, and adding one workspace outside
 *   `pkg/` renames every one of them to `pkg/big/src/g0`. A workspace
 *   directory is a semantic boundary, so it stays in the name.
 *
 * Depth 0 -- the whole workspace as one module -- is on the ladder, and is the
 * answer for every workspace smaller than the target. A monorepo of one large
 * app and a dozen small packages is the common shape (~88% of the source in
 * one workspace in both samples measured), so this is mostly what the function
 * does.
 */
export function selectGranularityAcross(
  groups: readonly WorkspaceGroup[],
  repoFileCount?: number,
  maxDepth = 6,
): Granularity {
  const analyzed = groups.reduce((n, g) => n + g.paths.length, 0);
  const basis = repoFileCount !== undefined && repoFileCount > 0 ? repoFileCount : analyzed;
  // Same target the single-project ladder aims at, read as a size rather than
  // a count: how many files one module should hold anywhere in the repo.
  const targetSize =
    basis / Math.min(MAX_MODULES, Math.max(MIN_MODULES, Math.round(Math.sqrt(basis))));

  const moduleOf: Record<string, string> = {};
  for (const group of [...groups].sort((a, b) => compareStrings(a.dir, b.dir))) {
    const paths = [...group.paths].sort(compareStrings);
    // Seeded rather than left undefined so a group with no analyzed file --
    // which a `--filter` produces, and which `workspaceGroups` drops before it
    // gets here -- contributes nothing instead of needing a guard of its own.
    // Its one candidate compares NaN, and NaN is never the strictly better
    // distance.
    let best: Record<string, string> = {};
    let bestDistance = Infinity;
    for (let depth = 0; depth <= maxDepth; depth++) {
      const candidate: Record<string, string> = {};
      for (const p of paths) candidate[p] = moduleNameAt(group.dir, p, depth);
      const count = new Set(Object.values(candidate)).size;
      // Strictly-better wins, so the coarsest depth is preferred on ties --
      // the same rule `selectGranularity` uses, and what keeps a workspace
      // whose files share one directory named after the workspace.
      const distance = Math.abs(paths.length / count - targetSize);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
      if (count >= paths.length) break; // finer depths cannot help
    }
    Object.assign(moduleOf, best);
  }
  return {
    label: ACROSS_LABEL,
    moduleCount: new Set(Object.values(moduleOf)).size,
    moduleOf,
  };
}
