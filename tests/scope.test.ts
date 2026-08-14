import { describe, expect, it } from "vitest";
import { analysisScope, scanSourceFiles } from "../src/extract/scope.js";
import { generatedRoot, partialRoot } from "./helpers.js";

describe("the denominator excludes what analysis excludes", () => {
  // Both sides must apply the same rules. When the banner sniff started
  // dropping 3408 machine-emitted files from analysis but the scan still
  // counted them on disk, the report blamed the package they lived in for
  // being outside the program and printed the --config that was ALREADY
  // passed. A gap no flag can close is worse than no gap at all -- and this
  // one accused the user of a mistake they had not made.
  it("does not count banner-marked generated files on disk", () => {
    const found = scanSourceFiles(generatedRoot());
    expect(found).not.toContain("src/table.gen.ts");
    expect(found).not.toContain("src/widgets/badge.ts");
    expect(found).toContain("src/outbound.ts");
  });

  it("calls a run complete when the only unanalyzed files are generated", () => {
    const analyzed = [
      "src/distance/measure.ts",
      "src/handwritten.ts",
      "src/mentions.ts",
      "src/outbound.ts",
    ];
    const scope = analysisScope(generatedRoot(), analyzed);
    expect(scope.onDisk).toBe(4);
    expect(scope.complete).toBe(true);
    expect(scope.gaps).toEqual([]);
  });

  it("counts them when they are being analyzed", () => {
    // Under --include-generated the two sides have to agree the other way,
    // or coverage exceeds 100% and the gap goes negative.
    const found = scanSourceFiles(generatedRoot(), { includeGenerated: true });
    expect(found).toContain("src/table.gen.ts");
    expect(found).toContain("src/widgets/badge.ts");
  });

  it("honours --exclude on both sides too", () => {
    const found = scanSourceFiles(generatedRoot(), { exclude: ["**/distance/**"] });
    expect(found).not.toContain("src/distance/measure.ts");
  });
});

describe("scanSourceFiles", () => {
  it("finds hand-written TypeScript and nothing else", () => {
    const found = scanSourceFiles(partialRoot());
    expect(found).toEqual([
      "packages/lib/src/other.ts",
      "packages/lib/src/thing.ts",
      "src/main.ts",
    ]);
  });

  it("skips generated, declaration, and dot-directory files", () => {
    // Each of these is a way the denominator silently inflates, and an
    // inflated denominator invents a coverage gap that does not exist:
    //
    //  - `dist/built.ts` is build output, already excluded from analysis, so
    //    counting it would report a permanent gap no --config can close.
    //  - `types.d.ts` declares, it does not implement.
    //  - `.worktree/copy/` is a checkout of the tree inside a dot-directory.
    //    Real repositories keep agent worktrees there, and one such copy
    //    doubles every file in the repo.
    const found = scanSourceFiles(partialRoot());
    expect(found.some((p) => p.startsWith("dist/"))).toBe(false);
    expect(found.some((p) => p.endsWith(".d.ts"))).toBe(false);
    expect(found.some((p) => p.startsWith(".worktree/"))).toBe(false);
  });
});

describe("analysisScope", () => {
  it("reports the gap between what was analyzed and what is on disk", () => {
    // The fixture mirrors the shape that produced a 3%-coverage report on a
    // real monorepo: a root tsconfig that excludes `packages`, so the program
    // holds one file while the tree holds three.
    const scope = analysisScope(partialRoot(), ["src/main.ts"]);
    expect(scope.analyzed).toBe(1);
    expect(scope.onDisk).toBe(3);
    expect(scope.complete).toBe(false);
  });

  it("attributes unanalyzed files to the tsconfig that would bring them in", () => {
    const scope = analysisScope(partialRoot(), ["src/main.ts"]);
    expect(scope.gaps).toEqual([
      { dir: "packages/lib", fileCount: 2, config: "packages/lib/tsconfig.json" },
    ]);
  });

  it("is complete when the program covers the tree", () => {
    const scope = analysisScope(partialRoot(), [
      "src/main.ts",
      "packages/lib/src/thing.ts",
      "packages/lib/src/other.ts",
    ]);
    expect(scope.complete).toBe(true);
    expect(scope.gaps).toEqual([]);
  });

  it("does not fault a program that analyzes more than the scan counts", () => {
    // A program legitimately reaches files the scan skips -- a `.d.ts` it was
    // pointed at, a generated file under --include-generated. Coverage must
    // not exceed completeness and must never report a negative gap.
    const scope = analysisScope(partialRoot(), [
      "src/main.ts",
      "packages/lib/src/thing.ts",
      "packages/lib/src/other.ts",
      "packages/lib/src/types.d.ts",
      "dist/built.ts",
    ]);
    expect(scope.complete).toBe(true);
    expect(scope.gaps).toEqual([]);
  });
});
