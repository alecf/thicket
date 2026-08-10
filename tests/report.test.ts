import { beforeAll, describe, expect, it } from "vitest";
import { findingId } from "../src/report/findings.js";
import { canonicalKind } from "../src/report/kinds.js";
import { renderMarkdown, type ReportInput } from "../src/report/markdown.js";
import type { Ranked } from "../src/report/rank.js";
import { initHash } from "../src/hash.js";

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

const twoModuleCycle = {
  id: "THK-CYC-1",
  modules: ["src/alpha.ts", "src/gamma.ts"],
  edges: [
    { from: "src/alpha.ts", to: "src/gamma.ts", weight: 3 },
    { from: "src/gamma.ts", to: "src/alpha.ts", weight: 1 },
  ],
  cuts: [{ from: "src/gamma.ts", to: "src/alpha.ts" }],
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
  cycles: [],
  totalFindings: 0,
};

describe("renderMarkdown", () => {
  it("always states how many findings were omitted", () => {
    const out = renderMarkdown({ ...base, totalFindings: 495 });
    expect(out).toMatch(/of 495/);
    expect(out).toMatch(/… 495 further findings omitted/);
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

  it("caps the locations one finding may spend the budget on", () => {
    // Unbounded, a single finding listed 429 file paths -- thousands of tokens
    // for one entry, in a report whose entire point is fitting a context
    // window. The count of what was withheld is stated, and the JSON sidecar
    // still carries every occurrence for a harness that wants them all.
    const many = ranked("THK-DUP-many", {
      occurrences: Array.from({ length: 40 }, (_, i) => ({
        filePath: `src/f${String(i).padStart(2, "0")}.ts`,
        start: 0,
        end: 100,
        line: 3,
        endLine: 9,
        parentId: i,
      })),
    });
    const out = renderMarkdown({ ...base, duplication: [many], totalFindings: 1 });
    expect(out).toMatch(/^- … and 34 more files$/m);
    expect(out).not.toContain("src/f39.ts");
    // Whatever it does show must still be the first files in sorted order, so
    // two runs over the same tree truncate to the same list.
    expect(out).toContain("- `src/f00.ts:3`");
  });

  it("caps the line numbers listed for any one file", () => {
    // Capping files alone leaves the same blowout in a different shape: one
    // path followed by 200 comma-separated line numbers.
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
    expect(locations).toBe("- `src/table.ts:1,6,11,16,21,26,31,36+22`");
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
    const tight = renderMarkdown({ ...base, duplication, totalFindings: 20, budgetTokens: 200 });

    expect(full).toMatch(/\| findings \| 20 of 20 shown \|/);
    expect(full).not.toMatch(/further findings omitted/);

    const emitted = [...tight.matchAll(/^### THK-DUP-/gm)].length;
    expect(emitted).toBeGreaterThan(0);
    expect(emitted).toBeLessThan(20);
    expect(tight).toContain(`| findings | ${emitted} of 20 shown |`);
    expect(tight).toContain(`… ${20 - emitted} further findings omitted`);
    // The whole report, omitted line included, must fit the budget.
    expect(Math.ceil(tight.length / 4)).toBeLessThanOrEqual(200);
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
    expect(out).toContain("… 1 further findings omitted");
    expect(out).not.toContain("THK-DUP-1");
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
