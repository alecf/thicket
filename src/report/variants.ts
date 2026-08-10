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

function push(map: Map<string, Variant[]>, id: string, variant: Variant): void {
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
