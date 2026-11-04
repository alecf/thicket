// Shared by near-miss.ts (all-pairs census) and near-centers.ts (judged
// experiment). See docs/plans/2026-11-04-near-miss.md, Phase 0.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openProject } from "../src/extract/ts-adapter.js";
import { extractFragments } from "../src/fingerprint/fragments.js";
import { alphaRename } from "../src/fingerprint/normalize.js";
import { hash, initHash } from "../src/hash.js";
import { discoverConfigs } from "../src/run.js";

export const MIN_NODES = 15;
export const MIN_LINES = 4;
/** Larger shapes are recorded but carry no signature. */
export const MAX_NODES = 3000;
export const SHINGLE = 5;
export const MINHASH_PERMS = 128;
export const BANDS = 32;
export const ROWS = MINHASH_PERMS / BANDS;
export const SIMHASH_BITS = 128;
export const SIM_BANDS = 8;
export const SIM_ROWS = SIMHASH_BITS / SIM_BANDS;

export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mix(x: number, seed: number): number {
  let h = (x ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const SEEDS = Array.from({ length: Math.max(MINHASH_PERMS, SIMHASH_BITS) }, (_, i) =>
  mix(i + 1, 0x9e3779b9),
);

export interface Occ {
  file: string;
  start: number;
  end: number;
  line: number;
  endLine: number;
  /** L1 hash of the smallest enclosing fragment, or "" at the top. */
  parent: string;
}

export interface Shape {
  l1: string;
  kind: string;
  nodeCount: number;
  literalShare: number;
  /** First 60 occurrences. */
  occs: Occ[];
  copies: number;
  l0s: Set<string>;
  shingles?: Uint32Array;
  minhash?: Uint32Array;
  simhash?: Uint32Array;
  text?: string;
}

/** Every distinct L1 shape in the repository, keyed by L1 hash. */
export async function loadShapes(dir: string): Promise<{ shapes: Map<string, Shape>; fragments: number }> {
  await initHash();
  const scan = { includeGenerated: false, bannerScan: true, exclude: [] as string[] };
  const discovery = await discoverConfigs(dir, { filter: [], workspaces: true, scan, warn: () => {} });
  const project = await openProject(discovery.configs, { ...scan, root: dir });
  const shapes = new Map<string, Shape>();
  let fragments = 0;
  try {
    for (const file of project.files()) {
      const frags = extractFragments(file, { minNodes: MIN_NODES, minLines: MIN_LINES });
      fragments += frags.length;
      const order = frags
        .map((f) => ({ f, l1: hash(alphaRename(f.tokensL1).join(" ")) }))
        .sort((a, b) => a.f.start - b.f.start || b.f.end - a.f.end);
      const stack: typeof order = [];
      for (const e of order) {
        while (stack.length > 0 && stack[stack.length - 1]!.f.end <= e.f.start) stack.pop();
        const parent = stack.length > 0 ? stack[stack.length - 1]!.l1 : "";
        stack.push(e);
        let s = shapes.get(e.l1);
        if (s === undefined) {
          s = {
            l1: e.l1,
            kind: e.f.kind,
            nodeCount: e.f.nodeCount,
            literalShare: e.f.literalShare,
            occs: [],
            copies: 0,
            l0s: new Set(),
          };
          if (e.f.nodeCount <= MAX_NODES) {
            const l2 = e.f.tokensL1.map((t) => (t.startsWith("Id:") ? "Id" : t));
            s.shingles = shingleSet(l2);
            s.minhash = minhash(s.shingles);
            s.simhash = simhash(l2);
            s.text = file.sourceFile.text.slice(e.f.start, e.f.end);
          }
          shapes.set(e.l1, s);
        }
        s.copies++;
        s.l0s.add(hash(e.f.tokensL0.join(" ")));
        if (s.occs.length < 60) {
          s.occs.push({ file: file.path, start: e.f.start, end: e.f.end, line: e.f.line, endLine: e.f.endLine, parent });
        }
      }
    }
  } finally {
    await project.close();
  }
  return { shapes, fragments };
}

export function shingleSet(tokens: readonly string[]): Uint32Array {
  const set = new Set<number>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) set.add(fnv(tokens.slice(i, i + SHINGLE).join(" ")));
  return Uint32Array.from([...set].sort((a, b) => a - b));
}

export function minhash(sh: Uint32Array): Uint32Array {
  const sig = new Uint32Array(MINHASH_PERMS).fill(0xffffffff);
  for (const x of sh)
    for (let p = 0; p < MINHASH_PERMS; p++) {
      const v = mix(x, SEEDS[p]!);
      if (v < sig[p]!) sig[p] = v;
    }
  return sig;
}

/** Kind 3-grams, structure markers dropped, signed ±1 projections. Integer only. */
export function simhash(tokens: readonly string[]): Uint32Array {
  const kinds = tokens.filter((t) => t !== "(" && t !== ")");
  const acc = new Int32Array(SIMHASH_BITS);
  for (let i = 0; i + 3 <= kinds.length; i++) {
    const g = fnv(kinds.slice(i, i + 3).join(" "));
    for (let b = 0; b < SIMHASH_BITS; b++) acc[b]! += (mix(g, SEEDS[b]!) & 1) === 1 ? 1 : -1;
  }
  const words = new Uint32Array(SIMHASH_BITS / 32);
  for (let b = 0; b < SIMHASH_BITS; b++) if (acc[b]! > 0) words[b >> 5]! |= 1 << (b & 31);
  return words;
}

export function minhashBand(s: Shape, band: number): string {
  return Array.from(s.minhash!.subarray(band * ROWS, band * ROWS + ROWS)).join(",");
}

export function simhashBand(s: Shape, band: number): string {
  let v = 0;
  for (let r = 0; r < SIM_ROWS; r++) {
    const bit = band * SIM_ROWS + r;
    v = v * 2 + ((s.simhash![bit >> 5]! >>> (bit & 31)) & 1);
  }
  return String(v);
}

export function jaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length === 0 || b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inter++;
      i++;
      j++;
    } else if (a[i]! < b[j]!) i++;
    else j++;
  }
  return inter / (a.length + b.length - inter);
}

export function overlapsOccs(a: readonly Occ[], b: readonly Occ[]): boolean {
  return a.some((x) => b.some((y) => x.file === y.file && x.start < y.end && y.start < x.end));
}

/** Unit vectors for `items`, cached on disk by L1 hash. */
export async function embedShapes(
  items: readonly Shape[],
  model: string,
  cacheFile: string,
): Promise<{ vectors: Map<string, Float32Array>; fresh: number; ms: number }> {
  const cache: Record<string, number[]> = existsSync(cacheFile)
    ? JSON.parse(readFileSync(cacheFile, "utf8"))
    : {};
  const todo = items.filter((s) => cache[s.l1] === undefined && s.text !== undefined);
  const t = Date.now();
  for (let b = 0; b < todo.length; b += 64) {
    const batch = todo.slice(b, b + 64);
    const res = await fetch("http://localhost:11434/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: batch.map((s) => s.text!.slice(0, 4000)) }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    data.data.forEach((d, k) => (cache[batch[k]!.l1] = d.embedding));
    if ((b / 64) % 20 === 0) {
      process.stderr.write(`embedded ${b + batch.length}/${todo.length}\n`);
      writeFileSync(cacheFile, JSON.stringify(cache));
    }
  }
  writeFileSync(cacheFile, JSON.stringify(cache));
  const vectors = new Map<string, Float32Array>();
  for (const s of items) {
    const v = cache[s.l1];
    if (v === undefined) continue;
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    vectors.set(s.l1, Float32Array.from(v, (x) => x / norm));
  }
  return { vectors, fresh: todo.length, ms: Date.now() - t };
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Fixed-seed shuffle, then the first `n`. */
export function pick<T>(xs: readonly T[], n: number, seed: number): T[] {
  return xs
    .map((x, k) => ({ x, r: mix(k, seed) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map((e) => e.x);
}
