import { describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { fixtureConfig, importsFixtureConfig, monorepoConfigs } from "./helpers.js";

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
});

describe("importDetailsOf", () => {
  it("counts the distinct bindings of each import", async () => {
    const project = await openProject(fixtureConfig());
    const alpha = project.files().find((f) => f.path === "src/alpha.ts")!;
    // `import { type Point, ORIGIN } from "./util/shared.js"` -> 2
    // `import { scale } from "./gamma.js"`                    -> 1
    expect(project.importDetailsOf(alpha)).toEqual([
      { target: "src/gamma.ts", symbols: 1 },
      { target: "src/util/shared.ts", symbols: 2 },
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
      { target: "src/dep.ts", symbols: 7 },
      { target: "src/side.ts", symbols: 2 },
    ]);
  });

  it("agrees with importsOf on which targets exist", async () => {
    const project = await openProject(fixtureConfig());
    for (const f of project.files()) {
      expect(project.importDetailsOf(f).map((d) => d.target)).toEqual(project.importsOf(f));
    }
  });
});
