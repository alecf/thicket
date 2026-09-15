/**
 * Deterministic ordering primitives.
 *
 * The report is a pure function of (source content, config, thicket version),
 * because the harness diffs report N against report N+1 to decide whether a
 * refactor made progress. Any ordering that varies by environment turns a
 * no-op run into apparent churn.
 *
 * **Never use `String.prototype.localeCompare` for anything that reaches the
 * report.** Its result depends on the host's ICU data and on `LANG`/`LC_ALL`,
 * and it disagrees with code-unit order on inputs we handle constantly:
 * under `en-US`, `"src/Util.ts".localeCompare("src/alpha.ts")` is `1` while
 * code-unit order gives `-1`, because locale collation folds case. A repo with
 * a capitalized filename — `App.ts`, `Button.tsx` — hits this on the first
 * sort, and two machines can then emit differently-ordered reports from
 * identical source.
 */

/** Total order on strings by UTF-16 code unit. Environment-independent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Descending by `score`, ties broken ascending by `id`.
 *
 * The tie-break is not cosmetic: findings that score equally are common (mass
 * is a product of small integers), and without a deterministic tie-break their
 * relative order falls out of hash-map iteration.
 */
export function byScoreThenId<T extends { score: number; id: string }>(a: T, b: T): number {
  return b.score - a.score || compareStrings(a.id, b.id);
}

/**
 * The key carrying the largest value, ties broken by key.
 *
 * The tie-break is what makes this belong here rather than at either call
 * site: `Map` iteration follows insertion order, so an argmax that scans the
 * map as-is answers whichever tied key happened to be seen first -- a function
 * of file visit order, not of the graph (AGENTS.md §1). Empty in, `{ key: "",
 * weight: 0 }` out; every caller's values are positive, so a real entry always
 * beats that.
 */
export function heaviestKey(weights: ReadonlyMap<string, number>): {
  key: string;
  weight: number;
} {
  let best = { key: "", weight: 0 };
  for (const [key, weight] of [...weights].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (weight > best.weight) best = { key, weight };
  }
  return best;
}

/** The most frequent value, ties broken by the value itself. See `heaviestKey`. */
export function mostFrequent(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return heaviestKey(counts).key;
}
