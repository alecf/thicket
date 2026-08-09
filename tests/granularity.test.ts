import { describe, expect, it } from "vitest";
import { selectGranularity } from "../src/graph/granularity.js";

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
