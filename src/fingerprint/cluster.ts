import type { Project } from "../extract/ts-adapter.js";
import { compareStrings } from "../order.js";
import { extractFragments, type Fragment } from "./fragments.js";
import { normalizeL0, normalizeL1 } from "./normalize.js";

export type Level = "L0" | "L1";

export interface Occurrence {
  filePath: string;
  start: number;
  end: number;
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
}

export async function findDuplication(
  project: Project,
  opts: DuplicationOptions,
): Promise<Cluster[]> {
  const byL0 = new Map<string, Fragment[]>();
  const byL1 = new Map<string, Fragment[]>();

  for (const file of project.files()) {
    for (const frag of extractFragments(file, opts)) {
      push(byL0, normalizeL0(frag.tokensL0), frag);
      push(byL1, normalizeL1(frag.tokensL1), frag);
    }
  }

  const clusters: Cluster[] = [];
  collect(byL0, "L0", clusters);

  // Only report an L1 cluster when it is genuinely coarser than L0 -- i.e. it
  // unites fragments that L0 kept apart. Otherwise it is the same finding twice.
  const l0Keys = new Set([...byL0.entries()].filter(([, v]) => v.length > 1).map(([k]) => k));
  for (const [key, frags] of byL1) {
    if (frags.length < 2) continue;
    const distinctL0 = new Set(frags.map((f) => normalizeL0(f.tokensL0)));
    if (distinctL0.size === 1 && l0Keys.has([...distinctL0][0]!)) continue;
    clusters.push(toCluster(key, "L1", frags));
  }

  // Deterministic: highest mass first, ties broken by id.
  clusters.sort((a, b) => b.mass - a.mass || compareStrings(a.id, b.id));
  return clusters;
}

function push(map: Map<string, Fragment[]>, key: string, frag: Fragment): void {
  const list = map.get(key);
  if (list) list.push(frag);
  else map.set(key, [frag]);
}

function collect(map: Map<string, Fragment[]>, level: Level, out: Cluster[]): void {
  for (const [key, frags] of map) {
    if (frags.length > 1) out.push(toCluster(key, level, frags));
  }
}

function toCluster(id: string, level: Level, frags: Fragment[]): Cluster {
  const occurrences = frags
    .map((f) => ({ filePath: f.filePath, start: f.start, end: f.end }))
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
