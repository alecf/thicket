import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openProject, sourceFileNames } from "../src/extract/ts-adapter.js";
import {
  COMPILER_OPTIONS,
  generatedConfig,
  monorepoConfigs,
  solutionWorkspacesRoot,
  workspacesRoot,
} from "./helpers.js";

const alphaConfig = resolve(workspacesRoot(), "tools/alpha/tsconfig.json");
const alphaTestConfig = resolve(workspacesRoot(), "tools/alpha/tsconfig.test.json");

describe("sourceFileNames", () => {
  it("lists a project's source files without materializing them", async () => {
    // Relative to the config's own directory, which is where `commonRootDir`
    // puts the root for a single config -- the same root `openProject` reports.
    // An exact list, because the failure this catches is not a missing file:
    // the program also lists the 63 default lib files, which live wherever the
    // toolchain was installed, and one that survived the skip rules arrives as
    // a `../../..` path that matches nothing the caller holds.
    const { names } = await sourceFileNames([alphaConfig]);
    // The main config excludes tests; the probe must reflect that exactly.
    expect(names).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("sees the file the sibling test config adds", async () => {
    const { names } = await sourceFileNames([alphaConfig, alphaTestConfig]);
    // `a.ts` appears in both programs -- the test config pulls it in through
    // `a.test.ts`'s import -- so this also pins the dedupe.
    //
    // And it pins the SORT, which nothing else here would: the projects are
    // walked in the order they were opened, so the names arrive as
    // [a.ts, b.ts, a.test.ts] and only `compareStrings` puts `a.test.ts` first
    // ("a.test.ts" < "a.ts" because `e` < `s` at the fourth character).
    expect(names).toEqual(["src/a.test.ts", "src/a.ts", "src/b.ts"]);
  });

  it("splits the names by the config that contributed them", async () => {
    // The union cannot answer "which of these two siblings added the file",
    // and that is the question sibling selection asks. `tsconfig.build.json`
    // names a PROPER subset of `tsconfig.json`, so it adds nothing to the
    // union at all -- read the union alone and it is indistinguishable from
    // `tsconfig.test.json`, which adds the one file the main config excludes.
    const buildConfig = resolve(workspacesRoot(), "tools/alpha/tsconfig.build.json");
    const { names, byConfig } = await sourceFileNames([alphaConfig, buildConfig, alphaTestConfig]);
    expect(names).toEqual(["src/a.test.ts", "src/a.ts", "src/b.ts"]);
    // Keys are lower-cased absolute paths; tsconfig paths reach us with host
    // casing, and `expandReferences` folds case for the same reason.
    expect(byConfig.get(alphaConfig.toLowerCase())).toEqual(["src/a.ts", "src/b.ts"]);
    expect(byConfig.get(buildConfig.toLowerCase())).toEqual(["src/a.ts"]);
    // The transitive closure, not the `include`: `a.test.ts` imports `a.ts`.
    expect(byConfig.get(alphaTestConfig.toLowerCase())).toEqual(["src/a.test.ts", "src/a.ts"]);
  });

  it("expands references, so a solution config does not answer 'no files'", async () => {
    // `{"files": [], "references": [...]}` owns nothing itself. A probe that
    // stopped at the requested config would report zero files here, and a
    // caller comparing that against the tree would conclude the config covers
    // nothing rather than that the probe never looked.
    const { names } = await sourceFileNames([resolve(solutionWorkspacesRoot(), "tsconfig.json")]);
    expect(names).toEqual(["tools/alpha/src/a.ts"]);
  });

  it("roots at the ancestor of the configs actually opened", async () => {
    // A reference that reaches OUT of the requested config's directory moves
    // the root upwards. Root the answer at the requested config instead and
    // every path comes back `../`-prefixed, matching nothing the caller holds.
    //
    // Written here rather than taken from a fixture because no committed
    // fixture can exercise it: `commonRootDir(opened)` can only ever be an
    // ancestor of `commonRootDir(configs)`, so a solution config whose
    // references point DOWN (which is every one we ship) leaves the root
    // exactly where it was.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "thicket-probe-")));
    try {
      const compilerOptions = COMPILER_OPTIONS;
      await mkdir(join(dir, "build"), { recursive: true });
      await mkdir(join(dir, "pkg/src"), { recursive: true });
      await writeFile(
        join(dir, "build/tsconfig.json"),
        JSON.stringify({ files: [], references: [{ path: "../pkg" }] }),
      );
      await writeFile(
        join(dir, "pkg/tsconfig.json"),
        JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }),
      );
      await writeFile(join(dir, "pkg/src/x.ts"), "export const x = 1;\n");

      const { root, names } = await sourceFileNames([join(dir, "build/tsconfig.json")]);
      // The root is REPORTED, not assumed: the caller never sees the config
      // set `expandReferences` opened, so it cannot compute this itself.
      expect(root).toBe(dir);
      expect(names).toEqual(["pkg/src/x.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not hand back a declaration file the project itself declares", async () => {
    // The `.d.ts` rule cannot be pinned on any fixture whose only declaration
    // files are the default lib: those are listed too -- 63 of them, which is
    // most of a 65-name program -- but in this checkout they resolve under
    // `node_modules/@typescript/...`, so the node_modules rule would catch
    // them even with this one deleted. An ambient declaration file inside the
    // project is the case where the extension is the only rule that applies.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "thicket-probe-dts-")));
    try {
      await mkdir(join(dir, "types"), { recursive: true });
      await writeFile(join(dir, "types/global.d.ts"), "declare const AMBIENT: number;\n");
      await writeFile(join(dir, "main.ts"), "export const n = AMBIENT;\n");
      // The CAPITAL in `Util.ts` is load-bearing -- do not rename this file to
      // something tidier. It is the only datum in these tests whose order
      // differs between code-unit comparison and collation: `compareStrings`
      // puts `Util.ts` first (`U` < `m`), while `localeCompare` folds case and
      // puts `main.ts` first. Without it, swapping the comparator leaves every
      // probe test green, and the determinism rule in AGENTS.md §1 is pinned
      // as "some sort happens" rather than as the order it names.
      await writeFile(join(dir, "Util.ts"), "export const u = 1;\n");
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true, module: "nodenext", moduleResolution: "nodenext" },
          // `**/*.ts` matches `.d.ts` too, which is how ambient declarations
          // reach a program in the first place.
          include: ["**/*.ts"],
        }),
      );

      const { names } = await sourceFileNames([join(dir, "tsconfig.json")]);
      expect(names).toEqual(["Util.ts", "main.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a .ts file that resolution pulled out of node_modules", async () => {
    // An unbuilt dependency ships TypeScript, so this is a program file like
    // any other -- and analyzing it reports duplication nobody in this repo
    // can fix.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "thicket-probe-nm-")));
    try {
      await mkdir(join(dir, "node_modules/dep"), { recursive: true });
      await writeFile(
        join(dir, "node_modules/dep/package.json"),
        JSON.stringify({ name: "dep", version: "1.0.0", types: "index.ts", main: "index.ts" }),
      );
      await writeFile(join(dir, "node_modules/dep/index.ts"), "export const dep = 1;\n");
      await writeFile(join(dir, "main.ts"), `import { dep } from "dep";\nexport const n = dep;\n`);
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true, module: "nodenext", moduleResolution: "nodenext" },
          include: ["main.ts"],
        }),
      );

      const { names } = await sourceFileNames([join(dir, "tsconfig.json")]);
      expect(names).toEqual(["main.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sourceFileNames agrees with openProject", () => {
  // The guard against the two drifting apart. `fixtures/monorepo` is chosen
  // because every rule the probe deliberately skips is inert there -- no
  // generated directory, no banner, no `--exclude` -- so the lists must be
  // identical rather than merely compatible, and it opens two configs in
  // sibling directories so both agree on a root neither config's own
  // directory would give.
  it("returns exactly the files openProject analyzes, measured from the same root", async () => {
    const probed = await sourceFileNames(monorepoConfigs());
    const project = await openProject(monorepoConfigs());
    try {
      // Both halves matter: identical lists measured from different roots
      // would still be two different answers.
      expect(probed.root).toBe(project.root);
      expect(probed.names).toEqual(project.files().map((f) => f.path));
      expect(probed.names).toEqual(["a/src/index.ts", "b/src/index.ts", "shared/src/util.ts"]);
    } finally {
      await project.close();
    }
  });

  // The other half of the agreement: where the probe is MEANT to diverge, by
  // how much, and in which direction. `fixtures/generated` holds one file per
  // rule the probe skips -- `dist/` and `packages/a/.next/` for the directory
  // rule, `table.gen.ts` and `widgets/badge.ts` for the banner sniff.
  //
  // Direction is the load-bearing part, not the count. The probe must be a
  // strict SUPERSET: `scanSourceFiles` applies all three rules too, so a file
  // the probe reports and the analysis drops is a file the scan never counted,
  // and it can neither invent nor hide a gap. A probe that dropped MORE than
  // the scan would report a gap no flag can close. Assert both subsets, so a
  // change in either direction fails here rather than in Task 7's arithmetic.
  it("reports the generated files openProject drops, and nothing less", async () => {
    const probed = await sourceFileNames([generatedConfig()]);
    const project = await openProject(generatedConfig());
    try {
      const analyzed = project.files().map((f) => f.path);
      expect(analyzed).toEqual([
        "src/distance/measure.ts",
        "src/handwritten.ts",
        "src/mentions.ts",
        "src/outbound.ts",
      ]);
      // Nothing analyzed is missing from the probe: the safe direction.
      expect(analyzed.filter((p) => !probed.names.includes(p))).toEqual([]);
      // And the excess is exactly the files the two exclusion rules dropped.
      expect(probed.names.filter((p) => !analyzed.includes(p))).toEqual([
        "dist/emitted.ts",
        "packages/a/.next/validator.ts",
        "src/table.gen.ts",
        "src/widgets/badge.ts",
      ]);
    } finally {
      await project.close();
    }
  });
});
