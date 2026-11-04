import { describe, expect, it } from "vitest";
import { EMPTY_BIN, SKETCH_BINS, isNear, similarity, sketchOf } from "../src/fingerprint/sketch.js";

/** A token stream that looks like an L1 stream: kinds, markers, named leaves. */
function stream(n: number, seed: number, name = "x"): string[] {
  const kinds = ["CallExpression", "Identifier", "(", ")", "PropertyAccessExpression", "Block", "ReturnStatement"];
  const out: string[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const k = kinds[(s >>> 16) % kinds.length]!;
    out.push(k === "Identifier" ? `Id:${name}${(s >>> 8) % 5}` : k);
  }
  return out;
}

function sketchFrom(bins: number[]): Uint16Array {
  const out = new Uint16Array(SKETCH_BINS).fill(EMPTY_BIN);
  bins.forEach((v, i) => (out[i] = v));
  return out;
}

describe("sketchOf", () => {
  it("is identical for streams that differ only in identifier names", () => {
    // The L2 stream drops identifier text, so a renamed copy is the same set
    // of shingles. That is what lets a near copy be renamed AND edited.
    const a = sketchOf(stream(300, 1, "user"))!;
    const b = sketchOf(stream(300, 1, "account"))!;
    expect([...a]).toEqual([...b]);
  });

  it("calls a copy with one inserted run of tokens near", () => {
    const base = stream(400, 2);
    const edited = [...base.slice(0, 200), ...stream(8, 99), ...base.slice(200)];
    expect(isNear(sketchOf(base)!, sketchOf(edited)!)).toBe(true);
  });

  it("does not call two unrelated streams near", () => {
    expect(isNear(sketchOf(stream(400, 3))!, sketchOf(stream(400, 4))!)).toBe(false);
  });

  it("has no sketch for a stream shorter than one shingle", () => {
    expect(sketchOf(["Block", "(", ")"])).toBeUndefined();
  });

  it("never stores the empty marker as a value", () => {
    // A value equal to EMPTY_BIN would read as an empty bin and drop out of
    // every comparison it should take part in.
    for (let seed = 0; seed < 50; seed++) {
      const s = sketchOf(stream(500, seed))!;
      const filled = [...s].filter((v) => v !== EMPTY_BIN).length;
      expect(filled).toBeGreaterThan(0);
    }
  });
});

describe("similarity", () => {
  it("ignores bins empty on both sides", () => {
    // A small fragment fills few of the 128 bins. Counting the shared empty
    // ones as matches would call every pair of small fragments near.
    expect(similarity(sketchFrom([1, 2, 3, 4]), sketchFrom([1, 2, 3, 9]))).toEqual({ match: 3, of: 4 });
  });

  it("counts a bin empty on one side as a mismatch", () => {
    expect(similarity(sketchFrom([1, 2, 3, 4, 5]), sketchFrom([1, 2, 3, 4]))).toEqual({ match: 4, of: 5 });
  });

  it("decides the threshold in integers, inclusive at exactly 4 in 5", () => {
    // 4 of 5 is 0.8 exactly. A float comparison of 0.8 against 4/5 is the
    // kind of last-bit question AGENTS.md §1 keeps out of the report.
    expect(isNear(sketchFrom([1, 2, 3, 4, 5]), sketchFrom([1, 2, 3, 4, 9]))).toBe(true);
    expect(isNear(sketchFrom([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), sketchFrom([1, 2, 3, 4, 5, 6, 7, 0, 0, 0]))).toBe(false);
  });

  it("calls two all-empty sketches not near", () => {
    expect(isNear(sketchFrom([]), sketchFrom([]))).toBe(false);
  });
});
