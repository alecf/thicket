import type { Cluster } from "../fingerprint/cluster.js";
import { compareStrings } from "../order.js";
import type { FindingContext } from "./context.js";
import type { Variant } from "./variants.js";

export type Tag = "source" | "test" | "mixed";

export interface Ranked {
  cluster: Cluster;
  score: number;
  tag: Tag;
  /** Median span of one copy, in lines. */
  linesPerCopy: number;
  /** Lines a successful extraction would remove; the score before weighting. */
  recoverableLines: number;
  /**
   * A few lines of the first occurrence's source. Attached after ranking, by
   * the caller that holds the file texts, and only for findings the report
   * will actually print.
   */
  excerpt?: string[];
  /**
   * What surrounds the cluster: the abstraction its copies already share, and
   * how much of the codebase reaches into it. Attached alongside the excerpt,
   * for emitted findings only.
   */
  context?: FindingContext;
  /**
   * Other emitted findings that are nearly this shape. Attached alongside the
   * excerpt, for emitted findings only.
   */
  variants?: Variant[];
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

/** Share of a cluster's occurrences that are not test files, in [0, 1]. */
export function sourceShare(cluster: Cluster): number {
  const source = cluster.occurrences.filter((o) => !isTestPath(o.filePath)).length;
  return source / cluster.occurrences.length;
}

/**
 * Which of the report's two duplication sections a cluster belongs in.
 *
 * A tie goes to the test section. A cluster half of whose copies are test
 * files is as much test scaffolding as it is production duplication, and the
 * point of the split is that scaffolding cannot displace production work.
 *
 * Deliberately not keyed on `tag`. A cluster that is 95% test files and 5%
 * source is tagged `mixed`, and treating `mixed` as production is exactly how
 * 429 copies of `vi.mock` scaffolding took the top four slots of a real report.
 */
export function isTestMajority(cluster: Cluster): boolean {
  return sourceShare(cluster) <= 0.5;
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
 * Lines the extracted definition costs that the copies did not: a signature
 * and a closing brace. Small, but it is what makes a one-line shape score
 * zero however often it repeats, which is the correct answer -- the call that
 * replaces each copy is itself a line, so the refactor is a strict loss.
 */
const EXTRACTION_OVERHEAD = 2;

/**
 * How much of the score a cluster keeps when every copy is a sibling of every
 * other under one AST node.
 *
 * Such a cluster is a data literal — a config table, a code map, a list of
 * reference ranges — where the repetition IS the content and there is nothing
 * to extract. PRD §5.4 records this as the ranker's known blind spot, and
 * names exactly this signal as the fix. On the repository that motivated it,
 * ten of the top forty findings were entries of one biomarker config table.
 *
 * A weight rather than a filter, for the same reason intra-file repetition is
 * down-weighted rather than excluded: a run of sibling statements is sometimes
 * real logic that wants a loop.
 */
const SIBLING_FLOOR = 0.2;

/**
 * Weight of a cluster with no source occurrences at all. Duplication between
 * tests is frequently deliberate — parallel arrange/act/assert blocks read
 * better than a helper — so it is down-weighted rather than dropped.
 */
const TEST_FLOOR = 0.4;

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
      // All-test duplication is often legitimate, and duplication that reaches
      // into production code is the case PRD §2.7 wants surfaced. Weight moves
      // continuously with the source share rather than switching on the tag:
      // exempting every `[mixed]` cluster let 429 copies of `vi.mock`
      // scaffolding take full weight because a couple of source files happened
      // to share the shape, and the top four findings of a real application
      // were all test setup. A cluster that is 95% test files is a test
      // cluster whatever its tag says.
      const testWeight = TEST_FLOOR + (1 - TEST_FLOOR) * sourceShare(cluster);

      const copies = Math.min(
        cluster.occurrences.length,
        MAX_COPIES_PER_FILE * files.size,
      );

      // The median, not the mean: one outsized member of an L1 cluster should
      // not speak for the rest, and the report quotes this number as "~N
      // lines" for every copy.
      const linesPerCopy = median(
        cluster.occurrences.map((o) => o.endLine - o.line + 1),
      );

      // Lines that actually disappear. Each copy collapses to a one-line call,
      // so a copy is worth `linesPerCopy - 1`, and the surviving definition
      // costs its own body plus a signature.
      //
      // Size and count enter exactly once each. The previous formula had size
      // linear and count effectively superlinear -- `(copies - 1)` multiplied
      // again by `log2(1 + copies)` -- which inverted the judgement the report
      // exists to support: 25 copies of a 4-line block outscored a 22-line
      // function duplicated across two packages by 8.5x.
      const recoverableLines = Math.max(
        0,
        (copies - 1) * (linesPerCopy - 1) - EXTRACTION_OVERHEAD,
      );

      const score =
        recoverableLines *
        spread *
        (LEVEL_WEIGHT[cluster.level] ?? 0.8) *
        testWeight *
        siblingWeight(cluster);

      return { cluster, score, tag, linesPerCopy, recoverableLines };
    })
    .sort((a, b) => b.score - a.score || compareStrings(a.cluster.id, b.cluster.id));
}

/**
 * Down-weight by how completely the copies are siblings of one another.
 *
 * `distinctParents / copies` is 1 when every copy hangs off a different node
 * — scattered code, the case worth reporting — and approaches 0 when they are
 * all entries of one literal. Keyed on the parent NODE rather than on the
 * file: two repeated handlers in one module are not a data table, and keying
 * on the file would sweep up every legitimate intra-file repetition, which is
 * 70-84% of all candidates.
 */
function siblingWeight(cluster: Cluster): number {
  const parents = new Set(cluster.occurrences.map((o) => `${o.filePath} ${o.parentId}`));
  const scattered = parents.size / cluster.occurrences.length;
  return SIBLING_FLOOR + (1 - SIBLING_FLOOR) * scattered;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  // Lower median on even counts, so the result is always an observed span and
  // never a half-line the reader cannot find in the source.
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
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

/**
 * Share of a candidate's occurrences that must sit inside the kept cluster
 * before the two count as one finding at two granularities.
 *
 * Exact equality — the original rule — is too strict to catch the case that
 * actually costs slots. One repeated test-setup block took seven of the top
 * eleven on a real application: a `Block` of 120 copies, the
 * `ExpressionStatement` inside it at 135, the enclosing `IfStatement` at 115,
 * plus L1 variants of each. A handful of sites have one extra statement, so no
 * two counts matched and nothing subsumed anything.
 *
 * Below 1.0 this necessarily discards a little: a child with a few occurrences
 * outside the parent loses those sites. That is the right trade under a budget
 * two orders of magnitude smaller than the candidate pool — the alternative
 * spent six slots restating one finding — but it is why the bar is high rather
 * than a simple majority.
 */
const SUBSUME_OVERLAP = 0.8;

/**
 * Whether a nested cluster at `inner`'s level restates one at `outer`'s, or
 * says something the outer one does not.
 *
 * The relation is deliberately asymmetric, because the two nestings mean
 * opposite things:
 *
 * - **Exact outside, fuzzy inside** (L0 containing L1) is one finding twice. A
 *   real report spent two of a section's five slots on an L0 `IfStatement` of
 *   115 copies and, at the same file and the same line, the L1 `Block` of 121
 *   that is its body with the guard normalized away. Nothing is learned from
 *   the second entry that the first did not already say.
 * - **Fuzzy outside, exact inside** (L1 containing L0) is two findings. In the
 *   sample fixture an L1 cluster unites three structurally identical functions
 *   while the L0 cluster inside it covers the two that match byte for byte,
 *   and those support different refactors -- the exact pair is trivially
 *   extractable, the fuzzy triple needs the differences reconciled first.
 *
 * Collapsing both directions deletes the second case; collapsing neither -- the
 * original rule -- pays for the first.
 */
function levelsCollapse(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  return outer === "L0" && inner === "L1";
}

function contains(parent: Cluster, child: Cluster): boolean {
  if (!levelsCollapse(parent.level, child.level)) return false;
  // Directional: `child`'s occurrences must sit inside `parent`'s, so a small
  // fragment can never swallow the larger one it is nested in, whatever the
  // iteration order.
  const inside = child.occurrences.filter((c) =>
    parent.occurrences.some(
      (p) => p.filePath === c.filePath && p.start <= c.start && p.end >= c.end,
    ),
  ).length;
  return inside / child.occurrences.length >= SUBSUME_OVERLAP;
}
