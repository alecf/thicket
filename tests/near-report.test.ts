import { describe, expect, it } from "vitest";
import type { NearOccurrence } from "../src/fingerprint/cluster.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { rankClusters, type Ranked } from "../src/report/rank.js";
import { reportInput } from "./report-fixtures.js";

const copy = (filePath: string, line: number) => ({
  filePath,
  start: line * 100,
  end: line * 100 + 90,
  line,
  endLine: line + 8,
  parentId: line,
});
const nearCopy = (filePath: string, line: number, similarity: number): NearOccurrence => ({
  ...copy(filePath, line),
  similarity,
});

const cluster = (near?: NearOccurrence[]) => ({
  id: "THK-DUP-1",
  level: "L1" as const,
  kind: "Block",
  nodeCount: 40,
  mass: 40,
  occurrences: [copy("src/a.ts", 4), copy("src/b.ts", 2)],
  ...(near === undefined ? {} : { near }),
});

const ranked = (near?: NearOccurrence[]): Ranked => rankClusters([cluster(near)])[0]!;

describe("near copies in the report", () => {
  it("counts near copies in the heading, apart from the exact copies", () => {
    const out = renderMarkdown(
      reportInput({ duplication: [ranked([nearCopy("src/c.ts", 7, 0.875), nearCopy("src/d.ts", 3, 0.82)])], totalFindings: 1 }),
    );
    expect(out).toContain("### THK-DUP-1 · 2 copies + 2 near × ~9 lines");
  });

  it("lists each near copy with how alike it is", () => {
    const out = renderMarkdown(
      reportInput({ duplication: [ranked([nearCopy("src/c.ts", 7, 0.875), nearCopy("src/d.ts", 3, 0.82)])], totalFindings: 1 }),
    );
    expect(out).toContain("- `src/c.ts:7` · 87% the same shape");
    expect(out).toContain("- `src/d.ts:3` · 82% the same shape");
    // Under their own label, after the exact copies: the level describes
    // only those.
    expect(out.indexOf("`src/b.ts:2`")).toBeLessThan(out.indexOf("**near copies"));
    expect(out.indexOf("**near copies")).toBeLessThan(out.indexOf("`src/c.ts:7`"));
  });

  it("never prints a near copy as 100% the same", () => {
    // The sketch drops identifier text, so `x = x + y` and `x = y + x` match
    // in every bin. "100%" under near copies reads as a missed exact copy.
    const out = renderMarkdown(
      reportInput({ duplication: [ranked([nearCopy("src/c.ts", 7, 1), nearCopy("src/d.ts", 3, 0.996)])], totalFindings: 1 }),
    );
    expect(out).not.toContain("100%");
    expect(out).toContain("- `src/c.ts:7` · the same shape, with names bound differently");
    expect(out).toContain("- `src/d.ts:3` · 99% the same shape");
  });

  it("prints nothing about near copies when there are none", () => {
    const out = renderMarkdown(reportInput({ duplication: [ranked()], totalFindings: 1 }));
    expect(out).toContain("### THK-DUP-1 · 2 copies × ~9 lines");
    expect(out).not.toContain("near copies");
  });

  it("scores a finding on its exact copies alone", () => {
    // Counting near copies in the score moved 5 of the top 40 on each of two
    // repositories, and judges preferred the new entrant only 5 times in 10.
    const withNear = rankClusters([cluster([nearCopy("src/c.ts", 7, 0.9)])])[0]!;
    const without = rankClusters([cluster()])[0]!;
    expect(withNear.score).toBe(without.score);
    expect(withNear.recoverableLines).toBe(without.recoverableLines);
  });
});
