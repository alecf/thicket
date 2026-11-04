// Phase 0 of docs/plans/2026-11-04-near-miss.md.
//
// Reduces a repository to its distinct L1 shapes, then compares three
// candidate sources for near-miss pairs between them:
//
//   minhash   MinHash + LSH over 5-shingles of the L2 stream (PRD §5.3)
//   simhash   sign-of-±1-projection LSH over kind 3-gram counts (integer only)
//   embed     a local embedding model, via an OpenAI-compatible endpoint
//
// Every candidate pair is then measured the same way: exact L2 shingle Jaccard,
// with ancestor-descendant pairs excluded. The script prints counts and writes
// blind judging samples.
//
//   bun prototypes/near-miss.ts <repo-dir> <out-dir> [--model nomic-embed-text]
//                               [--embed-max 12000] [--no-embed]
//
// Uses the real extraction code, so shapes here are the shapes thicket ranks.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BANDS,
  SIM_BANDS,
  dot,
  embedShapes,
  fnv,
  jaccard,
  loadShapes,
  minhashBand,
  mix,
  overlapsOccs,
  pick,
  simhashBand,
  type Shape,
} from "./near-lib.js";

const args = process.argv.slice(2);
const dir = resolve(args[0]!);
const out = resolve(args[1]!);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1]!;
};
const MODEL = flag("--model", "nomic-embed-text");
const EMBED_MAX = Number(flag("--embed-max", "12000"));
const NO_EMBED = args.includes("--no-embed");
const BUCKET_CAP = 150; // a bucket bigger than this is a common idiom; skipped and counted
const EMBED_COSINE = 0.9;
const EMBED_K = 5;
const JACCARD_FLOOR = 0.5;

mkdirSync(out, { recursive: true });
const { shapes, fragments: fragmentCount } = await loadShapes(dir);
const overlaps = (a: Shape, b: Shape) => overlapsOccs(a.occs, b.occs);

// ---------------------------------------------------------------- population
const all = [...shapes.values()].sort((a, b) => (a.l1 < b.l1 ? -1 : 1));
const population = all.filter((s) => s.shingles !== undefined);
const index = new Map(population.map((s, i) => [s.l1, i]));
console.log(`fragments ${fragmentCount}  distinct L1 shapes ${all.length}  compared ${population.length}`);

// ---------------------------------------------------------------- candidates
type Pair = number; // i * N + j with i < j
const N = population.length;
const key = (i: number, j: number): Pair => (i < j ? i * N + j : j * N + i);
const BIT: Record<string, number> = { minhash: 1, simhash: 2, embed: 4 };
const sources = new Map<Pair, number>();
const note = (p: Pair, src: string) => sources.set(p, (sources.get(p) ?? 0) | BIT[src]!);

function lsh(name: string, bandKey: (s: Shape, band: number) => string, bands: number) {
  let skipped = 0;
  for (let band = 0; band < bands; band++) {
    const buckets = new Map<string, number[]>();
    population.forEach((s, i) => {
      const k = bandKey(s, band);
      const list = buckets.get(k);
      if (list) list.push(i); else buckets.set(k, [i]);
    });
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      if (list.length > BUCKET_CAP) { skipped++; continue; }
      for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) note(key(list[x]!, list[y]!), name);
    }
  }
  return skipped;
}
const t0 = Date.now();
const mhSkipped = lsh("minhash", minhashBand, BANDS);
const t1 = Date.now();
const shSkipped = lsh("simhash", simhashBand, SIM_BANDS);
const t2 = Date.now();
console.log(`minhash LSH ${t1 - t0} ms (${mhSkipped} oversized buckets)  simhash LSH ${t2 - t1} ms (${shSkipped})`);

// ---------------------------------------------------------------- embeddings
const cosines = new Map<Pair, number>();
let embedPopulation: number[] = [];
if (!NO_EMBED) {
  // The embedding population is capped. Prefer larger shapes: they are the
  // ones a reader would extract, and the PRD's ranking favours them.
  embedPopulation = population
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.nodeCount - a.s.nodeCount || (a.s.l1 < b.s.l1 ? -1 : 1))
    .slice(0, EMBED_MAX)
    .map((e) => e.i);
  const r = await embedShapes(
    embedPopulation.map((i) => population[i]!),
    MODEL,
    join(out, `embed-${MODEL.replace(/[^a-z0-9]/gi, "_")}.json`),
  );
  const embedMs = r.ms;
  const todo = { length: r.fresh };
  const vecs = embedPopulation.map((i) => r.vectors.get(population[i]!.l1)!);
  const n = embedPopulation.length;
  const tk = Date.now();
  for (let r = 0; r < n; r++) {
    const best: { c: number; s: number }[] = [];
    for (let s = 0; s < n; s++) {
      if (s === r) continue;
      const c = dot(vecs[r]!, vecs[s]!);
      if (c >= EMBED_COSINE) best.push({ c, s });
    }
    best.sort((a, b) => b.c - a.c);
    for (const { c, s } of best.slice(0, EMBED_K)) {
      const p = key(embedPopulation[r]!, embedPopulation[s]!);
      note(p, "embed");
      cosines.set(p, c);
    }
  }
  console.log(`embedded ${todo.length} new (${embedMs} ms), ${n} total; kNN ${Date.now() - tk} ms`);
}

// ---------------------------------------------------------------- verify
interface Measured {
  i: number;
  j: number;
  jaccard: number;
  cosine?: number;
  sources: string[];
  /** Neither shape's enclosing fragment is part of a verified pair too. */
  maximal: boolean;
}
const measured: Measured[] = [];
let nested = 0;
for (const [p, srcs] of sources) {
  const i = Math.floor(p / N), j = p % N;
  const a = population[i]!, b = population[j]!;
  if (overlaps(a, b)) { nested++; continue; }
  const jac = jaccard(a.shingles!, b.shingles!);
  measured.push({ i, j, jaccard: jac, cosine: cosines.get(p), sources: Object.keys(BIT).filter((k) => (srcs & BIT[k]!) !== 0), maximal: true });
}
// Maximality: a pair is redundant when the parents of its first occurrences
// form a pair that also verified at the same threshold.
const verifiedAt = (t: number) => new Set(measured.filter((m) => m.jaccard >= t).map((m) => key(m.i, m.j)));
const v05 = verifiedAt(JACCARD_FLOOR);
for (const m of measured) {
  const pa = population[m.i]!.occs[0]!.parent, pb = population[m.j]!.occs[0]!.parent;
  const ia = index.get(pa), ib = index.get(pb);
  if (pa !== "" && pa === pb) m.maximal = false; // same parent shape: exact above us
  else if (ia !== undefined && ib !== undefined && v05.has(key(ia, ib))) m.maximal = false;
}

// ---------------------------------------------------------------- counts
function unionFind(n: number) {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  return { find, union: (a: number, b: number) => { parent[find(a)] = find(b); } };
}
const stats: Record<string, unknown> = {
  fragments: fragmentCount,
  shapes: all.length,
  compared: population.length,
  embedded: embedPopulation.length,
  candidatePairs: sources.size,
  nestedExcluded: nested,
};
for (const t of [0.5, 0.6, 0.7, 0.8]) {
  for (const src of ["minhash", "simhash", "embed"]) {
    const ms = measured.filter((m) => m.sources.includes(src) && m.jaccard >= t);
    const uf = unionFind(population.length);
    for (const m of ms) uf.union(m.i, m.j);
    const groups = new Map<number, number[]>();
    for (const m of ms) for (const x of [m.i, m.j]) {
      const r = uf.find(x);
      const g = groups.get(r) ?? [];
      if (!g.includes(x)) g.push(x);
      groups.set(r, g);
    }
    stats[`${src}@${t}`] = {
      pairs: ms.length,
      maximalPairs: ms.filter((m) => m.maximal).length,
      groups: groups.size,
      shapesUnited: [...groups.values()].reduce((s, g) => s + g.length, 0),
      largestGroup: Math.max(0, ...[...groups.values()].map((g) => g.length)),
    };
  }
}
// What embeddings find that the structural measure rejects.
const embedOnly = measured.filter((m) => m.sources.includes("embed") && m.jaccard < JACCARD_FLOOR);
stats.embedBelowJaccardFloor = embedOnly.length;
stats.embedPairs = measured.filter((m) => m.sources.includes("embed")).length;
stats.minhashMissedEmbedAbove07 = measured.filter((m) => m.sources.includes("embed") && !m.sources.includes("minhash") && m.jaccard >= 0.7).length;
writeFileSync(join(out, "stats.json"), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));

// ---------------------------------------------------------------- samples
// Categories, each drawn with a fixed-seed shuffle. The judge never sees them.
const maximal = measured.filter((m) => m.maximal);
const categories: Record<string, Measured[]> = {
  "j>=0.8": maximal.filter((m) => m.jaccard >= 0.8),
  "0.7<=j<0.8": maximal.filter((m) => m.jaccard >= 0.7 && m.jaccard < 0.8),
  "0.5<=j<0.7": maximal.filter((m) => m.jaccard >= 0.5 && m.jaccard < 0.7),
  "embed-only": maximal.filter((m) => m.sources.includes("embed") && m.jaccard < 0.5),
  control: maximal.filter((m) => m.jaccard < 0.3 && !m.sources.includes("embed")),
};
const PER = Number(flag("--per", "24"));
const samples: unknown[] = [];
const keyRows: unknown[] = [];
let n = 0;
for (const [cat, list] of Object.entries(categories)) {
  for (const m of pick(list, PER, fnv(cat))) {
    const a = population[m.i]!, b = population[m.j]!;
    const id = `S${String(++n).padStart(3, "0")}`;
    samples.push({
      id,
      a: { file: a.occs[0]!.file, line: a.occs[0]!.line, copies: a.occs.length, code: a.text!.slice(0, 2500) },
      b: { file: b.occs[0]!.file, line: b.occs[0]!.line, copies: b.occs.length, code: b.text!.slice(0, 2500) },
    });
    keyRows.push({
      id, category: cat, jaccard: m.jaccard, cosine: m.cosine, sources: m.sources,
      kind: a.kind, kindB: b.kind, nodes: Math.min(a.nodeCount, b.nodeCount),
      literalShare: Math.max(a.literalShare, b.literalShare),
      copies: a.occs.length + b.occs.length,
    });
  }
}
// Shuffle the judged order so category runs do not show.
const order = pick(samples.map((_, k) => k), samples.length, 0x5eed);
writeFileSync(join(out, "samples.jsonl"), order.map((k) => JSON.stringify(samples[k])).join("\n") + "\n");
writeFileSync(join(out, "key.jsonl"), order.map((k) => JSON.stringify(keyRows[k])).join("\n") + "\n");
console.log(`wrote ${samples.length} samples to ${out}`);
