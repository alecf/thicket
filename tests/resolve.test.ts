import { describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { fixtureConfig, monorepoConfigs } from "./helpers.js";

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
