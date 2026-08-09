import { describe, expect, it } from "vitest";
import { byScoreThenId, compareStrings } from "../src/order.js";

describe("compareStrings", () => {
  it("is a total order", () => {
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("b", "a")).toBe(1);
    expect(compareStrings("a", "a")).toBe(0);
  });

  it("orders by code unit, not by locale collation", () => {
    // The regression this module exists for. Locale collation folds case, so
    // en-US puts "alpha.ts" first; code-unit order puts "Util.ts" first
    // (U = 0x55 < a = 0x61). Any repo with a capitalized filename hits this.
    const a = "src/Util.ts";
    const b = "src/alpha.ts";
    expect(compareStrings(a, b)).toBe(-1);
    expect(Math.sign(a.localeCompare(b))).toBe(1);
  });

  it("sorts a realistic path list identically regardless of host locale", () => {
    const paths = ["src/util.ts", "src/App.tsx", "src/a-b.ts", "src/ab.ts", "src/Button.tsx"];
    expect([...paths].sort(compareStrings)).toEqual([
      "src/App.tsx",
      "src/Button.tsx",
      "src/a-b.ts",
      "src/ab.ts",
      "src/util.ts",
    ]);
  });
});

describe("byScoreThenId", () => {
  it("orders by score descending", () => {
    const items = [
      { id: "a", score: 1 },
      { id: "b", score: 5 },
    ];
    expect([...items].sort(byScoreThenId).map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("breaks score ties by id ascending", () => {
    const items = [
      { id: "c", score: 3 },
      { id: "a", score: 3 },
      { id: "b", score: 3 },
    ];
    expect([...items].sort(byScoreThenId).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
