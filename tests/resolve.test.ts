import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { fixtureConfig, fixtureRoot, importsFixtureConfig, monorepoConfigs, typeOnlyConfig } from "./helpers.js";

describe("import resolution", () => {
  it("resolves relative specifiers to repo-relative paths", async () => {
    const project = await openProject(fixtureConfig());
    const alpha = project.files().find((f) => f.path === "src/alpha.ts")!;
    expect(project.importsOf(alpha).sort()).toEqual(["src/gamma.ts", "src/util/shared.ts"]);
  });

  it("resolves the deliberate alpha<->gamma cycle in both directions", async () => {
    const project = await openProject(fixtureConfig());
    const gamma = project.files().find((f) => f.path === "src/gamma.ts")!;
    expect(project.importsOf(gamma)).toContain("src/alpha.ts");
  });

  it("does not resolve external packages to local files", async () => {
    const project = await openProject(fixtureConfig());
    let resolved = 0;
    for (const f of project.files()) {
      for (const target of project.importsOf(f)) {
        resolved++;
        expect(target.startsWith("src/")).toBe(true);
      }
    }
    // Without this, the case-canonicalization hazard — which resolves nothing
    // at all — would satisfy the loop above vacuously.
    expect(resolved).toBeGreaterThan(0);
  });

  it("resolves imports in every project, not just the first", async () => {
    // The owning project's checker is required: a foreign checker throws on
    // the unresolvable node handle, which would read as "no imports here".
    const project = await openProject(monorepoConfigs());
    for (const rel of ["a/src/index.ts", "b/src/index.ts"]) {
      const f = project.files().find((x) => x.path === rel)!;
      expect(project.importsOf(f)).toEqual(["shared/src/util.ts"]);
    }
  });

  it("resolves imports under a path containing uppercase characters", async () => {
    // The case-canonicalization guard is INERT when the whole absolute path is
    // already lowercase: the checker lowercases its Path, getSourceFileNames()
    // does not, and if the two strings are equal anyway the missing
    // .toLowerCase() changes nothing.
    //
    // Every other test here therefore protects the guard only by accident of
    // where the repository happens to live. Measured with the guard removed:
    // an all-lowercase checkout resolved all 5 edges and noticed nothing, while
    // a mixed-case one resolved 0. CI runs from `/home/runner/work/...`, which
    // is entirely lowercase, so without this test the guard could be deleted
    // and the whole suite would still pass.
    //
    // Copying into a deliberately mixed-case directory makes the casing a
    // property of the fixture rather than of the host.
    const project = await openProject(join(mixedCaseRoot, "tsconfig.json"));
    const alpha = project.files().find((f) => f.path === "src/alpha.ts")!;
    expect(project.importsOf(alpha)).toEqual(["src/gamma.ts", "src/util/shared.ts"]);
  });

  it("throws rather than reporting zero imports for a file no project owns", async () => {
    // Loudness IS the guard. Returning undefined here would make an unowned
    // file look like a file with no imports -- indistinguishable from a clean
    // result, which is the failure mode this adapter exists to prevent.
    const project = await openProject(fixtureConfig());
    const real = project.files().find((f) => f.path === "src/alpha.ts")!;
    const ghost = { ...real, absPath: "/nowhere/ghost.ts" };
    const specifier = real.sourceFile.imports[0]!;
    expect(() => project.resolveImport(ghost, specifier)).toThrow(
      /belongs to no opened project/,
    );
  });
});

/**
 * The sample fixture copied under a directory whose name contains uppercase
 * letters, so path-casing behaviour is exercised independently of where the
 * repository is checked out.
 */
const mixedCaseRoot = (() => {
  const dir = mkdtempSync(join(tmpdir(), "thicket-Case-"));
  const dest = join(dir, "Sample-Project");
  cpSync(fixtureRoot(), dest, {
    recursive: true,
    filter: (src) => !src.includes(".thicket"),
  });
  return resolve(dest);
})();

afterAll(() => {
  rmSync(resolve(mixedCaseRoot, ".."), { recursive: true, force: true });
});

describe("importDetailsOf", () => {
  it("counts the distinct bindings of each import", async () => {
    const project = await openProject(fixtureConfig());
    const alpha = project.files().find((f) => f.path === "src/alpha.ts")!;
    // `import { type Point, ORIGIN } from "./util/shared.js"` -> 2
    // `import { scale } from "./gamma.js"`                    -> 1
    expect(project.importDetailsOf(alpha)).toEqual([
      { target: "src/gamma.ts", symbols: 1, erased: 0, erasable: false, passThrough: 0 },
      // `{ type Point, ORIGIN }` mixes an erased binding with a real one, so
      // the dependency survives compilation.
      { target: "src/util/shared.ts", symbols: 2, erased: 1, erasable: false, passThrough: 0 },
    ]);
  });

  it("counts every import form, and sums repeats of the same target", async () => {
    const project = await openProject(importsFixtureConfig());
    const main = project.files().find((f) => f.path === "src/main.ts")!;
    // dep.js: default d + K + L + type T = 4, namespace ns = 1,
    //         type-only { T as T2 } = 1, re-export { K as K2 } = 1,
    //         dynamic import() = 0.  Total 7.
    // side.js: side-effect import binds no names = 0, `export *` = 1,
    //          `export * as sideNs` = 1.  Total 2 — the side-effect import
    //          alone would still be an edge, at weight 0.
    expect(project.importDetailsOf(main)).toEqual([
      { target: "src/dep.ts", symbols: 7, erased: 2, erasable: false, passThrough: 0 },
      { target: "src/side.ts", symbols: 2, erased: 0, erasable: false, passThrough: 0 },
    ]);
  });

  it("counts the erased bindings of a partly type-only edge", async () => {
    // An all-or-nothing flag hides the cheapest fixes in a tangle. A real
    // 7-module SCC carried an edge printed as a bare `5` whose whole runtime
    // dependency was a single import in one file -- the other four bindings
    // were `import type`. The count points straight at that file; the boolean
    // says only "not type-only" and leaves the reader to grep.
    const project = await openProject(typeOnlyConfig());
    const render = project.files().find((f) => f.path === "packages/view/render.ts")!;
    const types = project
      .importDetailsOf(render)
      .find((d) => d.target === "packages/model/types.ts")!;
    expect(types).toEqual({
      target: "packages/model/types.ts",
      symbols: 3,
      erased: 2,
      erasable: false,
      passThrough: 0,
    });
  });

  it("marks an import erasable only when every binding from it is erased", async () => {
    // A type-only dependency has no runtime existence: no module-init order to
    // get wrong, and breaking it usually means moving a types file rather than
    // inverting a dependency. Reporting it identically to a real dependency
    // sends a reader after the wrong problem.
    const project = await openProject(typeOnlyConfig());
    const detail = (path: string) =>
      project.importDetailsOf(project.files().find((f) => f.path === path)!);

    // `import type { Shape }` and nothing else.
    expect(detail("packages/pure/describe.ts")).toEqual([
      { target: "packages/model/types.ts", symbols: 1, erased: 1, erasable: true, passThrough: 0 },
    ]);

    // The same file imported three times, erased / real / erased. Deciding
    // per declaration, or letting the last one win, calls this erasable on the
    // strength of the trailing `import type` line -- so the ordering here is
    // load-bearing, not incidental.
    expect(detail("packages/view/render.ts")).toEqual([
      { target: "packages/model/consts.ts", symbols: 1, erased: 0, erasable: false, passThrough: 0 },
      { target: "packages/model/types.ts", symbols: 3, erased: 2, erasable: false, passThrough: 0 },
    ]);

    // A plain value import is never erasable.
    expect(detail("packages/model/uses.ts")).toEqual([
      { target: "packages/pure/describe.ts", symbols: 1, erased: 0, erasable: false, passThrough: 0 },
    ]);
  });

  it("does not call a side-effect import erasable for having nothing to erase", async () => {
    // `import "./x.js"` binds no names, so a rule of "every binding is erased"
    // is vacuously true for it -- and it is the one import form that exists
    // purely for its runtime effect.
    const project = await openProject(importsFixtureConfig());
    const main = project.files().find((f) => f.path === "src/main.ts")!;
    const side = project.importDetailsOf(main).find((d) => d.target === "src/side.ts")!;
    expect(side.erased).toBe(0);
    expect(side.erasable).toBe(false);
  });

  it("agrees with importsOf on which targets exist", async () => {
    const project = await openProject(fixtureConfig());
    for (const f of project.files()) {
      expect(project.importDetailsOf(f).map((d) => d.target)).toEqual(project.importsOf(f));
    }
  });
});
