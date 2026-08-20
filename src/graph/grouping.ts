/**
 * Directory segments of a repo-relative POSIX path, excluding the filename.
 *
 * Segments are compared whole, never as string prefixes, so `repo/pack` and
 * `repo/package` share only `repo`.
 */
const dirParts = (p: string): string[] => {
  const parts = p.split("/");
  parts.pop(); // drop the filename
  return parts.filter((s) => s.length > 0 && s !== ".");
};

/**
 * Longest shared leading directory sequence. Directory-depth grouping must be
 * measured AFTER stripping this, or every path in a monorepo starts with
 * "packages/" and depth-1 grouping yields exactly one module. See PRD §2.4.
 */
export function commonPrefix(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  let prefix = dirParts(paths[0]!);
  for (const p of paths) {
    const parts = dirParts(p);
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

/** Map each path to a module name at the given directory depth. */
export function groupByDepth(paths: readonly string[], depth: number): Record<string, string> {
  const prefix = commonPrefix(paths);
  const out: Record<string, string> = {};
  for (const p of paths) {
    const rest = dirParts(p).slice(prefix.length);
    out[p] = rest.slice(0, depth).join("/") || "<root>";
  }
  return out;
}

/**
 * Group each file under the directory it actually lives in, at whatever depth
 * that is.
 *
 * `groupByDepth` picks one depth N and treats every directory at that depth as
 * a module, erasing all structure below it. On a real application at depth 4
 * that made `src/lib` (1586 files) and `src/stores` (4 files) peers, while
 * `src/lib/services` (328 files) did not exist as a module at all -- and the
 * 22-file runtime cycle inside `src/lib` was invisible, because a cycle that
 * never leaves a module is not a cycle between modules.
 *
 * Depth is not a property of a codebase. A tangle seven directories down is
 * the same tangle as one two directories down, and nothing should treat them
 * differently. The common prefix is still stripped, for the same reason
 * `groupByDepth` strips it: otherwise every module in a monorepo is named
 * `packages/…`.
 */
export function groupByDirectory(paths: readonly string[]): Record<string, string> {
  const prefix = commonPrefix(paths);
  const out: Record<string, string> = {};
  for (const p of paths) {
    out[p] = dirParts(p).slice(prefix.length).join("/") || "<root>";
  }
  return out;
}
