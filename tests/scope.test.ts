import { describe, expect, it } from "vitest";
import { analysisScope, type Scope, scanSourceFiles } from "../src/extract/scope.js";
import { generatedRoot, partialRoot, withRoot, workspacesRoot } from "./helpers.js";

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

  // The sort is `compareStrings`, and only names that sort differently under
  // collation can say so. `Util.ts` before `alpha.ts` is the case AGENTS.md §1
  // names: en-US folds case, so collation answers the reverse, and a repo with
  // one capitalized filename emits differently-ordered reports on two hosts.
  // `-`, `.` and `_` do the same for punctuation.
  it("orders the files it finds by code unit, not by collation", () => {
    withRoot(
      {
        "src/Util.ts": "export const u = 1;\n",
        "src/alpha.ts": "export const a = 1;\n",
        "src/a-b.ts": "export const b = 1;\n",
        "src/a_c.ts": "export const c = 1;\n",
      },
      (root) => {
        expect(scanSourceFiles(root)).toEqual([
          "src/Util.ts",
          "src/a-b.ts",
          "src/a_c.ts",
          "src/alpha.ts",
        ]);
      },
    );
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
      { dir: "packages/lib", fileCount: 2, configs: ["packages/lib/tsconfig.json"] },
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

/**
 * What a gap offers the reader, and what it must refuse to offer.
 *
 * `analysisScope` is synchronous and loads no program, so it cannot know which
 * config would close a gap -- only which ones were already tried. Naming one
 * anyway is a guess presented as an instruction, which is the defect this
 * section exists to avoid; it lists the untried candidates and ranks nothing.
 */
describe("the configs a gap offers", () => {
  const gapFor = (scope: Scope, dir: string) => scope.gaps.find((g) => g.dir === dir);

  it("offers every config in the directory when none was tried", () => {
    const scope = analysisScope(workspacesRoot(), []);
    expect(gapFor(scope, "tools/alpha")?.configs).toEqual([
      "tools/alpha/tsconfig.build.json",
      "tools/alpha/tsconfig.json",
      "tools/alpha/tsconfig.test.json",
    ]);
  });

  // The observed failure, on a sample monorepo at 98.4% coverage: 8 of its 9
  // gaps advised a `--config` that was already on the command line -- and it
  // was that config's own `exclude` leaving those files out. Following the
  // advice changes nothing.
  it("never advises a config that was already passed", () => {
    const scope = analysisScope(workspacesRoot(), ["tools/alpha/src/a.ts"], {
      triedConfigs: ["tools/alpha/tsconfig.json"],
    });
    expect(gapFor(scope, "tools/alpha")?.configs).not.toContain("tools/alpha/tsconfig.json");
  });

  it("offers the siblings that have not been tried, sorted", () => {
    const scope = analysisScope(workspacesRoot(), ["tools/alpha/src/a.ts"], {
      triedConfigs: ["tools/alpha/tsconfig.json"],
    });
    expect(gapFor(scope, "tools/alpha")?.configs).toEqual([
      "tools/alpha/tsconfig.build.json",
      "tools/alpha/tsconfig.test.json",
    ]);
  });

  // The common case once workspace discovery lands: discovery already loaded
  // every config the directory has, so there is nothing left to suggest. Say
  // nothing rather than repeat an instruction the reader already followed.
  it("offers nothing when every config in the directory was already tried", () => {
    const scope = analysisScope(workspacesRoot(), [], {
      triedConfigs: ["libs/beta/tsconfig.json"],
    });
    expect(gapFor(scope, "libs/beta")?.configs).toEqual([]);
  });

  // The second provenance in the same list: `configsFor` opens every candidate
  // sibling and declines the ones covering none of that workspace's missing
  // files. The caller subtracts those too, and this function cannot and need
  // not tell them apart from the configs the program was built from.
  it("offers nothing the caller says it already opened and declined", () => {
    const scope = analysisScope(workspacesRoot(), ["tools/alpha/src/a.ts"], {
      triedConfigs: ["tools/alpha/tsconfig.json", "tools/alpha/tsconfig.build.json"],
    });
    expect(gapFor(scope, "tools/alpha")?.configs).toEqual(["tools/alpha/tsconfig.test.json"]);
  });

  // Gaps are ordered by size and then by directory, and the tie-break is the
  // half a host can change: two one-file gaps whose names differ only in case
  // sort one way by code unit and the other under collation, so the report
  // would list them differently on two machines from the same tree.
  it("breaks a tie between equal-sized gaps by code unit, not by collation", () => {
    withRoot(
      { "Zed/x.ts": "export const x = 1;\n", "apps/y.ts": "export const y = 1;\n" },
      (root) => {
        expect(analysisScope(root, []).gaps.map((g) => g.dir)).toEqual(["Zed", "apps"]);
      },
    );
  });

  it("offers nothing for a directory that holds no config at all", () => {
    const scope = analysisScope(workspacesRoot(), []);
    expect(gapFor(scope, "scripts")?.configs).toEqual([]);
  });

  // `tsconfig.json` is a convention, not a requirement, and a directory whose
  // configs are `tsconfig.app.json` and `tsconfig.node.json` is an ordinary
  // Vite layout. Blame it for its own files -- and offer them -- rather than
  // charging them to the top-level directory with no advice attached.
  //
  // The other three names are here for the ORDER, which is not cosmetic: with
  // no `tsconfig.json` present, `configsIn` in `workspaces.ts` takes the first
  // of this list as the config it LOADS. Under `localeCompare` the answer
  // depends on the host's ICU data and `LANG` (AGENTS.md §1), and these names
  // are what makes the two orders disagree -- `-` (0x2D), `.` (0x2E) and `_`
  // (0x5F) sort in that order by code unit and in a different one under
  // collation, which also folds `B` in beside `a`. Measured under en-US,
  // collation answers `_legacy, -base, .app, .Build, .node`. Without a datum
  // like `tsconfig-base.json` -- an ordinary convention -- every name in the
  // directory sorts identically both ways and the guard is unfalsifiable.
  it("blames the directory whose only config is not named tsconfig.json", () => {
    withRoot(
      {
        "apps/web/tsconfig.app.json": "{}",
        "apps/web/tsconfig.node.json": "{}",
        "apps/web/tsconfig-base.json": "{}",
        "apps/web/tsconfig.Build.json": "{}",
        "apps/web/tsconfig_legacy.json": "{}",
        "apps/web/src/a.ts": "export const a = 1;\n",
      },
      (root) => {
        expect(analysisScope(root, []).gaps).toEqual([
          {
            dir: "apps/web",
            fileCount: 1,
            configs: [
              "apps/web/tsconfig-base.json",
              "apps/web/tsconfig.Build.json",
              "apps/web/tsconfig.app.json",
              "apps/web/tsconfig.node.json",
              "apps/web/tsconfig_legacy.json",
            ],
          },
        ]);
      },
    );
  });
});
