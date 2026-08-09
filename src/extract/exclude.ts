/**
 * Directory names whose contents are generated, vendored, or built rather
 * than written — excluded from analysis by default.
 *
 * Machine-emitted code is duplication by construction: on one test repository
 * the two highest-scoring findings in the entire report were 32 and 14 copies
 * of a framework's emitted type validators. They are not refactorable, and
 * under a report budget they displace real findings one for one.
 *
 * TRADEOFF: `dist`, `build`, `out` and `generated` are plausible names for
 * hand-written source directories. Excluding them is a recall loss for those
 * layouts, accepted because the far commoner case is that they hold build
 * output, and a report dominated by build output is useless in a way that a
 * report missing one directory is not. Two things bound the damage:
 *
 *  1. Matching is on whole path SEGMENTS, never substrings. `src/distance/`,
 *     `src/outbound.ts` and `dist-tags.ts` are all kept — a substring match
 *     would silently drop them.
 *  2. `--include-generated` turns the whole list off, and the report states
 *     its file count, so a run that analyzed too little is visible.
 */
export const GENERATED_DIR_SEGMENTS: readonly string[] = [
  ".cache",
  ".gen",
  ".next",
  ".output",
  ".svelte-kit",
  ".turbo",
  "__generated__",
  "build",
  "coverage",
  "dist",
  "generated",
  "out",
];

const GENERATED = new Set(GENERATED_DIR_SEGMENTS);

/**
 * True when any whole segment of `relPath` names a generated directory.
 *
 * Takes a repo-relative path on purpose. Run against an absolute path this
 * would exclude every file in a checkout that happens to live under a
 * directory called `build`, which is a real way to analyze nothing at all.
 */
export function isGeneratedPath(relPath: string): boolean {
  const segments = relPath.split("/");
  // The last segment is the file name; a file named `dist.ts` is source.
  for (let i = 0; i < segments.length - 1; i++) {
    if (GENERATED.has(segments[i]!)) return true;
  }
  return false;
}
