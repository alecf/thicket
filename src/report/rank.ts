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

      const spread = groups.size > 1 ? 1.5 : files.size > 1 ? 1.2 : 1.0;
      // All-test duplication is often legitimate; mixed is NOT penalized because
      // it signals production logic reimplemented in a test (PRD §2.7).
      const testWeight = tag === "test" ? 0.4 : 1.0;

      const score =
        cluster.mass *
        Math.log2(1 + cluster.occurrences.length) *
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
