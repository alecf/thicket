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
  cluster: {
    id,
    level: "L0",
    kind: "Block",
    nodeCount: 20,
    mass: 40,
    occurrences: [
      { filePath: "src/alpha.ts", start: 60, end: 300, line: 4 },
      { filePath: "src/alpha.ts", start: 400, end: 640, line: 16 },
      { filePath: "src/beta.ts", start: 10, end: 250, line: 2 },
    ],
    ...over,
  },
});

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
    expect(out).toContain("  src/alpha.ts:4,16  src/beta.ts:2");
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
    const out = renderMarkdown({
      ...base,
      cycles: [
        {
          id: "THK-CYC-1",
          modules: ["src/alpha.ts", "src/gamma.ts"],
          cuts: [{ from: "src/gamma.ts", to: "src/alpha.ts" }],
        },
      ],
      totalFindings: 1,
    });
    expect(out).toContain("## Module tangle");
    expect(out).toContain("THK-CYC-1");
    expect(out).toContain("src/gamma.ts→src/alpha.ts");
  });

  it("emits fewer findings under a small budget and states the true omitted count", () => {
    const duplication = Array.from({ length: 20 }, (_, i) => ranked(`THK-DUP-${i}`, {}, 100 - i));
    const full = renderMarkdown({ ...base, duplication, totalFindings: 20 });
    const tight = renderMarkdown({ ...base, duplication, totalFindings: 20, budgetTokens: 200 });

    expect(full).toMatch(/findings {13}20 of 20 shown/);
    expect(full).not.toMatch(/further findings omitted/);

    const emitted = [...tight.matchAll(/^### THK-DUP-/gm)].length;
    expect(emitted).toBeGreaterThan(0);
    expect(emitted).toBeLessThan(20);
    expect(tight).toContain(`findings             ${emitted} of 20 shown`);
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
    expect(out).toContain("findings             0 of 1 shown");
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
