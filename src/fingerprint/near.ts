import { typescript } from "../lang/typescript/profile.js";
import { compareStrings } from "../order.js";
import { MAX_LITERAL_SHARE_FOR_L1, type Cluster, type NearOccurrence, type Occurrence } from "./cluster.js";
import type { ShapedFragment } from "./shape.js";
import { EMPTY_BIN, SKETCH_BINS, isNear, similarity, type Sketch } from "./sketch.js";

/**
 * Give each finding the near copies of its shape.
 *
 * Exact hashing splits one template into several findings when a copy gains a
 * line. Each piece then ranks below the whole, and a reader who acts on one
 * leaves the rest behind. This pass reunites them.
 *
 * **Each finding takes only what is near itself.** PRD §5.3 planned to group
 * near pairs by union-find. On a real repository at the same threshold, that
 * put 26,318 of 65,150 shapes into one group: A is near B, B is near C, and so
 * on across the codebase. Here a finding is a fixed center. A shape joins it
 * only when the shape's sketch is near the finding's own.
 *
 * **Larger findings go first.** Clusters arrive sorted by mass, so a finding
 * whose shape is near a larger one is folded into it. Its copies become near
 * copies there, and it is not reported on its own. A finding folded away does
 * not take near copies of its own, so it cannot chain either.
 *
 * Pure: the same clusters and fragments give the same result in any
 * fragment order. Shapes are visited in hash order, never in Map order.
 */
export function attachNear(
  clusters: readonly Cluster[],
  fragments: readonly ShapedFragment[],
): Cluster[] {
  const shapes = shapesOf(fragments);
  const index = bandIndex(shapes);
  const fragmentAt = new Map<string, ShapedFragment>();
  for (const f of fragments) fragmentAt.set(keyOf(f, f.kind), f);

  // Which finding each copy belongs to, so a near fragment that IS another
  // finding's copy can fold that finding in.
  const owner = new Map<string, Cluster>();
  for (const c of clusters) for (const o of c.occurrences) owner.set(rangeOf(o), c);

  const folded = new Set<Cluster>();
  // Near copies already given to a finding, by file. A later finding may not
  // take a fragment overlapping one, or two findings list the same code at
  // two nesting depths.
  const claimed = new Map<string, Occurrence[]>();
  const nearOf = new Map<Cluster, NearOccurrence[]>();

  // Findings already visited. Folding runs from an earlier, larger finding
  // into a later one, never back: a later finding near an earlier one would
  // otherwise fold it away after it had taken its own near copies.
  const visited = new Set<Cluster>();

  // By mass, then id, whatever order the clusters arrive in. `subsume` does
  // not return them in mass order. On a real report a 3-copy finding was
  // visited before a 34-copy finding of nearly its shape and folded it in.
  // The 34-copy finding ranked third, and the 3-copy finding was not printed,
  // so the report lost it.
  const order = [...clusters].sort((a, b) => b.mass - a.mass || compareStrings(a.id, b.id));

  for (const c of order) {
    if (folded.has(c)) continue;
    visited.add(c);
    const first = fragmentAt.get(keyOf(c.occurrences[0]!, c.kind));
    if (first?.sketch === undefined || !eligible(first) || mostlyTests(c)) continue;
    const own = new Set(c.occurrences.map(rangeOf));
    const accepted: NearOccurrence[] = [];

    // A shape holding another finding's copies goes first, so that finding is
    // folded in whole. Taken in size order instead, the fragment enclosing one
    // of its copies came first, and the finding then kept its copies and
    // listed this one's as near copies of its own.
    const isFinding = (s: Shape) => s.frags.some((f) => {
      const other = owner.get(rangeOf(f));
      return other !== undefined && !visited.has(other) && !folded.has(other);
    });
    const candidates = [...index.candidatesOf(first.sketch)]
      .map((i) => shapes[i]!)
      .filter((s) => s.l1 !== first.l1 && eligible(s.frags[0]!) && isNear(first.sketch!, s.sketch))
      .map((s) => ({ s, finding: isFinding(s) }))
      // Then largest first, so a near fragment wins over the smaller near
      // fragments nested inside it.
      .sort(
        (a, b) =>
          Number(b.finding) - Number(a.finding) ||
          b.s.nodeCount - a.s.nodeCount ||
          compareStrings(a.s.l1, b.s.l1),
      )
      .map((e) => e.s);

    for (const s of candidates) {
      const { match, of } = similarity(first.sketch, s.sketch);
      for (const f of s.frags) {
        const key = rangeOf(f);
        if (own.has(key) || overlaps(f, claimed.get(f.filePath) ?? [])) continue;
        // PRD §2.5's fifth hazard: a fragment beside its own ancestor scores
        // about 0.99. Checked on its own, before the rule below, because a
        // fragment inside one of this finding's copies can also be another
        // finding's copy. On a real report each copy's initializer was a
        // finding of its own, and the finding listed its own bodies as near
        // copies.
        if (overlaps(f, c.occurrences) || overlaps(f, accepted)) continue;
        if (typescript.isTestPath(f.filePath)) continue;
        // Overlapping ANOTHER finding's copy is allowed. Exact findings nest
        // the same way: a function's finding and its loop's finding are both
        // printed. A fragment that IS another finding's copy makes that
        // finding a candidate for folding.
        const other = owner.get(key);
        if (other !== undefined && (folded.has(other) || visited.has(other))) continue;
        accepted.push({
          filePath: f.filePath,
          start: f.start,
          end: f.end,
          line: f.line,
          endLine: f.endLine,
          parentId: f.parentId,
          similarity: match / of,
        });
      }
    }
    if (accepted.length === 0) continue;

    // A finding every copy of which is now a near copy here is folded in.
    // One that is only partly covered keeps its copies, and gives back the
    // ones taken from it, so no bytes are counted twice.
    const takenFrom = new Map<Cluster, number>();
    for (const n of accepted) {
      const other = owner.get(rangeOf(n));
      if (other !== undefined && other !== c) takenFrom.set(other, (takenFrom.get(other) ?? 0) + 1);
    }
    const keep = new Set<string>();
    for (const [other, taken] of takenFrom) {
      if (taken === other.occurrences.length) folded.add(other);
      else for (const o of other.occurrences) keep.add(rangeOf(o));
    }
    const near = accepted
      .filter((n) => !keep.has(rangeOf(n)))
      .sort((a, b) => compareStrings(a.filePath, b.filePath) || a.start - b.start);
    for (const n of near) push(claimed, n.filePath, n);
    if (near.length > 0) nearOf.set(c, near);
  }

  return clusters
    .filter((c) => !folded.has(c))
    .map((c) => {
      const near = nearOf.get(c);
      return near === undefined ? c : { ...c, near };
    });
}

/**
 * Smallest fragment that takes or gives near copies, in AST nodes. Below it,
 * judges rated 1 of 21 near copies worth sharing. A small shape is near many
 * others because there is little of it to differ.
 */
const MIN_NEAR_NODES = 25;

/**
 * Three gates, each set from judged near copies on two repositories.
 *
 * The literal share is the same gate as L1. A fragment that is mostly literal
 * values matches others of its shape whatever the values are, and the values
 * are its content. Judges rated 0 of 11 near copies above it worth sharing.
 */
function eligible(f: ShapedFragment): boolean {
  return (
    f.literalShare < MAX_LITERAL_SHARE_FOR_L1 &&
    f.nodeCount >= MIN_NEAR_NODES &&
    !typescript.nearExcluded.has(f.kind)
  );
}

/**
 * Tests neither take nor give near copies. Two tests with one harness and
 * different assertions look near, and they are different tests. Judges rated
 * 0 of 6 such near copies worth sharing.
 */
function mostlyTests(c: Cluster): boolean {
  const tests = c.occurrences.filter((o) => typescript.isTestPath(o.filePath)).length;
  return tests * 2 >= c.occurrences.length;
}

interface Shape {
  l1: string;
  nodeCount: number;
  sketch: Sketch;
  /** Every fragment of this L1 shape, in (file, start) order. */
  frags: ShapedFragment[];
}

function shapesOf(fragments: readonly ShapedFragment[]): Shape[] {
  const byL1 = new Map<string, ShapedFragment[]>();
  for (const f of fragments) if (f.sketch !== undefined) push(byL1, f.l1, f);
  return [...byL1.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([l1, frags]) => {
      const sorted = [...frags].sort(
        (a, b) => compareStrings(a.filePath, b.filePath) || a.start - b.start || compareStrings(a.kind, b.kind),
      );
      return { l1, nodeCount: Math.min(...sorted.map((f) => f.nodeCount)), sketch: sorted[0]!.sketch!, frags: sorted };
    });
}

/**
 * Bands of the sketch, for candidate lookup.
 *
 * 16 bands of 8 bins. A pair at similarity 0.8 shares at least one band with
 * probability 1 - (1 - 0.8^8)^16, about 0.95.
 *
 * The bands are cut from a densified copy. A 57-node fragment can fill only
 * half its bins, so nearly every band holds an empty one. Skipping those
 * bands found no candidates at all for such a finding, and missed 22 of 31
 * judged near copies on two repositories. Densifying fills each empty bin
 * from the next filled one, offset by the distance, so two sketches with the
 * same values in the same places get the same bands. Only lookup uses it. The
 * near test still compares the raw sketches.
 */
const BANDS = 16;
const ROWS = SKETCH_BINS / BANDS;

/**
 * A band shared by more shapes than this is a common idiom, not a template.
 * Its members are still found through their other bands.
 */
const MAX_BUCKET = 200;

function bandIndex(shapes: readonly Shape[]) {
  const buckets = new Map<number, number[]>();
  shapes.forEach((s, i) => {
    // Only shapes that could be near copies at all. The rest would fill the
    // buckets with small fragments and push real candidates past MAX_BUCKET.
    if (!eligible(s.frags[0]!)) return;
    const dense = densify(s.sketch);
    if (dense === undefined) return;
    for (let b = 0; b < BANDS; b++) push(buckets, bandKey(dense, b), i);
  });
  return {
    candidatesOf(sketch: Sketch): Set<number> {
      const out = new Set<number>();
      const dense = densify(sketch);
      if (dense === undefined) return out;
      for (let b = 0; b < BANDS; b++) {
        const bucket = buckets.get(bandKey(dense, b)) ?? [];
        if (bucket.length > MAX_BUCKET) continue;
        for (const i of bucket) out.add(i);
      }
      return out;
    },
  };
}

/**
 * A number, not a string: an index over every shape of a large repository
 * holds millions of keys. Two bands that collide only add a candidate, and
 * `isNear` rejects it.
 */
function bandKey(dense: Sketch, band: number): number {
  let h = Math.imul(0x811c9dc5 ^ band, 0x01000193);
  for (let r = band * ROWS; r < band * ROWS + ROWS; r++) h = Math.imul(h ^ dense[r]!, 0x01000193);
  return h >>> 0;
}

/** Each empty bin takes the next filled bin's value, plus its distance. */
function densify(sketch: Sketch): Sketch | undefined {
  if (sketch.every((v) => v === EMPTY_BIN)) return undefined;
  const out = new Uint16Array(SKETCH_BINS);
  // One backward pass over two laps, so the bins at the end can borrow from
  // the start. `next` is the nearest filled bin at or after `i`.
  let next = -1;
  for (let i = 2 * SKETCH_BINS - 1; i >= 0; i--) {
    if (sketch[i % SKETCH_BINS] !== EMPTY_BIN) next = i;
    if (i < SKETCH_BINS) out[i] = (sketch[next % SKETCH_BINS]! + (next - i) * 0x9e37) & 0xffff;
  }
  return out;
}

function overlaps(f: { filePath: string; start: number; end: number }, list: readonly Occurrence[]): boolean {
  return list.some((o) => o.filePath === f.filePath && f.start < o.end && o.start < f.end);
}

/**
 * Two fragments can share a byte range, so finding a cluster's own fragment
 * needs the kind too. Everything else is keyed by range alone: a near copy and
 * a finding's copy over the same bytes are the same code.
 */
function keyOf(o: { filePath: string; start: number; end: number }, kind: string): string {
  return `${o.filePath}\u0000${o.start}\u0000${o.end}\u0000${kind}`;
}

function rangeOf(o: { filePath: string; start: number; end: number }): string {
  return `${o.filePath}\u0000${o.start}\u0000${o.end}`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
