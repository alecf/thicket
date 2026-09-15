import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachePathFor } from "../src/cache/db.js";
import { runReport } from "../src/run.js";
import {
  filterWorkspacesRoot,
  nestedWorkspacesRoot,
  TSCONFIG,
  workspacesRoot,
} from "./helpers.js";

/**
 * `runReport` with a `dir` is the whole monorepo path: discovery, filtering,
 * and the root everything downstream is measured from. These go through
 * `runReport` rather than `main` because the properties under test -- where
 * the cache file lands, what the config hash is, what the scope figures count
 * -- are data, and the Markdown is truncated to the top findings (AGENTS.md
 * "Assert on the data structure, not the rendered report").
 */

const temps: string[] = [];

/** A throwaway copy of a fixture, so a test may let a cache be written into it. */
function scratchCopy(from: string): string {
  const root = mkdtempSync(join(tmpdir(), "underbrush-ws-run-"));
  temps.push(root);
  cpSync(from, root, {
    recursive: true,
    filter: (src) => !src.split(sep).includes(".underbrush"),
  });
  return root;
}

/** A throwaway directory holding exactly `files`, keyed by relative name. */
function scratchTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "underbrush-ws-tree-"));
  temps.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("runReport over a workspace root", () => {
  it("analyzes every selected workspace, and nothing a negation glob excluded", async () => {
    const { json } = await runReport({ dir: workspacesRoot(), cache: false });
    // scripts/root-util.ts, tools/alpha/src/{a,a.test,b}.ts, libs/beta/src/b.ts,
    // deep/a/b/gamma/src/g.ts. Every workspace contributes, and `libs/ignored`
    // -- which has a working tsconfig of its own -- contributes nothing.
    expect(json.fileCount).toBe(6);
    expect(json.scope.onDisk).toBe(7);
    // The whole gap, through the JSON sidecar: `libs/ignored` is excluded by a
    // negation glob, so its own config was never opened and is still worth
    // suggesting. A gap that has something to offer must keep offering it --
    // suppressing the tried ones must not suppress this.
    expect(json.scope.gaps).toEqual([
      { dir: "libs/ignored", fileCount: 1, configs: ["libs/ignored/tsconfig.json"] },
    ]);
  });

  /**
   * The defect this pair exists for. On a sample monorepo at 98.4% coverage, 8
   * of the 9 gaps advised a `--config` the run had already opened -- it was
   * that config's own `include`/`exclude` leaving the files out, so following
   * the advice changed nothing.
   */
  const gappedWorkspace = (extra: Record<string, string>) => ({
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["pkg/*"] }),
    // A root config of its own, so the analyzed root stays the tree root --
    // with only `pkg/a`'s config to open, `commonRootDir` collapses onto it
    // and every path below is measured from somewhere else.
    "tsconfig.json": JSON.stringify({ include: ["scripts/**/*.ts"] }),
    "scripts/s.ts": "export const s = 1;\n",
    "pkg/a/package.json": JSON.stringify({ name: "@t/a" }),
    "pkg/a/tsconfig.json": TSCONFIG,
    "pkg/a/src/a.ts": "export const a = 1;\n",
    // Outside `src/**`, so the workspace's own config cannot reach it.
    "pkg/a/other/x.ts": "export const x = 1;\n",
    ...extra,
  });

  it("offers no config for a gap whose directory's only config was opened", async () => {
    const { json } = await runReport({ dir: scratchTree(gappedWorkspace({})), cache: false });
    expect(json.scope.gaps).toEqual([{ dir: "pkg/a", fileCount: 1, configs: [] }]);
  });

  /**
   * The other half, and the only thing the scan cannot work out for itself:
   * `tsconfig.build.json` was never opened by the run, so "already passed"
   * does not reach it -- but the probe DID open it, found none of the missing
   * file in it, and declined it. Offering it would send the reader to load a
   * config already proven to leave this gap exactly where it is.
   */
  it("offers no config the workspace probe opened and declined", async () => {
    const root = scratchTree(
      gappedWorkspace({
        // A proper subset of `tsconfig.json`'s file set: it adds nothing, so
        // the probe declines it. `src/b.ts` is what keeps the containment
        // proper, so a rule that merely skipped an EQUAL file set would not
        // pass this test.
        "pkg/a/tsconfig.build.json": JSON.stringify({
          extends: "./tsconfig.json",
          include: ["src/a.ts"],
        }),
        "pkg/a/src/b.ts": "export const b = 2;\n",
      }),
    );
    const { json } = await runReport({ dir: root, cache: false });
    expect(json.scope.gaps).toEqual([{ dir: "pkg/a", fileCount: 1, configs: [] }]);
  });

  /**
   * THE REGRESSION THE PIN EXISTS FOR. `project.root` is `commonRootDir` of the
   * configs actually opened, so narrowing to one workspace collapses it into
   * that workspace and `.underbrush/cache.db` lands in a subpackage.
   *
   * The nested fixture, not `workspaces/`: that one's root has a tsconfig of
   * its own, which is always among the primaries, so its common root is the
   * repo root whatever the filter says and this test would pass with the pin
   * deleted.
   */
  it("keeps one cache at the analyzed root even when filtered to one workspace", async () => {
    const root = scratchCopy(nestedWorkspacesRoot());
    await runReport({ dir: root, filter: ["@nest/sub"] });
    expect(existsSync(cachePathFor(root))).toBe(true);
    expect(existsSync(cachePathFor(join(root, "tools/alpha/sub")))).toBe(false);
  });

  /**
   * The other half of the same pin: repo-relative paths are the cache keys, so
   * they have to mean the same thing in a filtered run as in a full one. With
   * the root derived, this run measures from `tools/alpha/sub` -- its two files
   * become `scripts/gen.ts` and `src/s.ts`, the tree on disk shrinks to those
   * two, and the three files the filter excluded stop existing as far as the
   * report can tell.
   */
  it("measures paths and coverage from the analyzed root, not from the filter", async () => {
    const { json } = await runReport({
      dir: nestedWorkspacesRoot(),
      filter: ["@nest/sub"],
      cache: false,
    });
    expect(json.fileCount).toBe(2);
    expect(json.scope.onDisk).toBe(5);
    expect(json.scope.gaps.map((g) => g.dir)).toContain("tools/alpha");
  });

  /**
   * A filter changes which files are asked about, never what is stored for one
   * of them. Hash it and `--filter=alpha` deletes the whole-repo cache and the
   * next full run deletes alpha's (AGENTS.md §5: a stale `config_hash` makes
   * `openDatabase` drop every row).
   */
  it("shares one config hash between a filtered and an unfiltered run", async () => {
    const wide = await runReport({ dir: workspacesRoot(), cache: false });
    const narrow = await runReport({
      dir: workspacesRoot(),
      filter: ["@fix/alpha"],
      cache: false,
    });
    expect(narrow.json.fileCount).toBeLessThan(wide.json.fileCount);
    expect(narrow.json.configHash).toBe(wide.json.configHash);
  });

  /**
   * Module names are `UB-CYC-*` ids (PRD §9.1) and a report is read by
   * diffing it against the last one, so narrowing the run must not rename the
   * modules of a workspace that is still in it. Before per-workspace
   * granularity this tree reported `dir:3 (4 modules)` unfiltered and
   * `dir:1 (2 modules)` filtered -- `pkg/alpha/src/a.ts` moved from a module
   * called `pkg/alpha/src` to one called `pkg`.
   *
   * The names themselves are asserted in `tests/graph.test.ts`, which can see
   * the graph; what this pins is that discovery hands the granularity ladder
   * the workspace list at all, and the same repository size either way.
   */
  it("targets a module size per workspace, unchanged by a filter", async () => {
    const wide = await runReport({ dir: filterWorkspacesRoot(), cache: false });
    const narrow = await runReport({
      dir: filterWorkspacesRoot(),
      filter: ["@filt/alpha"],
      cache: false,
    });
    expect(wide.json.granularity).toBe("workspace");
    expect(narrow.json.granularity).toBe("workspace");
    // alpha, beta/src, beta/scripts and the root's own scripts/ -- then alpha
    // and the root alone. The count falls because two modules left the run,
    // not because the two that stayed were re-cut.
    expect(wide.json.moduleCount).toBe(4);
    expect(narrow.json.moduleCount).toBe(2);
  });

  /**
   * The target module size is a property of the REPOSITORY, not of the slice
   * `--filter` asked about. Measured on a tree of 14 files: with the whole
   * tree as the basis a module wants 1.75 files, so `pkg/small`'s two files
   * are one module; with only the filtered run as the basis a module wants
   * 0.25, and the same two files become two modules named
   * `pkg/small/p` and `pkg/small/q`. The workspace that survived the filter
   * would have been re-cut because of workspaces that did not.
   *
   * The fixture has to be this size to say anything: the target is
   * `files / clamp(round(sqrt(files)), 8, 64)`, and below ~12 files the floor
   * of 8 pins the target so low that every workspace splits under either
   * basis. The `workspaces-filter` fixture cannot express this.
   */
  it("sizes modules from the whole tree, not from the filtered slice", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "r", private: true, workspaces: ["pkg/*"] }),
      "pkg/big/package.json": JSON.stringify({ name: "@s/big" }),
      "pkg/big/tsconfig.json": TSCONFIG,
      "pkg/small/package.json": JSON.stringify({ name: "@s/small" }),
      "pkg/small/tsconfig.json": TSCONFIG,
      "pkg/small/src/p/a.ts": "export const a = 1;\n",
      "pkg/small/src/q/b.ts": "export const b = 2;\n",
    };
    for (let i = 0; i < 12; i++) files[`pkg/big/src/f${i}.ts`] = `export const f${i} = ${i};\n`;
    const root = scratchTree(files);

    const wide = await runReport({ dir: root, cache: false });
    const narrow = await runReport({ dir: root, filter: ["@s/small"], cache: false });
    expect(wide.json.fileCount).toBe(14);
    expect(narrow.json.fileCount).toBe(2);
    // `pkg/big` and `pkg/small`, then `pkg/small` alone -- still one module.
    expect(wide.json.moduleCount).toBe(2);
    expect(narrow.json.moduleCount).toBe(1);
  });

  /**
   * Workspace directories are discovered before the program is loaded, so they
   * are measured from the directory that was walked. The graph speaks paths
   * measured from the ANALYZED root, and the two are the same directory only
   * when something pinned it. A programmatic run that names neither a `dir`
   * nor a `config` roots itself at the common ancestor of the configs it
   * opened, which here is `pkg/a` -- one level BELOW the manifest.
   *
   * Both halves are load-bearing and this asserts them together. Leave the
   * directories unrebased and `pkg/a` matches no analyzed path, so every file
   * falls into the root group; keep the two that land outside the analyzed
   * root -- `pkg`, which is its parent and rebases to exactly `..`, and
   * `pkg/b`, which is its sibling -- and the run counts three workspaces where
   * it analyzed one. Either way the per-workspace ladder runs where it has
   * nothing to say, and the header reads `workspace` rather than `dir:1`.
   */
  it("measures workspace directories from the analyzed root, not the walked one", async () => {
    const root = scratchTree({
      "package.json": JSON.stringify({
        name: "r",
        private: true,
        workspaces: ["pkg", "pkg/*"],
      }),
      "pkg/package.json": JSON.stringify({ name: "@s/all" }),
      "pkg/a/package.json": JSON.stringify({ name: "@s/a" }),
      "pkg/a/tsconfig.json": TSCONFIG,
      "pkg/a/src/x.ts": "export const x = 1;\n",
      "pkg/a/src/sub/y.ts": "export const y = 2;\n",
      // No tsconfig, so nothing here is analyzed and the root lands in pkg/a.
      "pkg/b/package.json": JSON.stringify({ name: "@s/b" }),
      "pkg/b/src/z.ts": "export const z = 3;\n",
    });
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const { json } = await runReport({ cache: false });
      expect(json.fileCount).toBe(2);
      expect(json.granularity).toBe("dir:1");
    } finally {
      process.chdir(cwd);
    }
  });

  /**
   * `--granularity` is an instruction, not a guess, so the multi-workspace
   * path never overrides it (AGENTS.md 4b). A fixed depth still means one
   * depth for the whole tree, common prefix stripped.
   */
  it("leaves an explicit --granularity alone on a workspace root", async () => {
    const { json } = await runReport({
      dir: filterWorkspacesRoot(),
      granularity: 1,
      cache: false,
    });
    expect(json.granularity).toBe("dir:1");
    expect(json.moduleCount).toBe(2);
  });

  /**
   * The escape case. A config that reaches above the directory named on the
   * command line cannot be rooted there -- its files would need `../` paths,
   * which repo-relative paths cannot express -- so the derived root wins and
   * the run says which one it used.
   */
  /**
   * The same decline, reached by the boundary rather than by depth. `pack` is a
   * string prefix of `package` and an ancestor of nothing, so a raw
   * `derived.startsWith(abs)` accepts the pin: every analyzed file then gets a
   * `../package/`-prefixed path -- the one thing repo-relative paths may never
   * carry -- and the warning that would have said so never fires. The same trap
   * `commonRootDir` compares whole segments to avoid.
   */
  it("declines a pin that is a string prefix of the real root, not an ancestor", async () => {
    const outer = scratchTree({
      "package/tsconfig.json": TSCONFIG,
      "package/src/a.ts": "export const a = 1;\n",
    });
    mkdirSync(join(outer, "pack"));
    const warnings: string[] = [];
    const { json } = await runReport({
      config: [join(outer, "package/tsconfig.json")],
      dir: join(outer, "pack"),
      cache: false,
      warn: (message) => warnings.push(message),
    });
    expect(json.fileCount).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(outer, "package"));
  });

  it("declines the pin, loudly, when a config reaches above the analyzed dir", async () => {
    const warnings: string[] = [];
    const { json } = await runReport({
      config: [join(workspacesRoot(), "tsconfig.json")],
      dir: join(workspacesRoot(), "tools"),
      cache: false,
      warn: (message) => warnings.push(message),
    });
    expect(json.fileCount).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(resolve(workspacesRoot()));
  });
});
