/**
 * A fixed-size summary of a fragment's shape, for finding near copies.
 *
 * Exact hashing splits near-identical code. An inserted optional field breaks
 * L1 equality, so one template with 24 copies can surface as a 19-copy finding
 * and a 5-copy one. A sketch lets two fragments be compared for "nearly the
 * same shape" without keeping their token streams.
 *
 * The method is one-permutation hashing over 5-shingles of the L2 stream. L2
 * is the L1 stream with identifier text dropped, so a renamed and edited copy
 * still shares most of its shingles. Each shingle is hashed once. Its low bits
 * pick one of `SKETCH_BINS` bins, and the bin keeps the smallest value it
 * sees. Two sketches agree in a bin about as often as their shingle sets
 * overlap. Measured against exact Jaccard on 6,403 pairs at Jaccard ≥ 0.5,
 * the median error was 0.001 and 90% fell within 0.054.
 *
 * Integer arithmetic only, so every host computes the same sketch.
 */

/** Tokens per shingle. The same window `report/variants.ts` uses. */
const SHINGLE = 5;

export const SKETCH_BINS = 128;

/** Marks a bin no shingle landed in. No stored value ever equals it. */
export const EMPTY_BIN = 0xffff;

/**
 * Near means at least NEAR_NUM / NEAR_DEN of the compared bins agree.
 *
 * Blind judges rated near copies of printed findings on two repositories. At
 * Jaccard ≥ 0.8, 70% were worth covering with the finding's abstraction. At
 * 0.7 to 0.8 it was 30%, and below 0.7 it was 15% or less. Controls scored 0%.
 */
const NEAR_NUM = 4;
const NEAR_DEN = 5;

export type Sketch = Uint16Array;

export function sketchOf(tokensL1: readonly string[]): Sketch | undefined {
  if (tokensL1.length < SHINGLE) return undefined;
  // Each token is hashed once, and a shingle combines five token hashes.
  // Hashing each shingle's text instead costs five times as much, and every
  // fragment of a file is sketched, nested ones included.
  const tokens = new Uint32Array(tokensL1.length);
  for (let i = 0; i < tokensL1.length; i++) tokens[i] = tokenHash(tokensL1[i]!);
  const bins = new Uint16Array(SKETCH_BINS).fill(EMPTY_BIN);
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    let h = 0x811c9dc5;
    for (let t = i; t < i + SHINGLE; t++) h = Math.imul(h ^ tokens[t]!, 0x01000193);
    h = mix(h);
    const bin = h & (SKETCH_BINS - 1);
    // The top 16 bits, kept clear of the empty marker.
    const value = Math.min(h >>> 16, EMPTY_BIN - 1);
    if (value < bins[bin]!) bins[bin] = value;
  }
  return bins;
}

/** Bins that agree, out of bins filled on at least one side. */
export function similarity(a: Sketch, b: Sketch): { match: number; of: number } {
  let match = 0;
  let of = 0;
  for (let i = 0; i < SKETCH_BINS; i++) {
    if (a[i] === EMPTY_BIN && b[i] === EMPTY_BIN) continue;
    of++;
    if (a[i] === b[i]) match++;
  }
  return { match, of };
}

export function isNear(a: Sketch, b: Sketch): boolean {
  const { match, of } = similarity(a, b);
  return of > 0 && match * NEAR_DEN >= of * NEAR_NUM;
}

/**
 * FNV-1a of one token, with identifier text dropped: every identifier hashes
 * as `Id`. That is the L2 stream, and it lets a renamed copy match.
 */
function tokenHash(token: string): number {
  const text = token.startsWith("Id:") ? "Id" : token;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A finalizer, so the low bits that pick the bin are well mixed. */
function mix(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
