import { describe, expect, it } from "vitest";
import { census } from "../src/report/census.js";
import type { Ranked } from "../src/report/rank.js";

const at = (recoverableLines: number, files: string[] = ["src/a.ts", "src/b.ts"]): Ranked => ({
  score: recoverableLines,
  tag: "source",
  linesPerCopy: 9,
  recoverableLines,
  cluster: {
    id: `c${recoverableLines}-${files.join()}`,
    level: "L0",
    kind: "Block",
    nodeCount: 20,
    mass: 40,
    occurrences: files.map((filePath, i) => ({
      filePath,
      start: i * 100,
      end: i * 100 + 90,
      line: i + 1,
      endLine: i + 9,
      parentId: i,
    })),
  },
});

describe("census", () => {
  it("bands candidates by what an extraction would remove", () => {
    const c = census([at(400), at(100), at(99), at(30), at(29), at(10), at(9), at(4), at(3), at(1)], 0);
    expect(c.bands).toEqual([
      { label: "100+", count: 2 },
      { label: "30–99", count: 2 },
      { label: "10–29", count: 2 },
      { label: "4–9", count: 2 },
      { label: "1–3", count: 2 },
    ]);
  });

  it("accounts for every candidate exactly once", () => {
    // The census is the report's answer to "what is in the other 18,000", so a
    // candidate falling through the bands would be a quiet lie about the size
    // of the tail.
    const ranked = Array.from({ length: 200 }, (_, i) => at(i));
    const c = census(ranked, 3);
    expect(c.bands.reduce((sum, b) => sum + b.count, 0)).toBe(200);
    expect(c.duplication).toBe(200);
    expect(c.cycles).toBe(3);
  });

  it("drops empty bands rather than printing zeroes", () => {
    expect(census([at(5)], 0).bands).toEqual([{ label: "4–9", count: 1 }]);
  });

  it("counts a zero-value candidate rather than losing it", () => {
    expect(census([at(0)], 0).bands).toEqual([{ label: "0", count: 1 }]);
  });

  it("splits test-majority candidates out of the duplication count", () => {
    // A half-test cluster counts as test: the split exists so scaffolding
    // cannot displace production work, and a tie is as much one as the other.
    const c = census(
      [
        at(20, ["src/a.test.ts", "src/b.test.ts"]), // all test
        at(20, ["src/a.test.ts", "src/b.ts"]), // half test
        at(20, ["src/a.ts", "src/b.ts"]), // all source
      ],
      0,
    );
    expect(c.testDuplication).toBe(2);
    expect(c.duplication).toBe(1);
  });

  it("bands production candidates only", () => {
    // The histogram sits under the production section. Folding test
    // scaffolding back in would restate the pile the split separated.
    const c = census([at(50, ["a.test.ts", "b.test.ts"]), at(50, ["a.ts", "b.ts"])], 0);
    expect(c.bands).toEqual([{ label: "30–99", count: 1 }]);
  });

  it("counts clusters confined to one file", () => {
    const c = census([at(20, ["src/a.ts", "src/a.ts"]), at(20, ["src/a.ts", "src/b.ts"])], 0);
    expect(c.singleFile).toBe(1);
  });
});
