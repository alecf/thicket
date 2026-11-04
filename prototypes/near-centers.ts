// Phase 0 of docs/plans/2026-11-04-near-miss.md: the judged experiment.
//
// near-miss.ts showed that grouping every near pair by union-find chains most
// of a large repository into one group. So this script asks the bounded
// question a report can use. For each finding the report prints (a "center"),
// which other shapes are near copies of it? It also samples near pairs between
// large shapes that no printed finding covers, which is what L3 would add as
// new findings.
//
//   bun run thicket <repo> --json <repo.json> > /dev/null
//   bun prototypes/near-centers.ts <repo> <repo.json> <out-dir>
//       [--model nomic-embed-text] [--embed-max 12000] [--no-embed] [--per 20]
//
// Writes stats.json, samples.jsonl (what a judge sees) and key.jsonl (what the
// judge does not see), in one shuffled order.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  overlapsOccs,
  pick,
  simhashBand,
  type Occ,
  type Shape,
} from "./near-lib.js";

const args = process.argv.slice(2);
const dir = resolve(args[0]!);
const reportPath = resolve(args[1]!);
const out = resolve(args[2]!);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1]!;
};
const MODEL = flag("--model", "nomic-embed-text");
const EMBED_MAX = Number(flag("--embed-max", "12000"));
const NO_EMBED = args.includes("--no-embed");
const PER = Number(flag("--per", "20"));
const EMBED_COSINE = 0.85;
const EMBED_K = 8;
/** Smallest shape sampled as a new near-only finding. */
const NEW_MIN_NODES = 60;
mkdirSync(out, { recursive: true });

interface ReportFinding {
  id: string;
  shapeHash: string;
  level: string;
  nodeCount: number;
  occurrences: { filePath: string; line: number; start: number; end: number }[];
}
const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  duplication: ReportFinding[];
  typeDuplication: ReportFinding[];
};

const { shapes, fragments } = await loadShapes(dir);
const population = [...shapes.values()]
  .filter((s) => s.shingles !== undefined)
  .sort((a, b) => (a.l1 < b.l1 ? -1 : 1));
const index = new Map(population.map((s, i) => [s.l1, i]));
const byL0 = new Map<string, number>();
population.forEach((s, i) => {
  for (const l0 of s.l0s) if (!byL0.has(l0)) byL0.set(l0, i);
});

// ---------------------------------------------------------------- LSH index
function buildIndex(bands: number, bandKey: (s: Shape, b: number) => string) {
  const tables: Map<string, number[]>[] = [];
  for (let b = 0; b < bands; b++) {
    const t = new Map<string, number[]>();
    population.forEach((s, i) => {
      const k = bandKey(s, b);
      const l = t.get(k);
      if (l) l.push(i);
      else t.set(k, [i]);
    });
    tables.push(t);
  }
  return (i: number, only?: ReadonlySet<number>): Set<number> => {
    const outSet = new Set<number>();
    const s = population[i]!;
    for (let b = 0; b < bands; b++)
      for (const x of tables[b]!.get(bandKey(s, b)) ?? []) if (only === undefined || only.has(x)) outSet.add(x);
    return outSet;
  };
}
/** Same lookup, skipping buckets larger than `cap`: a common idiom, not a near copy. */
function buildCappedIndex(bands: number, bandKey: (s: Shape, b: number) => string, cap: number) {
  const tables: Map<string, number[]>[] = [];
  for (let b = 0; b < bands; b++) {
    const t = new Map<string, number[]>();
    population.forEach((s, i) => {
      const k = bandKey(s, b);
      const l = t.get(k);
      if (l) l.push(i);
      else t.set(k, [i]);
    });
    tables.push(t);
  }
  return (i: number, only: ReadonlySet<number>): Set<number> => {
    const outSet = new Set<number>();
    const s = population[i]!;
    for (let b = 0; b < bands; b++) {
      const l = tables[b]!.get(bandKey(s, b)) ?? [];
      if (l.length > cap) continue;
      for (const x of l) if (only.has(x)) outSet.add(x);
    }
    outSet.delete(i);
    return outSet;
  };
}
const minhashCandidates = buildIndex(BANDS, minhashBand);
const simhashCandidates = buildIndex(SIM_BANDS, simhashBand);
const cappedCandidates = buildCappedIndex(BANDS, minhashBand, 200);

// ---------------------------------------------------------------- centers
interface Center {
  id: string;
  level: string;
  shape: number;
  occs: Occ[];
  copies: number;
}
const centers: Center[] = [];
for (const f of [...report.duplication, ...report.typeDuplication]) {
  const shape = f.level === "L1" ? index.get(f.shapeHash) : byL0.get(f.shapeHash);
  if (shape === undefined) continue;
  centers.push({
    id: f.id,
    level: f.level,
    shape,
    copies: f.occurrences.length,
    occs: f.occurrences.map((o) => ({
      file: o.filePath,
      start: o.start,
      end: o.end,
      line: o.line,
      endLine: o.line,
      parent: "",
    })),
  });
}
const centerShapes = new Set(centers.map((c) => c.shape));
const coveredByFile = new Map<string, Occ[]>();
for (const o of centers.flatMap((c) => c.occs)) {
  const l = coveredByFile.get(o.file);
  if (l) l.push(o);
  else coveredByFile.set(o.file, [o]);
}
const covered = (occs: readonly Occ[]) =>
  occs.some((x) => (coveredByFile.get(x.file) ?? []).some((y) => x.start < y.end && y.start < x.end));

// ---------------------------------------------------------------- embeddings
let vectors = new Map<string, Float32Array>();
let embedPool: number[] = [];
if (!NO_EMBED) {
  const pool = population
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.nodeCount - a.s.nodeCount || (a.s.l1 < b.s.l1 ? -1 : 1))
    .slice(0, EMBED_MAX)
    .map((e) => e.i);
  const withCenters = [...new Set([...pool, ...centerShapes])];
  const r = await embedShapes(
    withCenters.map((i) => population[i]!),
    MODEL,
    join(out, `embed-${MODEL.replace(/[^a-z0-9]/gi, "_")}.json`),
  );
  vectors = r.vectors;
  embedPool = withCenters.filter((i) => vectors.has(population[i]!.l1));
  console.log(`embedded ${r.fresh} new in ${r.ms} ms; pool ${embedPool.length}`);
}

// ---------------------------------------------------------------- neighbors
interface Neighbor {
  shape: number;
  jaccard: number;
  cosine?: number;
  sources: string[];
  isFinding: boolean;
}
const neighborsOf = new Map<number, Neighbor[]>();
for (const c of centers) {
  const cs = population[c.shape]!;
  const found = new Map<number, Neighbor>();
  const add = (x: number, src: string, cosine?: number) => {
    let n = found.get(x);
    if (!n) {
      n = {
        shape: x,
        jaccard: jaccard(cs.shingles!, population[x]!.shingles!),
        sources: [],
        isFinding: centerShapes.has(x),
      };
      found.set(x, n);
    }
    if (!n.sources.includes(src)) n.sources.push(src);
    if (cosine !== undefined) n.cosine = cosine;
  };
  for (const x of minhashCandidates(c.shape)) add(x, "minhash");
  for (const x of simhashCandidates(c.shape)) add(x, "simhash");
  const cv = vectors.get(cs.l1);
  if (cv !== undefined) {
    const best = embedPool
      .filter((x) => x !== c.shape)
      .map((x) => ({ x, c: dot(cv, vectors.get(population[x]!.l1)!) }))
      .filter((e) => e.c >= EMBED_COSINE)
      .sort((a, b) => b.c - a.c)
      .slice(0, EMBED_K);
    for (const e of best) add(e.x, "embed", e.c);
  }
  // Fifth hazard: drop anything inside or around the finding's own copies.
  // Then drop a neighbor nested in a larger accepted neighbor.
  const kept: Neighbor[] = [];
  const accepted: Occ[] = [];
  const list = [...found.values()]
    .filter((n) => n.jaccard >= 0.5 || n.sources.includes("embed"))
    .filter((n) => !overlapsOccs(population[n.shape]!.occs, c.occs))
    .sort(
      (a, b) =>
        population[b.shape]!.nodeCount - population[a.shape]!.nodeCount || b.jaccard - a.jaccard,
    );
  for (const n of list) {
    const occs = population[n.shape]!.occs;
    if (overlapsOccs(occs, accepted)) continue;
    kept.push(n);
    accepted.push(...occs);
  }
  neighborsOf.set(c.shape, kept.sort((a, b) => b.jaccard - a.jaccard || a.shape - b.shape));
}

// ---------------------------------------------------------------- new findings
// Near pairs between large shapes no printed finding covers.
const large = population
  .map((s, i) => ({ s, i }))
  .filter((e) => e.s.nodeCount >= NEW_MIN_NODES && !covered(e.s.occs))
  .map((e) => e.i);
const largeSet = new Set(large);
const newPairs: { i: number; j: number; jaccard: number }[] = [];
for (const i of large) {
  for (const j of cappedCandidates(i, largeSet)) {
    if (j <= i) continue;
    const a = population[i]!;
    const b = population[j]!;
    if (overlapsOccs(a.occs, b.occs)) continue;
    const jac = jaccard(a.shingles!, b.shingles!);
    if (jac >= 0.6) newPairs.push({ i, j, jaccard: jac });
  }
}

// ---------------------------------------------------------------- stats
const at = (t: number) => {
  const withAny = centers.filter((c) => (neighborsOf.get(c.shape) ?? []).some((n) => n.jaccard >= t));
  const extra = centers.reduce(
    (s, c) =>
      s +
      (neighborsOf.get(c.shape) ?? [])
        .filter((n) => n.jaccard >= t)
        .reduce((k, n) => k + population[n.shape]!.copies, 0),
    0,
  );
  const intoFinding = centers.reduce(
    (s, c) => s + (neighborsOf.get(c.shape) ?? []).filter((n) => n.jaccard >= t && n.isFinding).length,
    0,
  );
  return { centersWithNeighbor: withAny.length, extraCopies: extra, neighborIsAnotherFinding: intoFinding };
};
const allNeighbors = [...neighborsOf.values()].flat();
const stats = {
  fragments,
  shapes: shapes.size,
  centers: centers.length,
  totalCopiesInCenters: centers.reduce((s, c) => s + c.copies, 0),
  "j>=0.8": at(0.8),
  "j>=0.7": at(0.7),
  "j>=0.6": at(0.6),
  "j>=0.5": at(0.5),
  embedNeighbors: allNeighbors.filter((n) => n.sources.includes("embed")).length,
  embedOnlyBelow05: allNeighbors.filter((n) => n.sources.includes("embed") && n.jaccard < 0.5).length,
  embedFoundStructuralMissed: allNeighbors.filter(
    (n) => n.jaccard >= 0.6 && n.sources.includes("embed") && !n.sources.includes("minhash") && !n.sources.includes("simhash"),
  ).length,
  structuralFoundEmbedMissed: allNeighbors.filter(
    (n) =>
      n.jaccard >= 0.6 &&
      !n.sources.includes("embed") &&
      vectors.has(population[n.shape]!.l1) &&
      vectors.has(population[centers.find((c) => neighborsOf.get(c.shape)!.includes(n))!.shape]!.l1),
  ).length,
  newLargeShapes: large.length,
  "newPairs>=0.6": newPairs.length,
  "newPairs>=0.7": newPairs.filter((p) => p.jaccard >= 0.7).length,
  "newPairs>=0.8": newPairs.filter((p) => p.jaccard >= 0.8).length,
};
writeFileSync(join(out, "stats.json"), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));

// ---------------------------------------------------------------- samples
interface Item {
  a: number;
  b: number;
  aCopies: number;
  category: string;
  jaccard: number;
  cosine?: number;
  sources: string[];
  center?: string;
}
const ext: Item[] = centers.flatMap((c) =>
  (neighborsOf.get(c.shape) ?? []).map((n) => ({
    a: c.shape,
    b: n.shape,
    aCopies: c.copies,
    category: "",
    jaccard: n.jaccard,
    cosine: n.cosine,
    sources: n.sources.sort(),
    center: c.id,
  })),
);
const band = (lo: number, hi: number) => ext.filter((e) => e.jaccard >= lo && e.jaccard < hi);
// At most two items per center, so one finding with many neighbors cannot
// fill a category.
function spread(items: Item[], n: number, seed: number, category: string): Item[] {
  const perCenter = new Map<string, number>();
  const outItems: Item[] = [];
  for (const it of pick(items, items.length, seed)) {
    const k = it.center ?? `${it.a}`;
    if ((perCenter.get(k) ?? 0) >= 2) continue;
    perCenter.set(k, (perCenter.get(k) ?? 0) + 1);
    outItems.push({ ...it, category });
    if (outItems.length >= n) break;
  }
  return outItems;
}
// Controls: same kind, similar size, structurally dissimilar.
const controls: Item[] = [];
for (const c of pick(centers, centers.length, 0xc0de)) {
  const cs = population[c.shape]!;
  const pool = population
    .map((s, i) => ({ s, i }))
    .filter(
      (e) =>
        e.i !== c.shape &&
        e.s.kind === cs.kind &&
        Math.abs(e.s.nodeCount - cs.nodeCount) <= cs.nodeCount * 0.3 &&
        !overlapsOccs(e.s.occs, c.occs),
    );
  const pickOne = pick(pool, 10, fnv(c.id)).find((e) => jaccard(cs.shingles!, e.s.shingles!) < 0.3);
  if (pickOne)
    controls.push({
      a: c.shape,
      b: pickOne.i,
      aCopies: c.copies,
      category: "control",
      jaccard: jaccard(cs.shingles!, pickOne.s.shingles!),
      sources: [],
      center: c.id,
    });
  if (controls.length >= PER) break;
}
const items: Item[] = [
  ...spread(band(0.8, 1.01), PER, 1, "ext>=0.8"),
  ...spread(band(0.7, 0.8), PER, 2, "ext0.7-0.8"),
  ...spread(band(0.6, 0.7), PER, 3, "ext0.6-0.7"),
  ...spread(band(0.5, 0.6), PER, 4, "ext0.5-0.6"),
  ...spread(ext.filter((e) => e.sources.includes("embed") && e.jaccard < 0.5), PER, 5, "ext-embed-only"),
  ...controls,
  ...spread(
    newPairs.filter((p) => p.jaccard >= 0.8).map((p) => ({ a: p.i, b: p.j, aCopies: population[p.i]!.copies, category: "", jaccard: p.jaccard, sources: ["minhash"] })),
    PER,
    6,
    "new>=0.8",
  ),
];
const order = pick(items.map((_, k) => k), items.length, 0x5eed);
const prefix = flag("--prefix", "S");
const show = (i: number, copies: number) => {
  const s = population[i]!;
  return { file: s.occs[0]!.file, line: s.occs[0]!.line, copies, code: s.text!.slice(0, 2500) };
};
const samples = order.map((k, n) => {
  const it = items[k]!;
  return { id: `${prefix}${String(n + 1).padStart(3, "0")}`, a: show(it.a, it.aCopies), b: show(it.b, population[it.b]!.copies) };
});
const keys = order.map((k, n) => {
  const it = items[k]!;
  const a = population[it.a]!;
  const b = population[it.b]!;
  return {
    id: samples[n]!.id,
    category: it.category,
    jaccard: it.jaccard,
    cosine: it.cosine,
    sources: it.sources,
    center: it.center,
    kind: a.kind,
    kindB: b.kind,
    nodes: Math.min(a.nodeCount, b.nodeCount),
    literalShare: Math.max(a.literalShare, b.literalShare),
  };
});
writeFileSync(join(out, "samples.jsonl"), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
writeFileSync(join(out, "key.jsonl"), keys.map((s) => JSON.stringify(s)).join("\n") + "\n");
console.log(`wrote ${samples.length} samples`);
