import { describe, expect, it } from "vitest";
import {
  selectGranularity,
  selectGranularityAcross,
  workspaceGroups,
  type Granularity,
} from "../src/graph/granularity.js";
import { ORDERING_PROBE } from "./helpers.js";

describe("selectGranularity", () => {
  it("targets sqrt(file count) modules", () => {
    // 100 files -> target 10 modules
    const paths = Array.from({ length: 100 }, (_, i) => `src/g${i % 10}/f${i}.ts`);
    const chosen = selectGranularity(paths);
    expect(chosen.moduleCount).toBe(10);
    expect(chosen.label).toBe("dir:1");
  });

  it("clamps the TARGET to at least 8, so it prefers a finer split in a small repo", () => {
    // 9 files: sqrt is 3, but the target floor of 8 pulls selection toward the
    // finer granularity. Two candidate depths exist here: depth 1 gives 3
    // modules, file gives 9. 9 is nearer 8 than 3 is, so file must win.
    const paths = Array.from({ length: 9 }, (_, i) => `src/g${i % 3}/f${i}.ts`);
    const chosen = selectGranularity(paths);
    expect(chosen.moduleCount).toBe(9);
    expect(chosen.label).toBe("file");
  });

  it("does not collapse a flat repo to a single module", () => {
    // Every file in one directory: all directory depths give 1 module.
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const chosen = selectGranularity(paths);
    expect(chosen.moduleCount).toBeGreaterThan(1);
  });

  it("never returns more modules than files", () => {
    const paths = ["src/a/x.ts", "src/b/y.ts", "src/c/z.ts"];
    expect(selectGranularity(paths).moduleCount).toBeLessThanOrEqual(paths.length);
  });

  it("assigns every path a module", () => {
    const paths = Array.from({ length: 40 }, (_, i) => `src/g${i % 6}/h${i % 3}/f${i}.ts`);
    const chosen = selectGranularity(paths);
    for (const p of paths) expect(chosen.moduleOf[p]).toBeDefined();
    expect(new Set(Object.values(chosen.moduleOf)).size).toBe(chosen.moduleCount);
  });

  it("is deterministic", () => {
    const paths = Array.from({ length: 40 }, (_, i) => `src/g${i % 6}/h${i % 3}/f${i}.ts`);
    expect(selectGranularity(paths).label).toBe(selectGranularity(paths).label);
  });

  it("handles an empty repo without throwing", () => {
    const chosen = selectGranularity([]);
    expect(chosen.moduleCount).toBe(0);
  });
});

/**
 * Files laid out as a monorepo: one dominant workspace and one small one.
 * Measured shape rather than invented -- in both sample monorepos a single
 * workspace held ~88% of the source (6048 of 6831; 3923 of 4464), so the
 * question per-workspace granularity answers is not how to split the big app
 * but how to avoid shredding the small packages.
 *
 * Both live under `pkg/`, which is what makes the common prefix load-bearing:
 * add a workspace anywhere else and `commonPrefix` shortens, renaming every
 * module that existed before it.
 */
const BIG = Array.from(
  { length: 400 },
  (_, i) => `pkg/big/src/g${i % 20}/h${i % 4}/f${i}.ts`,
);
const SMALL = Array.from({ length: 12 }, (_, i) => `pkg/small/src/sub${i}/f.ts`);
const EXTRA = Array.from({ length: 6 }, (_, i) => `tools/extra/src/f${i}.ts`);
/** 40 files over 8 directories of 5, each file in a directory of its own below that. */
const MID = Array.from(
  { length: 40 },
  (_, i) => `pkg/mid/src/g${i % 8}/h${i % 5}/f${i}.ts`,
);

/** Files per module, as the spread between the largest and the smallest. */
function moduleSizes(g: Granularity): { max: number; min: number } {
  const counts = new Map<string, number>();
  for (const name of Object.values(g.moduleOf)) counts.set(name, (counts.get(name) ?? 0) + 1);
  const sizes = [...counts.values()];
  return { max: Math.max(...sizes), min: Math.min(...sizes) };
}

describe("selectGranularityAcross", () => {
  it("picks a depth per workspace so module sizes are comparable", () => {
    const paths = [...BIG, ...SMALL];
    // One global depth: depth 3 is nearest the 20-module target, which cuts
    // the big workspace into 20 modules of 20 files and the small one into 12
    // modules of 1 -- a 20x spread, peers at different scales.
    const oneDepth = selectGranularity(paths);
    expect(oneDepth.label).toBe("dir:3");
    expect(moduleSizes(oneDepth)).toEqual({ max: 20, min: 1 });

    const g = selectGranularityAcross(
      [
        { dir: "pkg/big", paths: BIG },
        { dir: "pkg/small", paths: SMALL },
      ],
      paths.length,
    );
    const sizes = moduleSizes(g);
    expect(sizes.max / sizes.min).toBeLessThan(4);
    expect(sizes).toEqual({ max: 20, min: 12 });
    expect(g.moduleOf["pkg/small/src/sub0/f.ts"]).toBe("pkg/small");
  });

  it("does not rename a workspace's modules when a filter excludes the others", () => {
    const groups = [
      { dir: "pkg/big", paths: BIG },
      { dir: "pkg/small", paths: SMALL },
    ];
    const repoFileCount = BIG.length + SMALL.length;
    const wide = selectGranularityAcross(groups, repoFileCount);
    const narrow = selectGranularityAcross([{ dir: "pkg/small", paths: SMALL }], repoFileCount);
    for (const p of SMALL) expect(narrow.moduleOf[p]).toBe(wide.moduleOf[p]);
  });

  it("does not rename an existing workspace's modules when one is added", () => {
    const before = selectGranularityAcross(
      [
        { dir: "pkg/big", paths: BIG },
        { dir: "pkg/small", paths: SMALL },
      ],
      BIG.length + SMALL.length,
    );
    const after = selectGranularityAcross(
      [
        { dir: "pkg/big", paths: BIG },
        { dir: "pkg/small", paths: SMALL },
        { dir: "tools/extra", paths: EXTRA },
      ],
      BIG.length + SMALL.length + EXTRA.length,
    );
    for (const p of [...BIG, ...SMALL]) expect(after.moduleOf[p]).toBe(before.moduleOf[p]);

    // The same addition through one global depth renames every module that
    // existed: `tools/` shortens the common prefix from `pkg` to nothing.
    const oneDepthBefore = selectGranularity([...BIG, ...SMALL]);
    const oneDepthAfter = selectGranularity([...BIG, ...SMALL, ...EXTRA]);
    expect(oneDepthBefore.moduleOf[SMALL[0]!]).toBe("small/src/sub0");
    expect(oneDepthAfter.moduleOf[SMALL[0]!]).toBe("pkg/small/src/sub0");
  });

  it("resolves a one-file workspace to exactly one module", () => {
    const g = selectGranularityAcross(
      [
        { dir: "pkg/big", paths: BIG },
        { dir: "pkg/one", paths: ["pkg/one/src/deep/only.ts"] },
      ],
      BIG.length + 1,
    );
    expect(g.moduleOf["pkg/one/src/deep/only.ts"]).toBe("pkg/one");
  });

  /**
   * 40 files, so the fallback target is 40 / 8 = 5 files per module: the depth
   * giving 8 modules of 5 wins. A basis of 0 would target 0 and take the depth
   * below it, 40 modules of 1 -- which is what a `.d.ts`-only tree produces,
   * since it scans to zero sources while the program still holds files, so the
   * count arrives as 0 rather than absent.
   */
  it.each([undefined, 0])("falls back to the analyzed set given %s as a repository size", (basis) => {
    const g = selectGranularityAcross([{ dir: "pkg/mid", paths: MID }], basis);
    expect(g.moduleCount).toBe(8);
    expect(g.moduleOf["pkg/mid/src/g0/h0/f0.ts"]).toBe("pkg/mid/src/g0");
  });

  /**
   * Canonical rather than load-bearing: nothing downstream reads the key order
   * of `moduleOf` -- `buildModuleGraph` takes `Object.values`, uniques them and
   * sorts with `compareStrings` -- so this pins the record so that a future
   * reader who does iterate it gets a fixed answer rather than the order the
   * filesystem walk happened to produce.
   *
   * Both sorts are in the assertion: the groups are handed over reversed and
   * so are the paths inside them. Each group carries the whole of
   * ORDERING_PROBE, which is what makes the comparator falsifiable (see
   * tests/helpers.ts); prefixing every entry with one shared directory
   * preserves their relative order.
   */
  it("builds moduleOf in compareStrings order", () => {
    const paths = (ws: string) => ORDERING_PROBE.map((p) => `pkg/${ws}/${p}`);
    const g = selectGranularityAcross(
      [
        { dir: "pkg/w1", paths: [...paths("w1")].reverse() },
        { dir: "pkg/w0", paths: [...paths("w0")].reverse() },
      ],
      400,
    );
    expect(Object.keys(g.moduleOf)).toEqual([...paths("w0"), ...paths("w1")]);
  });

  it("has no modules when every group is empty", () => {
    expect(selectGranularityAcross([{ dir: "pkg/a", paths: [] }], 10).moduleCount).toBe(0);
  });
});

describe("workspaceGroups", () => {
  it("gives a nested workspace its own files, not its parent's", () => {
    const groups = workspaceGroups(
      ["deep/a/x.ts", "deep/a/b/gamma/y.ts"],
      ["deep/a", "deep/a/b/gamma"],
    );
    expect(groups).toEqual([
      { dir: "deep/a", paths: ["deep/a/x.ts"] },
      { dir: "deep/a/b/gamma", paths: ["deep/a/b/gamma/y.ts"] },
    ]);
  });

  /**
   * `pack` is a string prefix of `package` and an ancestor of nothing. The
   * workspace `package` is deliberately ABSENT: with both directories present,
   * longest-first ordering hands the file to `package` whether or not
   * containment is tested on whole segments, and the bug is invisible.
   */
  it("does not let a directory claim a sibling whose name it prefixes", () => {
    const groups = workspaceGroups(["package/src/a.ts"], ["pack"]);
    expect(groups).toEqual([{ dir: "", paths: ["package/src/a.ts"] }]);
  });

  it("collects files under no workspace into a root group", () => {
    const groups = workspaceGroups(["scripts/root.ts", "pkg/a/src/a.ts"], ["pkg/a"]);
    expect(groups).toEqual([
      { dir: "pkg/a", paths: ["pkg/a/src/a.ts"] },
      { dir: "", paths: ["scripts/root.ts"] },
    ]);
  });
});
