import type { Cache } from "../cache/db.js";
import type { Project } from "../extract/ts-adapter.js";
import { compareStrings } from "../order.js";
import { shapeFragments, type ShapedFragment } from "./shape.js";

export type Level = "L0" | "L1";

export interface Occurrence {
  filePath: string;
  start: number;
  end: number;
  /** 1-based line of `start`. Display only; ranges stay byte-based. */
  line: number;
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
    push(byL1, frag.l1, frag);
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
    .map((f) => ({ filePath: f.filePath, start: f.start, end: f.end, line: f.line }))
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
