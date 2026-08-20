import { describe, expect, it } from "vitest";
import { commonPrefix, groupByDepth, groupByDirectory } from "../src/graph/grouping.js";

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

describe("groupByDirectory", () => {
  // A fixed depth treats every directory at that depth as a module and erases
  // everything below it. On a real application that made a 1586-file directory
  // and a 4-file directory peers, while a 328-file directory one level deeper
  // did not exist as a module at all. Depth is not a property of a codebase --
  // a tangle seven levels down is the same tangle as one two levels down --
  // so the module is the directory a file actually lives in, whatever depth
  // that happens to be.
  it("uses the directory a file lives in, at whatever depth", () => {
    const paths = [
      "src/lib/services/matters.ts",
      "src/lib/services/experts.ts",
      "src/lib/db/schema/users.schema.ts",
      "src/stores/session.ts",
    ];
    expect(groupByDirectory(paths)).toEqual({
      "src/lib/services/matters.ts": "lib/services",
      "src/lib/services/experts.ts": "lib/services",
      "src/lib/db/schema/users.schema.ts": "lib/db/schema",
      "src/stores/session.ts": "stores",
    });
  });

  it("never collapses a deep directory into a shallow one", () => {
    // The failure this replaces: at depth 2 both of these were `a/b`.
    const groups = groupByDirectory(["a/b/c/d/deep.ts", "a/b/shallow.ts"]);
    expect(groups["a/b/c/d/deep.ts"]).not.toBe(groups["a/b/shallow.ts"]);
  });

  it("strips the common prefix, like the depth grouping does", () => {
    // Otherwise every module name in a monorepo starts `packages/`.
    expect(groupByDirectory(["packages/a/src/x.ts", "packages/b/src/y.ts"])).toEqual({
      "packages/a/src/x.ts": "a/src",
      "packages/b/src/y.ts": "b/src",
    });
  });

  it("names a file at the root something rather than nothing", () => {
    expect(groupByDirectory(["index.ts", "other.ts"])).toEqual({
      "index.ts": "<root>",
      "other.ts": "<root>",
    });
  });
});
