import { compareStrings } from "../order.js";

/**
 * Another finding that is nearly the same shape as this one.
 *
 * A report was handed to an agent, which reported back that the top finding's
 * cluster "is 24, not 19" -- five more classes sat two lines from the template
 * and it had to go find them. They were not missing: they were finding #5, a
 * cluster of their own, because L1 equality is exact once identifiers are
 * renamed and an inserted optional field breaks it. Nothing said the two
 * entries were variants of one template, so acting on the report alone leaves
 * five near-identical files behind and a second visit to make.
 */
export interface Variant {
  /** The other finding's id. */
  id: string;
  /** Shingle Jaccard in [0, 1], for the reader to judge how alike they are. */
  similarity: number;
  /** How many copies the other finding carries. */
  copies: number;
}

export interface VariantInput {
  id: string;
  /** L1 token stream of a representative occurrence. */
  tokens: readonly string[];
  occurrences: readonly { filePath: string; start: number; end: number }[];
  copies: number;
}

/**
 * Tokens per shingle.
 *
 * Long enough that two fragments sharing only the language's common phrasing
 * -- `( ) => {`, `await`, a property access -- do not look alike, short enough
 * that a shape surviving a one-statement insertion still matches on either
 * side of it.
 */
const SHINGLE = 5;

/**
 * Jaccard above which two findings are called variants of one shape.
 *
 * Measured rather than guessed. Over the top 40 findings of a real application
 * -- 758 non-overlapping pairs -- similarity was 0.813 for the one pair that
 * genuinely was a template and its near-copy, 0.462 for the next pair (two
 * unrelated methods), and below 0.31 for everything else. The threshold sits
 * in the empty band between the signal and the noise, closer to the noise so
 * that a slightly-less-similar real variant is still caught.
 */
const VARIANT_SIMILARITY = 0.6;

/** Variants named per finding, most alike first. */
const MAX_VARIANTS = 3;

export function findVariants(inputs: readonly VariantInput[]): Map<string, Variant[]> {
  const shingles = inputs.map((input) => shingle(input.tokens));
  const out = new Map<string, Variant[]>();

  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      const a = inputs[i]!;
      const b = inputs[j]!;
      // PRD §5.4's fifth hazard, and it is not hypothetical: on that same real
      // report the two most similar pairs of all scored 1.000 and 0.921, and
      // both were a fragment beside its own ancestor. Exact hashing is immune
      // to this; anything measuring similarity is not.
      if (overlaps(a, b)) continue;
      const similarity = jaccard(shingles[i]!, shingles[j]!);
      if (similarity < VARIANT_SIMILARITY) continue;
      push(out, a.id, { id: b.id, similarity, copies: b.copies });
      push(out, b.id, { id: a.id, similarity, copies: a.copies });
    }
  }

  for (const [id, variants] of out) {
    variants.sort((x, y) => y.similarity - x.similarity || compareStrings(x.id, y.id));
    out.set(id, variants.slice(0, MAX_VARIANTS));
  }
  return out;
}

function push<T>(map: Map<string, T[]>, id: string, variant: T): void {
  const list = map.get(id);
  if (list) list.push(variant);
  else map.set(id, [variant]);
}

function shingle(tokens: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) out.add(tokens.slice(i, i + SHINGLE).join(" "));
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  // A fragment shorter than one shingle has no signature to compare, so it is
  // dissimilar to everything rather than vacuously identical to every other
  // short fragment.
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** True when any occurrence of one finding sits inside an occurrence of the other. */
function overlaps(a: VariantInput, b: VariantInput): boolean {
  return a.occurrences.some((x) =>
    b.occurrences.some(
      (y) => x.filePath === y.filePath && x.start < y.end && y.start < x.end,
    ),
  );
}

/**
 * Another finding that lives entirely inside this one's files, or one whose
 * files entirely contain this one's.
 *
 * Ten of 59 findings on a real 5540-file application described a single
 * structure: seven sibling files repeating eight different shapes between
 * them, plus two more at a coarser granularity. Two of the ten covered the
 * IDENTICAL seven files. A reader saw ten problems, correctly reconstructed the
 * one, and did the grouping by hand -- which is the failure this exists to
 * stop. Seventeen percent of the report's budget said the same thing.
 *
 * `subsume` cannot see it. That drops a fragment covered by a larger fragment
 * at the same location; these are different shapes sitting side by side in the
 * same files.
 */
export interface CoLocated {
  /** The other finding's id. */
  id: string;
  /**
   * Size of the CONTAINED file set, whichever of the two it is. Both findings
   * report the same number, because both sentences need it: "all 3 of these
   * files also carry X" and "X lives only in 3 of these files".
   */
  files: number;
  /** True when THIS finding is the one fully covered. */
  within: boolean;
  /** How many copies the other finding carries. */
  copies: number;
}

/** Co-located findings named per finding, largest first. */
const MAX_CO_LOCATED = 3;

/**
 * Link findings whose file sets nest, in both directions.
 *
 * Containment rather than similarity, and that is the whole design. Measured
 * over the 59 findings of a real report, file-set Jaccard decayed smoothly from
 * 1.0 with no empty band anywhere -- 174 overlapping pairs spread across every
 * bucket -- so a threshold would have been picked out of the air. AGENTS.md
 * records what that costs: a knob swept smoothly to zero means every setting
 * was arbitrary.
 *
 * Containment needs no number and states something a reader can act on.
 * Visiting the covering finding's files reaches every copy of the covered one,
 * so the two are one trip. A partial overlap promises nothing of the kind, and
 * the same measurement found 23 nesting pairs among those 174.
 */
export function findCoLocated(inputs: readonly VariantInput[]): Map<string, CoLocated[]> {
  const fileSets = inputs.map((input) => new Set(input.occurrences.map((o) => o.filePath)));
  // `of` is the OTHER finding's file count, which orders the list. It is not
  // `files`, and the difference only shows up in one direction: a finding
  // contained by several larger ones reports its own size for every link, so
  // sorting on `files` leaves the id as the only tie-break and can drop the
  // broadest relative. Stripped before returning, because a reader is never
  // shown it.
  const out = new Map<string, (CoLocated & { of: number })[]>();

  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      // Containment first. It costs one scan of the smaller file set, where
      // `overlaps` costs |a.occurrences| × |b.occurrences| -- and on a real
      // report only 23 of 174 overlapping pairs nest, so the expensive test
      // was being paid for every pair that could never produce a link.
      const [fa, fb] = [fileSets[i]!, fileSets[j]!];
      const aInB = subsetOf(fa, fb);
      const bInA = subsetOf(fb, fa);
      if (!aInB && !bInA) continue;
      const a = inputs[i]!;
      const b = inputs[j]!;
      // A finding and the node containing it share every file trivially, and
      // they are one piece of code seen at two granularities. The same hazard
      // `findVariants` guards, reached by a different route: on a real report
      // a Storybook `meta` object and the `parameters` block inside it were
      // two findings over the same 22 files.
      if (overlaps(a, b)) continue;
      // The contained set's size in BOTH directions, because that is the number
      // each sentence needs: "all 3 of these files also carry X" and "X lives
      // only in 3 of these files" are the same 3. Equal sets contain each
      // other, so both are told they are covered.
      const shared = aInB ? fa.size : fb.size;
      push(out, a.id, { id: b.id, files: shared, within: aInB, copies: b.copies, of: fb.size });
      push(out, b.id, { id: a.id, files: shared, within: bInA, copies: a.copies, of: fa.size });
    }
  }

  const named = new Map<string, CoLocated[]>();
  for (const [id, found] of out) {
    found.sort((x, y) => y.of - x.of || compareStrings(x.id, y.id));
    named.set(
      id,
      found.slice(0, MAX_CO_LOCATED).map(({ of: _of, ...rest }) => rest),
    );
  }
  return named;
}

function subsetOf(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const path of a) if (!b.has(path)) return false;
  return true;
}
