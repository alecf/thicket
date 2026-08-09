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
