import { describe, expect, it } from "vitest";
import { commonPrefix, groupByDepth } from "../src/graph/grouping.js";

describe("commonPrefix", () => {
  it("finds the shared leading directories", () => {
    expect(commonPrefix(["packages/a/src/x.ts", "packages/b/src/y.ts"])).toEqual(["packages"]);
  });

  it("is empty when paths diverge immediately", () => {
    expect(commonPrefix(["src/a.ts", "test/b.ts"])).toEqual([]);
  });

  it("handles a single file", () => {
    expect(commonPrefix(["src/deep/a.ts"])).toEqual(["src", "deep"]);
  });

  it("compares whole segments, not string prefixes", () => {
    // "pack" must not be treated as a prefix of "package".
    expect(commonPrefix(["repo/pack/x.ts", "repo/package/y.ts"])).toEqual(["repo"]);
  });

  it("is empty for no paths", () => {
    expect(commonPrefix([])).toEqual([]);
  });
});

describe("groupByDepth", () => {
  it("strips the common prefix before measuring depth", () => {
    const paths = ["packages/a/src/x.ts", "packages/b/src/y.ts"];
    // Without stripping, depth 1 would be "packages" for both -> 1 module.
    expect(new Set(Object.values(groupByDepth(paths, 1))).size).toBe(2);
  });

  it("returns <root> for files at the stripped root", () => {
    expect(groupByDepth(["src/a.ts", "src/b.ts"], 1)["src/a.ts"]).toBe("<root>");
  });

  it("assigns every input path a module", () => {
    const paths = ["a/x.ts", "b/y.ts", "b/c/z.ts"];
    const g = groupByDepth(paths, 2);
    for (const p of paths) expect(typeof g[p]).toBe("string");
  });
});
