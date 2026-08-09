import type { Cluster, Occurrence } from "../fingerprint/cluster.js";
import { compareStrings } from "../order.js";

/**
 * Fraction of the corpus covered by at least one *redundant* occurrence.
 *
 * `duplicatedMass` — Σ nodeCount × (copies − 1) — is not a coverage figure and
 * routinely exceeds the size of the codebase, because clusters overlap: an L0
 * pair sits inside an L1 triple, and a `Block` sits inside the
 * `FunctionDeclaration` that contains it. Each is counted in full, so the same
 * source is charged several times over and "duplicated %" could print above
 * 100.
 *
 * This instead unions byte ranges. Within a cluster the first occurrence in
 * deterministic order is the *original* — the copy a refactor keeps — and only
 * the others are redundant. Their `[start, end)` ranges are unioned per file
 * across every cluster, so overlapping and nested findings contribute their
 * shared bytes once. The result is a genuine fraction in [0, 1]: it cannot
 * exceed 1 because a union of subranges of the corpus cannot be larger than
 * the corpus.
 *
 * `totalBytes` and the occurrence offsets must be measured the same way (both
 * are UTF-16 code-unit offsets into `SourceFile.text`); mixing those with byte
 * lengths of UTF-8 would make the ratio quietly wrong on non-ASCII source.
 */
export function redundantByteFraction(
  clusters: readonly Pick<Cluster, "occurrences">[],
  totalBytes: number,
): number {
  if (totalBytes <= 0) return 0;

  const rangesByFile = new Map<string, { start: number; end: number }[]>();
  for (const cluster of clusters) {
    for (const o of redundantOccurrences(cluster.occurrences)) {
      const list = rangesByFile.get(o.filePath);
      if (list) list.push({ start: o.start, end: o.end });
      else rangesByFile.set(o.filePath, [{ start: o.start, end: o.end }]);
    }
  }

  let covered = 0;
  for (const ranges of rangesByFile.values()) {
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    let cursor = -1;
    for (const r of ranges) {
      const start = Math.max(r.start, cursor);
      if (r.end > start) {
        covered += r.end - start;
        cursor = r.end;
      }
    }
  }

  // Clamped as a belt-and-braces guard on the headline number. Ranges outside
  // the corpus should be impossible; if one ever appears, a metric pinned at
  // 100% is a better failure than one reading 240%.
  return Math.min(1, covered / totalBytes);
}

/**
 * Every occurrence but the first. Sorted here rather than trusting the
 * caller's order, because *which* occurrence counts as the original decides
 * which bytes are charged, and the metric must not depend on traversal order.
 */
function redundantOccurrences(occurrences: readonly Occurrence[]): Occurrence[] {
  return [...occurrences]
    .sort((a, b) => compareStrings(a.filePath, b.filePath) || a.start - b.start || a.end - b.end)
    .slice(1);
}
