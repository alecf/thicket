import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceGlobs } from "../src/extract/workspaces.js";
import { partialRoot, workspacesRoot } from "./helpers.js";

/**
 * Runs `body` against a throwaway root holding exactly the `package.json` text
 * given. Malformed and oddly-shaped manifests are written here rather than
 * committed as fixtures: each one is read by a single assertion, needs no
 * TypeScript beside it, and an unparseable `package.json` checked into
 * `tests/fixtures/` is a trap for every tool that walks this repo.
 */
function withManifest(text: string, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "thicket-ws-"));
  try {
    writeFileSync(join(root, "package.json"), text);
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
  it("answers undefined when no manifest declares workspaces", () => {
    expect(workspaceGlobs(partialRoot())).toBeUndefined();
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
    withManifest(
      JSON.stringify({ workspaces: ["libs/*", 7, { packages: ["x"] }, null, "tools/*"] }),
      (root) => expect(workspaceGlobs(root)).toEqual(["libs/*", "tools/*"]),
    );
  });
});
