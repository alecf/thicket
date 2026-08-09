import type { Cluster } from "../fingerprint/cluster.js";
import { compareStrings } from "../order.js";

export type Tag = "source" | "test" | "mixed";

export interface Ranked {
  cluster: Cluster;
  score: number;
  tag: Tag;
}

/**
 * Anchored on a path separator and on a dot so that `latest/` and `attest.ts`
 * -- ordinary source names containing the substring "test" -- are not
 * mistaken for tests and silently down-weighted out of the report.
 */
const TEST_PATTERN = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)(__tests__|tests?)\/)/;

export function isTestPath(path: string): boolean {
  return TEST_PATTERN.test(path);
}

function tagOf(cluster: Cluster): Tag {
  const tests = cluster.occurrences.filter((o) => isTestPath(o.filePath)).length;
  if (tests === 0) return "source";
  if (tests === cluster.occurrences.length) return "test";
  return "mixed";
}

const LEVEL_WEIGHT: Record<string, number> = { L0: 1.0, L1: 0.9 };

/**
 * Repetitions of one shape within a single file that still count toward score.
 *
 * A shape repeated 99 times inside one file is a data table, not a missing
 * abstraction: on a real codebase a 99-copy, 21-node `PropertyAssignment` from
 * one config literal outscored an 8-copy, 109-node duplicated function spread
 * across eight route files by 12306 to 2612. Raw mass endorses the table
 * (2058 deletable nodes against 763), and no spread multiplier small enough to
 * be honest can overcome a 12x count difference -- so the count itself is
 * capped rather than the category being penalized.
 *
 * The cap binds on under 3% of candidates on every repository measured, which
 * is the point: it removes the pathology without reordering everything else.
 */
const MAX_COPIES_PER_FILE = 10;

/**
 * Ranking is the product. We surface perhaps 40 of ~500 candidates, so the
 * ordering matters far more than detection breadth. See PRD §1.1 / §5.4.
 */
export function rankClusters(
  clusters: readonly Cluster[],
  moduleOf?: Record<string, string>,
): Ranked[] {
  return clusters
    .map((cluster) => {
      const tag = tagOf(cluster);
      const files = new Set(cluster.occurrences.map((o) => o.filePath));
      // Prefer real module membership when the caller has a module graph;
      // fall back to the containing directory. PRD §5.4 weights cross-module
      // duplication highest because extracting it removes a real dependency.
      const groups = new Set(
        cluster.occurrences.map(
          (o) => moduleOf?.[o.filePath] ?? o.filePath.split("/").slice(0, -1).join("/"),
        ),
      );

      // Intra-file repetition is down-weighted rather than excluded: it is
      // 70-84% of all candidates on every repository measured, so blanket
      // suppression would empty the report of a whole legitimate category
      // (repeated handlers, repeated markup). PRD §5.4 ranks it lowest, not out.
      const spread = groups.size > 1 ? 2.5 : files.size > 1 ? 1.4 : 0.8;
      // All-test duplication is often legitimate; mixed is NOT penalized because
      // it signals production logic reimplemented in a test (PRD §2.7).
      const testWeight = tag === "test" ? 0.4 : 1.0;

      const copies = Math.min(
        cluster.occurrences.length,
        MAX_COPIES_PER_FILE * files.size,
      );

      const score =
        cluster.nodeCount *
        (copies - 1) *
        Math.log2(1 + copies) *
        spread *
        (LEVEL_WEIGHT[cluster.level] ?? 0.8) *
        testWeight;

      return { cluster, score, tag };
    })
    .sort((a, b) => b.score - a.score || compareStrings(a.cluster.id, b.cluster.id));
}

/**
 * Drop a cluster when a larger one covers the same occurrences -- a fragment
 * and its parent are the same finding at two granularities, and each duplicate
 * costs a report slot. A budget optimization, not a correctness fix (PRD §5.4).
 */
export function subsume(clusters: readonly Cluster[]): Cluster[] {
  const sorted = [...clusters].sort(
    (a, b) => b.nodeCount - a.nodeCount || compareStrings(a.id, b.id),
  );
  const kept: Cluster[] = [];
  for (const candidate of sorted) {
    if (!kept.some((parent) => contains(parent, candidate))) kept.push(candidate);
  }
  return kept;
}

function contains(parent: Cluster, child: Cluster): boolean {
  // Equal counts only: a child with MORE occurrences is a distinct finding
  // (an L1 triple around an L0 pair), not the same one at a finer grain.
  if (parent.occurrences.length !== child.occurrences.length) return false;
  return child.occurrences.every((c) =>
    parent.occurrences.some(
      (p) => p.filePath === c.filePath && p.start <= c.start && p.end >= c.end,
    ),
  );
}
