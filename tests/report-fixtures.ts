/**
 * Shared builders for the hand-assembled `ReportInput`s that the three
 * rendering suites (report, markdown-validity, cycle-diagram) feed to
 * `renderMarkdown`.
 *
 * These were three copies, and AGENTS.md records what that costs: adding a
 * required `typeDuplication` to `Census` broke nothing at runtime, because
 * vitest transpiles without typechecking, so the three literals that never got
 * the field went on passing and only `bun run typecheck` ever saw them. One
 * builder makes the next required field a single compile error instead of
 * three places quietly lagging.
 *
 * Deliberately NOT shared: each suite's `ranked` builder. They take different
 * overrides -- one `Partial<Ranked>`, the other `Partial<Ranked["cluster"]>`
 * plus a score -- because the suites vary different things, and collapsing
 * them would mean a signature that serves neither.
 */
import type { Census } from "../src/report/census.js";
import type { ReportInput, TangleEdge } from "../src/report/markdown.js";

/**
 * A tangle edge. `files` defaults to one synthetic importer, because the
 * report prints file counts and a zero-length list would make every edge look
 * free to cut.
 */
export const edge = (
  from: string,
  to: string,
  weight: number,
  over: Partial<TangleEdge> = {},
): TangleEdge => ({
  from,
  to,
  weight,
  files: [`${from}/importer.ts`],
  erased: 0,
  topTarget: { path: `${to}/index.ts`, weight },
  passThrough: 0,
  typeOnly: false,
  ...over,
});

const EMPTY_CENSUS: Census = {
  duplication: 0,
  cycles: 0,
  bands: [],
  typeDuplication: 0,
  testDuplication: 0,
  singleFile: 0,
};

/**
 * An empty report over a four-file, two-module project.
 *
 * `census` merges rather than replaces, so a suite names only the terms it
 * actually populates. That is what makes a new required `Census` field one
 * compile error here instead of three literals that never got it -- restating
 * the whole census at each call site would put the copies straight back.
 *
 * The partition itself (`duplication + testDuplication + cycles ===
 * totalFindings`) is not checked here and is not weakened by the zeroes: it is
 * asserted in e2e.test.ts against a real run over tests/fixtures/census, where
 * every term is non-zero.
 */
export const reportInput = (
  over: Partial<Omit<ReportInput, "census">> & { census?: Partial<Census> } = {},
): ReportInput => ({
  version: "0.1.0",
  configHash: "abc123",
  fileCount: 4,
  lineCount: 60,
  granularity: "dir:1",
  moduleCount: 2,
  metrics: {
    duplicatedMass: 100,
    redundantByteFraction: 0.05,
    propagationCost: 0.5,
    cycleCount: 1,
    largestScc: 2,
  },
  scope: { analyzed: 4, onDisk: 4, complete: true, gaps: [] },
  duplication: [],
  typeDuplication: [],
  testDuplication: [],
  cycles: [],
  totalFindings: 0,
  ...over,
  census: { ...EMPTY_CENSUS, ...over.census },
});
