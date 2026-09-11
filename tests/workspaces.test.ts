import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceGlobs } from "../src/extract/workspaces.js";
import { workspacesRoot } from "./helpers.js";

/**
 * Runs `body` against a throwaway root, empty unless `manifest` is given.
 *
 * Malformed and oddly-shaped manifests are written here rather than committed
 * as fixtures: each one is read by a single assertion, needs no TypeScript
 * beside it, and an unparseable `package.json` checked into `tests/fixtures/`
 * is a trap for every tool that walks this repo. The empty case is a temp dir
 * for a different reason -- it must be a directory that exists and holds no
 * manifest, and a committed fixture only has that property until someone adds
 * a `package.json` to it, at which point the test silently starts exercising a
 * branch another test already covers.
 */
function withRoot(manifest: string | undefined, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "thicket-ws-"));
  try {
    if (manifest !== undefined) writeFileSync(join(root, "package.json"), manifest);
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A root holding exactly this `package.json` and nothing else. */
const withManifest = (text: string, body: (root: string) => void): void => withRoot(text, body);

/** A root that exists and holds no manifest. */
const withEmptyRoot = (body: (root: string) => void): void => withRoot(undefined, body);

describe("workspaceGlobs", () => {
  it("reads the array form from package.json, in declaration order", () => {
    // Declaration order is load-bearing: `--filter` is applied in order and so
    // is negation, so a set or a sort here changes which workspaces survive.
    expect(workspaceGlobs(workspacesRoot())).toEqual([
      "tools/*",
      "libs/*",
      "deep/**",
      "!libs/ignored",
    ]);
  });

  // A root that is not a workspace root must be distinguishable from one
  // declaring zero workspaces, or discovery cannot decide whether to run.
  it("answers undefined when the directory holds no manifest at all", () => {
    withEmptyRoot((root) => {
      // The two halves of what this case claims to be. Without them it would
      // still pass against a path that does not exist, or against one that
      // grew a manifest -- and in the second case it would quietly become a
      // copy of the "declares no workspaces" test below, leaving the absent-
      // file arm of the catch uncovered.
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(root, "package.json"))).toBe(false);
      expect(workspaceGlobs(root)).toBeUndefined();
    });
  });

  it("reads the yarn v1 object form", () => {
    // yarn v1 nests the list under `packages` and puts `nohoist` beside it.
    // Reading only the array form finds nothing in a yarn v1 monorepo and
    // reports it as a plain single project, which is a silently empty answer
    // rather than an error.
    withManifest(
      JSON.stringify({ workspaces: { packages: ["libs/*", "!libs/ignored"], nohoist: ["**/x"] } }),
      (root) => expect(workspaceGlobs(root)).toEqual(["libs/*", "!libs/ignored"]),
    );
  });

  it("answers undefined for a manifest that declares no workspaces", () => {
    // A different branch from "no package.json at all": the file is there and
    // parses, and the `workspaces` key simply is not in it. Every single-package
    // repo with a manifest takes this path.
    withManifest(JSON.stringify({ name: "plain", version: "1.0.0" }), (root) =>
      expect(workspaceGlobs(root)).toBeUndefined(),
    );
  });

  // `[]` and `undefined` are different answers and the next two cases are what
  // hold them apart. An empty list is a declaration -- this IS a workspace
  // root, and it currently has no members -- so discovery runs and finds none.
  // `undefined` says no manifest declared workspaces at all, so discovery must
  // not run and the root is treated as a plain project. Folding the empty list
  // into the `undefined` path looks like tidying two empty cases into one and
  // silently changes what a zero-member monorepo means.
  it("answers [] for an array declaring exactly no workspaces", () => {
    withManifest(JSON.stringify({ workspaces: [] }), (root) =>
      expect(workspaceGlobs(root)).toEqual([]),
    );
  });

  it("answers [] for a yarn v1 object declaring exactly no workspaces", () => {
    // Both branches take the same tidy-up, so both need the guard.
    withManifest(JSON.stringify({ workspaces: { packages: [] } }), (root) =>
      expect(workspaceGlobs(root)).toEqual([]),
    );
  });

  it("answers undefined for an unparseable manifest rather than throwing", () => {
    // Discovery is a convenience, never a dependency. A manifest mid-edit must
    // degrade to "not a workspace root", not take the run down with it.
    withManifest('{ "workspaces": ["libs/*",', (root) =>
      expect(workspaceGlobs(root)).toBeUndefined(),
    );
  });

  it("drops non-string entries and keeps the rest in order", () => {
    // A glob list is consumed as strings. Passing a number or an object through
    // defers the failure to whoever expands it, where it reads as a bad glob
    // rather than as a malformed manifest.
    //
    // This expectation happens to be in sorted order, so it alone cannot catch
    // an introduced sort. Order is guarded by the fixture case at the top of
    // this file, whose declaration order is deliberately unsorted -- do not
    // delete that one believing this covers it.
    withManifest(
      JSON.stringify({ workspaces: ["libs/*", 7, { packages: ["x"] }, null, "tools/*"] }),
      (root) => expect(workspaceGlobs(root)).toEqual(["libs/*", "tools/*"]),
    );
  });
});
