import { isTypeKind } from "./kinds.js";
import { isTestMajority, type Ranked } from "./rank.js";

/**
 * What the report did not print.
 *
 * A run over a real application produced 18,808 candidates against a budget of
 * 40, and the report said only "18,768 further findings omitted". That number
 * is unreadable on its own: it is equally consistent with a codebase drowning
 * in cycles, with one tangle restated thousands of times, and with thresholds
 * so low that almost every candidate is noise — and those call for three
 * different responses. (It was the third: 62% of candidates recover fewer than
 * ten lines, and exactly two were cycles.)
 *
 * So the tail gets summarized rather than counted. This is a census of ALL
 * candidates, not only the omitted ones, because the question a reader is
 * actually asking is "what is the shape of the pile the top forty came off".
 */
export interface Census {
  /** Production-majority duplication candidates found, before any truncation. */
  duplication: number;
  /** Type-system duplication candidates, the report's own section for them. */
  typeDuplication: number;
  /** Test-majority duplication candidates, the report's second section. */
  testDuplication: number;
  /** Cycle findings found, before any truncation. */
  cycles: number;
  /** Duplication candidates per band, most valuable band first. */
  bands: { label: string; count: number }[];
  /** Candidates whose every occurrence is in one file. */
  singleFile: number;
}

/**
 * Band edges in recoverable lines, as `[label, inclusive lower bound]`.
 *
 * Chosen against the reader's actual decision rather than to make an even
 * histogram: thirty lines duplicated is a refactor, three is not, and ten is
 * about where the argument starts. Every candidate lands in exactly one band
 * because the bands are read top down.
 */
const BANDS: readonly [string, number][] = [
  ["100+", 100],
  ["30–99", 30],
  ["10–29", 10],
  ["4–9", 4],
  ["1–3", 1],
  ["0", 0],
];

export function census(ranked: readonly Ranked[], cycles: number): Census {
  const bands = BANDS.map(([label]) => ({ label, count: 0 }));
  let duplication = 0;
  let typeDuplication = 0;
  let testDuplication = 0;
  let singleFile = 0;

  for (const r of ranked) {
    // Same order the report splits on, so the census counts what each section
    // would actually hold rather than a fourth categorization of its own.
    if (isTestMajority(r.cluster)) {
      testDuplication += 1;
    } else if (isTypeKind(r.cluster.kind)) {
      typeDuplication += 1;
    } else {
      duplication += 1;
      // Banded over production candidates only, matching the section the
      // histogram sits under. Mixing test scaffolding back in would restate
      // the pile the split exists to separate.
      const band = BANDS.findIndex(([, floor]) => r.recoverableLines >= floor);
      // `findIndex` cannot miss: the last band's floor is 0 and recoverableLines
      // is clamped at 0. Guarded anyway so a future edit to BANDS that breaks
      // that cannot silently drop candidates out of the census.
      if (band !== -1) bands[band]!.count += 1;
    }
    if (new Set(r.cluster.occurrences.map((o) => o.filePath)).size === 1) singleFile += 1;
  }

  return {
    duplication,
    typeDuplication,
    testDuplication,
    cycles,
    // An all-zero band is noise in a table whose job is to be scanned.
    bands: bands.filter((b) => b.count > 0),
    singleFile,
  };
}
