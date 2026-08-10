import type { Cache } from "../cache/db.js";
import type { Project } from "../extract/ts-adapter.js";
import { compareStrings } from "../order.js";
import { shapeFragments, type ShapedFragment } from "./shape.js";

export type Level = "L0" | "L1";

/**
 * Literal density at which a fragment stops being eligible for L1 matching.
 *
 * L1 is the α-renaming level: its job is to see past renamed *variables*
 * (PRD §5.2). It also drops literal values, and for a fragment whose content
 * largely IS its literals that is all it does — `{ oura: "Oura Ring", whoop:
 * "WHOOP" }` and `{ title: "Test", message: "Please wait" }` become the same
 * shape. On a real application this clustered a 5-entry label map with 428
 * other small string maps and ranked it first.
 *
 * 0.35 is the 90th percentile of literal share measured over 486,022
 * fragments of a 5,216-file application, and it separates the cases cleanly:
 * the offending label map scores 0.50 and the toast call 0.38, against 0.06
 * for the 19 duplicated observation classes that are the report's best
 * finding. Fragments above it keep their L0 candidacy, so identical copies of
 * a table are still reported.
 */
const MAX_LITERAL_SHARE_FOR_L1 = 0.35;

export interface Occurrence {
  filePath: string;
  start: number;
  end: number;
  /** 1-based line of `start`. Display only; ranges stay byte-based. */
  line: number;
  /** 1-based line of `end`. The span in lines is what the ranker scores. */
  endLine: number;
  /**
   * Pre-order ordinal of the parent AST node within its file. Occurrences
   * sharing a `(filePath, parentId)` are siblings under one node — entries of
   * a data literal rather than a missing abstraction.
   */
  parentId: number;
}

export interface Cluster {
  id: string; // the normalized hash; stable across runs and repos
  level: Level;
  kind: string;
  nodeCount: number;
  occurrences: Occurrence[];
  mass: number;
}

export interface DuplicationOptions {
  minNodes: number;
  /** Smallest fragment worth reporting, in lines. Defaults to no floor. */
  minLines?: number;
  /**
   * Skips re-walking files whose content has not changed since the last run.
   * Purely a speed-up: the cache stores whole fragments, so the cluster list
   * is identical with and without it (`tests/cache-pipeline.test.ts` asserts
   * exactly that).
   */
  cache?: Cache | null | undefined;
}

export async function findDuplication(
  project: Project,
  opts: DuplicationOptions,
): Promise<Cluster[]> {
  const { cache } = opts;
  const files = project.files();
  const fragments: ShapedFragment[] = [];

  for (const file of files) {
    if (cache?.isUnchanged(file.path, file.contentHash)) {
      fragments.push(...cache.fragmentsOf(file.path));
      continue;
    }
    const shaped = shapeFragments(file, opts);
    fragments.push(...shaped);
    cache?.replaceFile(file.path, file.contentHash, shaped);
  }

  // Rows for files that no longer exist are never read — this loop drives off
  // the project's file list, not off the table — but left alone they would
  // grow the database forever.
  cache?.purgeExcept(files.map((f) => f.path));

  return clusterFragments(fragments);
}

/**
 * Group fragments into findings. Pure: same input, same output, same order.
 *
 * Every fragment is filed under BOTH its hashes, because an L1 cluster is only
 * a finding when it is genuinely coarser than L0 — and deciding that requires
 * knowing which L0 shape each L1 member had.
 */
export function clusterFragments(fragments: readonly ShapedFragment[]): Cluster[] {
  const byL0 = new Map<string, ShapedFragment[]>();
  const byL1 = new Map<string, ShapedFragment[]>();
  for (const frag of fragments) {
    push(byL0, frag.l0, frag);
    // L1 erases literal VALUES, so for a fragment that is mostly its literals
    // an L1 match says only "same shape, different data" -- which is the
    // definition of two different constants, not a duplication. Such a
    // fragment stays eligible at L0, where being byte-identical still counts.
    if (frag.literalShare < MAX_LITERAL_SHARE_FOR_L1) push(byL1, frag.l1, frag);
  }

  const clusters: Cluster[] = [];
  collect(byL0, "L0", clusters);

  // Only report an L1 cluster when it is genuinely coarser than L0 -- i.e. it
  // unites fragments that L0 kept apart. Otherwise it is the same finding twice.
  const l0Keys = new Set([...byL0.entries()].filter(([, v]) => v.length > 1).map(([k]) => k));
  for (const [key, frags] of byL1) {
    if (frags.length < 2) continue;
    const distinctL0 = new Set(frags.map((f) => f.l0));
    if (distinctL0.size === 1 && l0Keys.has([...distinctL0][0]!)) continue;
    clusters.push(toCluster(key, "L1", frags));
  }

  // Deterministic: highest mass first, ties broken by id.
  clusters.sort((a, b) => b.mass - a.mass || compareStrings(a.id, b.id));
  return clusters;
}

function push(map: Map<string, ShapedFragment[]>, key: string, frag: ShapedFragment): void {
  const list = map.get(key);
  if (list) list.push(frag);
  else map.set(key, [frag]);
}

function collect(map: Map<string, ShapedFragment[]>, level: Level, out: Cluster[]): void {
  for (const [key, frags] of map) {
    if (frags.length > 1) out.push(toCluster(key, level, frags));
  }
}

function toCluster(id: string, level: Level, frags: readonly ShapedFragment[]): Cluster {
  const occurrences = frags
    .map((f) => ({
      filePath: f.filePath,
      start: f.start,
      end: f.end,
      line: f.line,
      endLine: f.endLine,
      parentId: f.parentId,
    }))
    .sort((a, b) => compareStrings(a.filePath, b.filePath) || a.start - b.start);
  const nodeCount = Math.min(...frags.map((f) => f.nodeCount));
  return {
    id,
    level,
    kind: frags[0]!.kind,
    nodeCount,
    occurrences,
    mass: nodeCount * (occurrences.length - 1),
  };
}
