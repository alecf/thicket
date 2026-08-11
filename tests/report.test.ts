import { beforeAll, describe, expect, it } from "vitest";
import { findingId } from "../src/report/findings.js";
import { canonicalKind } from "../src/report/kinds.js";
import {
  renderMarkdown,
  type ReportInput,
  type TangleEdge,
} from "../src/report/markdown.js";
import type { Ranked } from "../src/report/rank.js";
import { initHash } from "../src/hash.js";

/**
 * A tangle edge. `files` defaults to one synthetic importer, because the
 * report prints file counts and a zero-length list would make every edge look
 * free to cut.
 */
const edge = (from: string, to: string, weight: number, over: Partial<TangleEdge> = {}): TangleEdge => ({
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

beforeAll(async () => {
  await initHash();
});

describe("findingId", () => {
  it("is stable for the same content", () => {
    expect(findingId("DUP", "abc")).toBe(findingId("DUP", "abc"));
  });

  it("encodes the kind as a prefix", () => {
    expect(findingId("DUP", "abc")).toMatch(/^THK-DUP-[0-9a-f]{8}$/);
    expect(findingId("CYC", "abc")).toMatch(/^THK-CYC-[0-9a-f]{8}$/);
  });

  it("differs for different content", () => {
    expect(findingId("DUP", "abc")).not.toBe(findingId("DUP", "abd"));
  });
});

describe("canonicalKind", () => {
  it("resolves range-marker aliases to real kind names", () => {
    expect(canonicalKind("FirstLiteralToken")).toBe("NumericLiteral");
    expect(canonicalKind("FirstStatement")).toBe("VariableStatement");
  });

  it("passes through names that are not aliases", () => {
    expect(canonicalKind("Block")).toBe("Block");
    expect(canonicalKind("SomethingUnknown")).toBe("SomethingUnknown");
  });
});

const ranked = (id: string, over: Partial<Ranked["cluster"]> = {}, score = 100): Ranked => ({
  score,
  tag: "source",
  linesPerCopy: 9,
  recoverableLines: 16,
  cluster: {
    id,
    level: "L0",
    kind: "Block",
    nodeCount: 20,
    mass: 40,
    occurrences: [
      { filePath: "src/alpha.ts", start: 60, end: 300, line: 4, endLine: 12, parentId: 1 },
      { filePath: "src/alpha.ts", start: 400, end: 640, line: 16, endLine: 24, parentId: 2 },
      { filePath: "src/beta.ts", start: 10, end: 250, line: 2, endLine: 10, parentId: 3 },
    ],
    ...over,
  },
});

/** A dependents record with nothing hidden behind a barrel. */
const deps = (direct: number, throughBarrels = 0, barrels: string[] = []) => ({
  direct,
  throughBarrels,
  barrels,
});

const twoModuleCycle = {
  id: "THK-CYC-1",
  modules: ["src/alpha.ts", "src/gamma.ts"],
  edges: [
    edge("src/alpha.ts", "src/gamma.ts", 3),
    edge("src/gamma.ts", "src/alpha.ts", 1),
  ],
  cuts: [edge("src/gamma.ts", "src/alpha.ts", 1)],
  residual: 1,
};

const base: ReportInput = {
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
  testDuplication: [],
  cycles: [],
  totalFindings: 0,
  census: { duplication: 0, cycles: 0, bands: [], testDuplication: 0, singleFile: 0 },
};

describe("renderMarkdown", () => {
  it("always states how many findings were omitted", () => {
    const out = renderMarkdown({
      ...base,
      totalFindings: 495,
      census: { duplication: 494, cycles: 1, bands: [], testDuplication: 0, singleFile: 0 },
    });
    expect(out).toMatch(/of 495/);
    expect(out).toContain("495 of 495 findings are not shown above.");
  });

  it("says nothing about scope when the program covered the tree", () => {
    expect(renderMarkdown(base)).not.toMatch(/outside this program/);
  });

  it("warns above the findings when the program covered part of the tree", () => {
    const out = renderMarkdown({
      ...base,
      scope: {
        analyzed: 176,
        onDisk: 6286,
        complete: false,
        gaps: [
          { dir: "apps/web", fileCount: 5262, config: "apps/web/tsconfig.json" },
          { dir: "vendored", fileCount: 848 },
        ],
      },
      duplication: [ranked("THK-DUP-1")],
      totalFindings: 1,
    });
    expect(out).toMatch(/\| analyzed \| 176 of 6286 source files \(2\.8%\) \|/);
    expect(out).toMatch(/6110 source files are outside this program/);
    // The actionable half: the exact argument that closes the gap.
    expect(out).toMatch(/^> - `apps\/web` — 5262 files — `--config apps\/web\/tsconfig\.json`$/m);
    // A directory with no tsconfig of its own still gets counted, without a
    // fabricated --config that would not work.
    expect(out).toMatch(/^> - `vendored` — 848 files$/m);
    // Above the findings, because it changes what every number below it means.
    expect(out.indexOf("outside this program")).toBeLessThan(out.indexOf("THK-DUP-1"));
  });

  const manyFiles = ranked("THK-DUP-many", {
    occurrences: Array.from({ length: 40 }, (_, i) => ({
      filePath: `src/f${String(i).padStart(2, "0")}.ts`,
      start: 0,
      end: 100,
      line: 3,
      endLine: 9,
      parentId: i,
    })),
  });

  it("names every file a finding touches", () => {
    // These lists were capped at six. "… and 34 more files" tells an agent
    // that work remains and gives it no way to reach the work: the only move
    // left is to grep for the shape by hand, which is the job the report was
    // supposed to have already done.
    const out = renderMarkdown({ ...base, duplication: [manyFiles], totalFindings: 1 });
    for (let i = 0; i < 40; i++) {
      expect(out).toContain(`- \`src/f${String(i).padStart(2, "0")}.ts:3\``);
    }
    expect(out).not.toContain("more files");
  });

  it("names every line within a file it touches", () => {
    const repeated = ranked("THK-DUP-repeat", {
      occurrences: Array.from({ length: 30 }, (_, i) => ({
        filePath: "src/table.ts",
        start: i * 100,
        end: i * 100 + 90,
        line: i * 5 + 1,
        endLine: i * 5 + 4,
        parentId: 2,
      })),
    });
    const out = renderMarkdown({ ...base, duplication: [repeated], totalFindings: 1 });
    const locations = out.split("\n").find((l) => l.includes("src/table.ts"))!;
    const lines = Array.from({ length: 30 }, (_, i) => i * 5 + 1).join(",");
    expect(locations).toBe(`- \`src/table.ts:${lines}\``);
  });

  it("summarizes where a long location list lands, above the list", () => {
    // An agent handed a 115-file list wanted to know whether this was one
    // app's convention or a cross-package problem, and counting directories by
    // hand was its only route to the answer. The list itself stays: a
    // different agent called every entry of a 19-file list "the backbone" and
    // used all of them.
    const spread = ranked("THK-DUP-spread", {
      occurrences: Array.from({ length: 20 }, (_, i) => ({
        filePath: i < 12 ? `src/a/f${i}.ts` : i < 18 ? `src/b/f${i}.ts` : `src/c/f${i}.ts`,
        start: 0,
        end: 100,
        line: 3,
        endLine: 9,
        parentId: i,
      })),
    });
    const out = renderMarkdown({ ...base, duplication: [spread], totalFindings: 1 });
    expect(out).toContain(
      "- **spread across 3 directories:** `src/a` ×12, `src/b` ×6, `src/c` ×2",
    );
    expect(out.indexOf("spread across")).toBeLessThan(out.indexOf("- `src/a/f0.ts"));
    // Additive, never a replacement.
    expect(out).toContain("- `src/c/f19.ts:3`");
  });

  it("does not summarize a location list short enough to read", () => {
    // Below the threshold the list IS the summary, and a header restating it
    // is a line of noise on every small finding in the report.
    const out = renderMarkdown({ ...base, duplication: [ranked("THK-DUP-1")], totalFindings: 1 });
    expect(out).not.toContain("spread across");
  });

  it("names only the largest directories and counts the rest", () => {
    const many = ranked("THK-DUP-many-dirs", {
      occurrences: Array.from({ length: 20 }, (_, i) => ({
        filePath: `src/d${String(i).padStart(2, "0")}/f.ts`,
        start: 0,
        end: 100,
        line: 3,
        endLine: 9,
        parentId: i,
      })),
    });
    const out = renderMarkdown({ ...base, duplication: [many], totalFindings: 1 });
    expect(out).toContain("**spread across 20 directories:**");
    expect(out).toContain("… and 17 more directories");
  });

  it("caps the files per finding only when asked to", () => {
    // The escape hatch for a caller that would rather truncate a finding than
    // lose it whole to a token budget. What it withheld is stated, and the
    // JSON sidecar still carries every occurrence.
    const out = renderMarkdown({
      ...base,
      duplication: [manyFiles],
      totalFindings: 1,
      maxFilesPerFinding: 6,
    });
    expect(out).toMatch(/^- … and 34 more files$/m);
    expect(out).not.toContain("src/f39.ts");
    // What it does show must be the first files in sorted order, so two runs
    // over the same tree truncate to the same list.
    expect(out).toContain("- `src/f00.ts:3`");
  });

  it("names the abstraction every copy already imports", () => {
    // The fact that decided a real finding. Without it the entry reads as
    // "design a new abstraction for 19 classes"; with it, as "they all already
    // extend this, delete the overrides".
    const out = renderMarkdown({
      ...base,
      duplication: [
        {
          ...ranked("THK-DUP-1"),
          context: {
            sharedImports: [{ path: "models/VitalObservation.ts" }],
            dependents: deps(5),
          },
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain("- **every copy imports:** `models/VitalObservation.ts`");
    expect(out).toContain("- **directly imported by:** 5 files outside the cluster");
    // Above the excerpt and the locations, because it changes what the reader
    // is looking at before they look at it.
    expect(out.indexOf("every copy imports")).toBeLessThan(out.indexOf("src/alpha.ts"));
  });

  it("says nothing about shared imports when the copies share none", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [{ ...ranked("THK-DUP-1"), context: { sharedImports: [], dependents: deps(2) } }],
      totalFindings: 1,
    });
    expect(out).not.toContain("every copy imports");
    expect(out).toContain("- **directly imported by:** 2 files outside the cluster");
  });

  it("reports a self-contained cluster as reached by nothing", () => {
    // Zero is an answer, not a missing one: nothing outside imports these, so
    // the extraction cannot break a caller.
    const out = renderMarkdown({
      ...base,
      duplication: [{ ...ranked("THK-DUP-1"), context: { sharedImports: [], dependents: deps(0) } }],
      totalFindings: 1,
    });
    expect(out).toContain("- **directly imported by:** nothing outside the cluster");
  });

  it("agrees with itself on singular and plural dependents", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [{ ...ranked("THK-DUP-1"), context: { sharedImports: [], dependents: deps(1) } }],
      totalFindings: 1,
    });
    expect(out).toContain("- **directly imported by:** 1 file outside the cluster");
  });

  it("follows a re-export shim to what it stands in front of", () => {
    // The field exists to point at the abstraction that already exists. On a
    // real finding it named a nine-line `export * from` and stopped, leaving
    // the 1012-line base class the whole refactor turns on to be found by hand.
    const out = renderMarkdown({
      ...base,
      duplication: [
        {
          ...ranked("THK-DUP-1"),
          context: {
            sharedImports: [
              { path: "models/vitals/VitalObservation.ts", forwardsTo: "packages/models/src/wearables/VitalObservation.ts" },
            ],
            dependents: deps(1),
          },
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain(
      "- **every copy imports:** `models/vitals/VitalObservation.ts` →" +
        " `packages/models/src/wearables/VitalObservation.ts`",
    );
  });

  it("says how many more files reach the cluster through a barrel", () => {
    // The direct count alone was a floor presented as a total: 5 files, one of
    // them an `index.ts` that 17 more went through. An agent could not
    // reconcile 5 with what it found and concluded the number was a bug.
    const out = renderMarkdown({
      ...base,
      duplication: [
        {
          ...ranked("THK-DUP-1"),
          context: { sharedImports: [], dependents: deps(5, 17, ["models/vitals/index.ts"]) },
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain(
      "- **directly imported by:** 5 files outside the cluster, and 17 files more" +
        " through `models/vitals/index.ts`",
    );
  });

  it("says nothing about who imports a cluster of test files", () => {
    // Nothing imports a test file, so the line is a guaranteed constant
    // dressed as evidence -- and it answers the opposite of the question that
    // decides a test finding, which is what the copies depend ON.
    const out = renderMarkdown({
      ...base,
      testDuplication: [
        {
          ...ranked("THK-DUP-T", {
            occurrences: [
              { filePath: "src/a.test.ts", start: 0, end: 10, line: 1, endLine: 4, parentId: 1 },
              { filePath: "src/b.test.ts", start: 0, end: 10, line: 1, endLine: 4, parentId: 2 },
            ],
          }),
          tag: "test",
          context: { sharedImports: [], dependents: deps(0) },
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain("## Duplication in tests");
    expect(out).not.toContain("directly imported by");
  });

  it("points at the same shape sitting in different surroundings", () => {
    // The line that reverses a plan. 115 copies of a `matchMedia` stub read as
    // "extract a helper into 115 files" until you know the identical block is
    // already in the project's Vitest setup file behind one extra guard, at
    // which point all 115 are dead code and the move is to delete them.
    const out = renderMarkdown({
      ...base,
      duplication: [
        {
          ...ranked("THK-DUP-1", {
            alsoAt: [
              { filePath: "apps/web/vitest.setup.tsx", start: 0, end: 9, line: 36, endLine: 50, parentId: 1 },
              { filePath: "apps/web/lib/test/match-media.ts", start: 0, end: 9, line: 11, endLine: 25, parentId: 2 },
            ],
          }),
          context: { sharedImports: [], dependents: deps(0) },
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain(
      "- **same shape in other surroundings:** `apps/web/vitest.setup.tsx:36`," +
        " `apps/web/lib/test/match-media.ts:11`",
    );
  });

  it("counts the same-shape locations it does not name", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [
        {
          ...ranked("THK-DUP-1", {
            alsoAt: Array.from({ length: 9 }, (_, i) => ({
              filePath: `src/other${i}.ts`,
              start: 0,
              end: 9,
              line: 3,
              endLine: 8,
              parentId: i,
            })),
          }),
          context: { sharedImports: [], dependents: deps(0) },
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain("`src/other0.ts:3`, `src/other1.ts:3`, `src/other2.ts:3`, and 6 more files");
  });

  it("says nothing about other surroundings when there are none", () => {
    const out = renderMarkdown({ ...base, duplication: [ranked("THK-DUP-1")], totalFindings: 1 });
    expect(out).not.toContain("other surroundings");
  });

  it("cross-references a finding that is nearly the same shape", () => {
    // Two entries that are one template and its near-copy read as unrelated
    // work without this line, so acting on the report leaves the variant
    // behind and costs a second visit.
    const out = renderMarkdown({
      ...base,
      duplication: [
        {
          ...ranked("THK-DUP-1"),
          context: { sharedImports: [], dependents: deps(0) },
          variants: [{ id: "THK-DUP-2", similarity: 0.8125, copies: 5 }],
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain("- **see also `THK-DUP-2`:** 81% the same shape, 5 more copies");
  });

  it("agrees with itself on singular and plural copies of a variant", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [
        {
          ...ranked("THK-DUP-1"),
          context: { sharedImports: [], dependents: deps(0) },
          variants: [{ id: "THK-DUP-2", similarity: 0.7, copies: 1 }],
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain("70% the same shape, 1 more copy");
  });

  it("contains no timestamps or absolute paths", () => {
    const out = renderMarkdown({ ...base, duplication: [ranked("THK-DUP-1")], totalFindings: 1 });
    expect(out).not.toMatch(/\/Users\//);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("is byte-identical across renders", () => {
    const input = { ...base, duplication: [ranked("THK-DUP-1")], totalFindings: 1 };
    expect(renderMarkdown(input)).toBe(renderMarkdown(input));
  });

  it("groups occurrences by file with 1-based line numbers", () => {
    const out = renderMarkdown({ ...base, duplication: [ranked("THK-DUP-1")], totalFindings: 1 });
    expect(out).toContain("- `src/alpha.ts:4,16`\n- `src/beta.ts:2`");
    // A byte offset must not leak into the body in place of a line.
    expect(out).not.toContain("src/alpha.ts:60");
  });

  it("prints the canonical kind name, not a range-marker alias", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-1", { kind: "FirstStatement" })],
      totalFindings: 1,
    });
    expect(out).toContain("VariableStatement");
    expect(out).not.toContain("FirstStatement");
  });

  it("explains what L0 and L1 mean, once per section", () => {
    // `L0` is the single most load-bearing field on a duplication finding and
    // it is two characters with no legend anywhere. It decides cluster
    // membership and therefore whether the location list is complete: an
    // agent handed a 115-copy L0 finding assumed 115 was the total, and it
    // was 115 of ~130 for that literal shape, the rest differing only in the
    // order of two object keys.
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-1"), ranked("THK-DUP-2")],
      testDuplication: [ranked("THK-DUP-3")],
      totalFindings: 3,
    });
    expect(out).toContain("`L0` matches copies that are identical once formatting is normalized");
    expect(out).toContain("`L1` also ignores what identifiers are called");
    // Once per section, not once per finding -- and the test section gets it
    // too, because a reader may open the report at either one.
    expect(out.split("`L0` matches copies").length - 1).toBe(2);
  });

  it("does not print the ranker's score", () => {
    // An internal sort key leaking into the output. The report is already in
    // score order, so the number ranks nothing the reader can act on -- and on
    // an all-test cross-module cluster the weights multiply to 1.0, making it
    // print the recoverable-lines figure a second time and read as a bug.
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-1", {}, 2787)],
      totalFindings: 1,
    });
    expect(out).not.toContain("score");
    expect(out).not.toContain("2787");
    // The fields that survive still identify the finding.
    expect(out).toContain("L0 · `Block`");
  });

  it("marks test and mixed clusters", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [{ ...ranked("THK-DUP-1"), tag: "mixed" }],
      totalFindings: 1,
    });
    expect(out).toContain("[mixed]");
  });

  it("emits cycles with their suggested cuts", () => {
    const out = renderMarkdown({ ...base, cycles: [twoModuleCycle], totalFindings: 1 });
    expect(out).toContain("## Module tangle");
    expect(out).toContain("THK-CYC-1");
    expect(out).toContain("`src/gamma.ts` → `src/alpha.ts`");
  });

  it("emits fewer findings under a small budget and states the true omitted count", () => {
    const duplication = Array.from({ length: 20 }, (_, i) => ranked(`THK-DUP-${i}`, {}, 100 - i));
    const full = renderMarkdown({ ...base, duplication, totalFindings: 20 });
    // Tight enough to bite, loose enough to fit the header, the Summary and
    // the Omitted section, which are reserved before any finding is priced.
    const tight = renderMarkdown({ ...base, duplication, totalFindings: 20, budgetTokens: 320 });

    expect(full).toMatch(/\| findings \| 20 of 20 shown \|/);
    expect(full).not.toMatch(/## Omitted/);

    const emitted = [...tight.matchAll(/^### THK-DUP-/gm)].length;
    expect(emitted).toBeGreaterThan(0);
    expect(emitted).toBeLessThan(20);
    expect(tight).toContain(`| findings | ${emitted} of 20 shown |`);
    expect(tight).toContain(`${20 - emitted} of 20 findings are not shown above.`);
    // The whole report, omitted line included, must fit the budget.
    expect(Math.ceil(tight.length / 4)).toBeLessThanOrEqual(320);
  });

  it("keeps the header and summary even when the budget cannot fit one finding", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-1")],
      totalFindings: 1,
      budgetTokens: 1,
    });
    expect(out).toContain("# thicket report");
    expect(out).toContain("## Summary");
    expect(out).toContain("| findings | 0 of 1 shown |");
    expect(out).toContain("1 of 1 findings are not shown above.");
    expect(out).not.toContain("THK-DUP-1");
  });

  it("keeps test duplication in a section of its own, below production work", () => {
    // 10 of the top 40 on a real application were test scaffolding -- 231
    // copies of `{ info: vi.fn(), warn: vi.fn() }` and the like. No setting of
    // the test weight fixed that without also discarding real findings, so the
    // two kinds of work stopped competing for a slot instead.
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-src")],
      testDuplication: [ranked("THK-DUP-mock")],
      totalFindings: 2,
      census: { duplication: 1, cycles: 0, bands: [], testDuplication: 1, singleFile: 0 },
    });
    expect(out).toContain("## Duplication in tests");
    expect(out.indexOf("## Duplication")).toBeLessThan(out.indexOf("## Duplication in tests"));
    expect(out.indexOf("THK-DUP-src")).toBeLessThan(out.indexOf("THK-DUP-mock"));
  });

  it("spends a tight budget on production duplication before test duplication", () => {
    // The ordering above is also the truncation order: under pressure the
    // report keeps the work it exists to rank.
    const out = renderMarkdown({
      ...base,
      duplication: Array.from({ length: 10 }, (_, i) => ranked(`THK-DUP-src${i}`, {}, 100 - i)),
      testDuplication: [ranked("THK-DUP-mock")],
      totalFindings: 11,
      census: { duplication: 10, cycles: 0, bands: [], testDuplication: 1, singleFile: 0 },
      budgetTokens: 400,
    });
    expect(out).toContain("THK-DUP-src0");
    expect(out).not.toContain("THK-DUP-mock");
  });

  it("names the test section even when production duplication is empty", () => {
    const out = renderMarkdown({
      ...base,
      testDuplication: [ranked("THK-DUP-mock")],
      totalFindings: 2,
      census: { duplication: 0, cycles: 0, bands: [], testDuplication: 2, singleFile: 0 },
    });
    expect(out).toContain("## Duplication in tests");
    expect(out).not.toContain("## Duplication\n");
  });

  it("breaks the omitted tail down by category and by size", () => {
    // A bare "18768 further findings omitted" is equally consistent with a
    // codebase drowning in cycles, with one tangle restated thousands of
    // times, and with thresholds that admit mostly noise -- three findings
    // that call for three different responses. The split settles the first
    // two and the histogram settles the third.
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-1")],
      cycles: [],
      totalFindings: 18808,
      census: {
        duplication: 18806,
        cycles: 2,
        bands: [
          { label: "100+", count: 210 },
          { label: "30–99", count: 1612 },
          { label: "1–3", count: 5598 },
        ],
        testDuplication: 9389,
        singleFile: 9382,
      },
    });
    expect(out).toContain("## Omitted");
    expect(out).toContain("18807 of 18808 findings are not shown above.");
    expect(out).toContain("| duplication | 18806 | 1 |");
    expect(out).toContain("| module tangle | 2 | 0 |");
    expect(out).toContain("| 100+ | 210 |");
    expect(out).toContain("| 1–3 | 5598 |");
    expect(out).toContain("| duplication in tests | 9389 | 0 |");
    // Worded so it cannot be read as one particular file whose name is being
    // withheld: this is a per-candidate property holding across thousands.
    expect(out).toContain(
      "9382 of those candidates repeat each within one file rather than across files",
    );
  });

  it("counts shown cycles against the tangle row, not the duplication row", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-1")],
      cycles: [
        {
          id: "THK-CYC-1",
          modules: ["a", "b"],
          edges: [
            edge("a", "b", 1),
            edge("b", "a", 1),
          ],
          cuts: [],
          residual: 1,
        },
      ],
      totalFindings: 50,
      census: { duplication: 47, cycles: 3, bands: [], testDuplication: 0, singleFile: 0 },
    });
    expect(out).toContain("| duplication | 47 | 1 |");
    expect(out).toContain("| module tangle | 3 | 1 |");
  });

  it("says nothing about omissions when it printed everything", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-1")],
      totalFindings: 1,
      census: { duplication: 1, cycles: 0, bands: [{ label: "10–29", count: 1 }], testDuplication: 0, singleFile: 0 },
    });
    expect(out).not.toContain("## Omitted");
  });

  it("emits findings in the order given", () => {
    const out = renderMarkdown({
      ...base,
      duplication: [ranked("THK-DUP-aaa", {}, 100), ranked("THK-DUP-bbb", {}, 50)],
      totalFindings: 2,
    });
    expect(out.indexOf("THK-DUP-aaa")).toBeLessThan(out.indexOf("THK-DUP-bbb"));
  });
});
