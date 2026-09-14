import { describe, expect, it } from "vitest";
import { byScoreThenId, compareStrings } from "../src/order.js";
import { ORDERING_PROBE } from "./helpers.js";

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
    // `ORDERING_PROBE` is already in the order `compareStrings` must produce,
    // and it is deliberately NOT in that order under collation.
    const shuffled = [...ORDERING_PROBE].reverse();
    expect(shuffled.sort(compareStrings)).toEqual([...ORDERING_PROBE]);
  });
});

/**
 * The probe is the foundation every other ordering guard now stands on, so it
 * gets guards of its own: edit it in a way that costs it either property and
 * the dependent tests would keep passing while proving nothing.
 */
describe("ORDERING_PROBE", () => {
  it("orders differently under collation than under code units", () => {
    const collated = [...ORDERING_PROBE].sort((a, b) => a.localeCompare(b));
    expect(collated).not.toEqual([...ORDERING_PROBE]);
  });

  it("holds a nested path that no directory-at-a-time walk emits in order", () => {
    // The other half, and the one Task 4 had to invent separately: the files
    // of `a/` must not be contiguous in the sorted answer, or a walk that
    // finishes each directory before starting the next produces the sorted
    // list by luck and an unsorted implementation passes.
    const nested = ORDERING_PROBE.findIndex((p) => p.startsWith("a/"));
    expect(nested).toBeGreaterThan(-1);
    expect(ORDERING_PROBE.slice(0, nested).some((p) => !p.startsWith("a/"))).toBe(true);
    expect(ORDERING_PROBE.slice(nested + 1).some((p) => !p.startsWith("a/"))).toBe(true);
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
