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
