import { describe, expect, it } from "vitest";
import { commonRootDir, openProject } from "../src/extract/ts-adapter.js";
import {
  fixtureConfig,
  monorepoConfigs,
  monorepoRoot,
  solutionConfig,
  solutionLeafConfigs,
} from "./helpers.js";

describe("openProject", () => {
  it("returns local source files with repo-relative posix paths", async () => {
    const project = await openProject(fixtureConfig());
    const paths = project.files().map((f) => f.path).sort();
    expect(paths).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
      "src/gamma.ts",
      "src/util/shared.ts",
    ]);
  });

  it("excludes node_modules and .d.ts files", async () => {
    const project = await openProject(fixtureConfig());
    expect(project.files().some((f) => f.path.includes("node_modules"))).toBe(false);
    expect(project.files().some((f) => f.path.endsWith(".d.ts"))).toBe(false);
  });

  it("yields each file exactly once even when opened via multiple projects", async () => {
    // Same config twice simulates a monorepo where one file is in N projects.
    const project = await openProject([fixtureConfig(), fixtureConfig()]);
    const paths = project.files().map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(4);
  });

  it("assigns a content hash to each file", async () => {
    const project = await openProject(fixtureConfig());
    for (const f of project.files()) expect(f.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns files in a stable sorted order", async () => {
    const a = await openProject(fixtureConfig());
    const b = await openProject(fixtureConfig());
    expect(a.files().map((f) => f.path)).toEqual(b.files().map((f) => f.path));
  });
});

describe("openProject across genuinely distinct projects", () => {
  // Passing one config twice is deduped by the API into a single project, so
  // it never reaches the dedup branch. These cases use two real configs that
  // both include `packages/shared`, which is the hazard as it actually occurs.
  it("yields a file shared by two projects exactly once", async () => {
    const project = await openProject(monorepoConfigs());
    const paths = project.files().map((f) => f.path);
    expect(paths).toEqual(["a/src/index.ts", "b/src/index.ts", "shared/src/util.ts"]);
  });

  it("roots at the common ancestor of all configs, not the first config's dir", async () => {
    const project = await openProject(monorepoConfigs());
    expect(project.root).toBe(`${monorepoRoot()}/packages`);
    // No path escapes the root: the first-config-wins bug shows up as `../`.
    for (const f of project.files()) expect(f.path.startsWith("..")).toBe(false);
  });
});

describe("openProject on a solution-style config", () => {
  // `{"files": [], "references": [...]}` is the stock template. It owns no
  // source files by design, so "0 files" is not an empty repo -- it is an
  // unexpanded reference list, and reporting it as clean is the silent-wrong
  // answer this tool exists to avoid.
  it("expands references and yields the union of the referenced projects", async () => {
    const project = await openProject(solutionConfig());
    expect(project.files().map((f) => f.path)).toEqual([
      "src/app.ts",
      "src/helper.ts",
      "tools/build.ts",
    ]);
  });

  it("matches the file set of opening every leaf config directly", async () => {
    const viaRoot = await openProject(solutionConfig());
    const viaLeaves = await openProject(solutionLeafConfigs());
    expect(viaRoot.files().map((f) => f.path)).toEqual(viaLeaves.files().map((f) => f.path));
  });

  it("terminates when references form a cycle", async () => {
    // tsconfig.tools.json -> tsconfig.json -> tsconfig.tools.json. Without a
    // visited guard this expands forever rather than failing.
    const project = await openProject(solutionConfig());
    expect(project.files().length).toBe(3);
  });

  it("roots at the config directory, not at a referenced project's directory", async () => {
    const project = await openProject(solutionConfig());
    for (const f of project.files()) expect(f.path.startsWith("..")).toBe(false);
  });
});

describe("commonRootDir", () => {
  it("returns the dirname of a single config", () => {
    expect(commonRootDir(["/repo/tsconfig.json"])).toBe("/repo");
  });

  it("returns the shared dir for two configs in the same directory", () => {
    expect(commonRootDir(["/repo/tsconfig.json", "/repo/tsconfig.build.json"])).toBe("/repo");
  });

  it("returns the common ancestor for sibling packages", () => {
    expect(
      commonRootDir(["/repo/packages/a/tsconfig.json", "/repo/packages/b/tsconfig.json"]),
    ).toBe("/repo/packages");
  });

  it("compares whole segments, never string prefixes", () => {
    expect(
      commonRootDir(["/repo/pack/x/tsconfig.json", "/repo/package/y/tsconfig.json"]),
    ).toBe("/repo");
  });

  it("throws rather than guessing when given no configs", () => {
    expect(() => commonRootDir([])).toThrow();
  });
});
