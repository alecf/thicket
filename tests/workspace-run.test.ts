import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachePathFor } from "../src/cache/db.js";
import { runReport } from "../src/run.js";
import { nestedWorkspacesRoot, workspacesRoot } from "./helpers.js";

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
  const root = mkdtempSync(join(tmpdir(), "thicket-ws-run-"));
  temps.push(root);
  cpSync(from, root, {
    recursive: true,
    filter: (src) => !src.split(sep).includes(".thicket"),
  });
  return root;
}

/** A throwaway directory holding exactly `files`, keyed by relative name. */
function scratchTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "thicket-ws-tree-"));
  temps.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2022",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    noEmit: true,
  },
  include: ["src/**/*.ts"],
});

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
    expect(json.scope.gaps.map((g) => g.dir)).toEqual(["libs/ignored"]);
  });

  /**
   * THE REGRESSION THE PIN EXISTS FOR. `project.root` is `commonRootDir` of the
   * configs actually opened, so narrowing to one workspace collapses it into
   * that workspace and `.thicket/cache.db` lands in a subpackage.
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
