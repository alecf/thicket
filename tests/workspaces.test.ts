import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globsFromPnpmText, workspaceGlobs } from "../src/extract/workspaces.js";
import { pnpmWorkspacesRoot, workspacesRoot } from "./helpers.js";

/**
 * Runs `body` against a throwaway root holding exactly `files`, keyed by name.
 *
 * Malformed and oddly-shaped manifests are written here rather than committed
 * as fixtures: each one is read by a single assertion, needs no TypeScript
 * beside it, and an unparseable `package.json` checked into `tests/fixtures/`
 * is a trap for every tool that walks this repo. The empty case -- `{}` -- is a
 * temp dir for a different reason: it must be a directory that exists and holds
 * no manifest, and a committed fixture only has that property until someone
 * adds a `package.json` to it, at which point the test silently starts
 * exercising a branch another test already covers.
 *
 * Files are named rather than implied, because which manifest wins when a root
 * holds two of them is itself under test.
 */
function withRoot(files: Record<string, string>, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "thicket-ws-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
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
  it("answers undefined when the directory holds no manifest at all", () => {
    withRoot({}, (root) => {
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
    withRoot(
      {
        "package.json": JSON.stringify({
          workspaces: { packages: ["libs/*", "!libs/ignored"], nohoist: ["**/x"] },
        }),
      },
      (root) => expect(workspaceGlobs(root)).toEqual(["libs/*", "!libs/ignored"]),
    );
  });

  it("answers undefined for a manifest that declares no workspaces", () => {
    // A different branch from "no package.json at all": the file is there and
    // parses, and the `workspaces` key simply is not in it. Every single-package
    // repo with a manifest takes this path.
    withRoot({ "package.json": JSON.stringify({ name: "plain", version: "1.0.0" }) }, (root) =>
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
    withRoot({ "package.json": JSON.stringify({ workspaces: [] }) }, (root) =>
      expect(workspaceGlobs(root)).toEqual([]),
    );
  });

  it("answers [] for a yarn v1 object declaring exactly no workspaces", () => {
    // Both branches take the same tidy-up, so both need the guard.
    withRoot({ "package.json": JSON.stringify({ workspaces: { packages: [] } }) }, (root) =>
      expect(workspaceGlobs(root)).toEqual([]),
    );
  });

  it("answers undefined for an unparseable manifest rather than throwing", () => {
    // Discovery is a convenience, never a dependency. A manifest mid-edit must
    // degrade to "not a workspace root", not take the run down with it.
    withRoot({ "package.json": '{ "workspaces": ["libs/*",' }, (root) =>
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
    withRoot(
      {
        "package.json": JSON.stringify({
          workspaces: ["libs/*", 7, { packages: ["x"] }, null, "tools/*"],
        }),
      },
      (root) => expect(workspaceGlobs(root)).toEqual(["libs/*", "tools/*"]),
    );
  });

  it("reads the block-list form from pnpm-workspace.yaml, in declaration order", () => {
    // The fixture's `package.json` has no `workspaces` key, so the YAML is the
    // only thing here that can answer. Declaration order is deliberately
    // unsorted for the same reason as the package.json case above.
    expect(workspaceGlobs(pnpmWorkspacesRoot())).toEqual([
      "libs/*",
      "tools/*",
      "libs/nested/*",
      "services",
      "!libs/private",
    ]);
  });

  it("prefers package.json over pnpm-workspace.yaml when a root holds both", () => {
    // A repo that migrated to pnpm and left the old key behind holds two
    // answers, and the two files must not be consulted in whichever order
    // reads more naturally. `package.json` wins: every package manager reads
    // it, so it is the one both tools agree on.
    withRoot(
      {
        "package.json": JSON.stringify({ workspaces: ["from-package-json/*"] }),
        "pnpm-workspace.yaml": "packages:\n  - from-yaml/*\n",
      },
      (root) => expect(workspaceGlobs(root)).toEqual(["from-package-json/*"]),
    );
  });

  it("finds the .yml spelling of the pnpm manifest", () => {
    // Both spellings are in the wild and pnpm accepts either. Checking only
    // `.yaml` reports a `.yml` monorepo as a plain single project.
    withRoot({ "pnpm-workspace.yml": "packages:\n  - libs/*\n" }, (root) =>
      expect(workspaceGlobs(root)).toEqual(["libs/*"]),
    );
  });

  it("answers undefined when the pnpm manifest cannot be read", () => {
    // Same rule as an unparseable `package.json`: discovery degrades, it never
    // throws. A directory wearing the manifest's name is the portable way to
    // make the read fail on every platform.
    withRoot({}, (root) => {
      mkdirSync(join(root, "pnpm-workspace.yaml"));
      expect(workspaceGlobs(root)).toBeUndefined();
    });
  });
});

describe("globsFromPnpmText", () => {
  it("unquotes single-quoted, double-quoted and bare entries alike", () => {
    expect(globsFromPnpmText("packages:\n  - 'a/*'\n  - \"b/*\"\n  - c/*\n")).toEqual([
      "a/*",
      "b/*",
      "c/*",
    ]);
  });

  it("keeps a # that is inside a glob", () => {
    // YAML starts a comment at `#` only at line start or after whitespace. A
    // blanket strip truncates `libs/c#1/*` to `libs/c`, which is still a valid
    // glob -- so the manifest would be read, silently, as naming a different
    // directory.
    expect(globsFromPnpmText("packages:\n  - libs/c#1/*\n  - 'd/*' # trailing\n")).toEqual([
      "libs/c#1/*",
      "d/*",
    ]);
  });

  it("skips a full-line comment inside the list", () => {
    expect(globsFromPnpmText("packages:\n  # why these\n  - a/*\n")).toEqual(["a/*"]);
  });

  it("reads a list written at zero indentation", () => {
    // YAML lets a block sequence sit at its key's own indentation, and real
    // manifests are written both ways. Requiring the indented form returns
    // `[]` here rather than failing -- and `[]` is a confident answer meaning
    // "this is a workspace root with no members", which is exactly the wrong
    // thing to say about a root declaring two.
    expect(globsFromPnpmText("packages:\n- 'libs/*'\n- tools/*\n")).toEqual(["libs/*", "tools/*"]);
  });

  it("stops at the next top-level key", () => {
    expect(
      globsFromPnpmText("packages:\n  - a/*\ncatalog:\n  react: ^18\nignoredKey:\n  - b/*\n"),
    ).toEqual(["a/*"]);
  });

  it("answers undefined for a manifest with no packages key", () => {
    expect(globsFromPnpmText("catalog:\n  react: ^18\n")).toBeUndefined();
  });

  // Degrading to `undefined` keeps a shape we cannot parse from silently
  // becoming a wrong answer.
  it("answers undefined for a flow sequence", () => {
    expect(globsFromPnpmText("packages: ['a/*']\n")).toBeUndefined();
  });

  it("answers undefined for a pnpm manifest shape it does not understand", () => {
    expect(globsFromPnpmText("packages: { a: 1 }\n")).toBeUndefined();
  });

  it("answers undefined for a nested mapping under packages", () => {
    // Not a list of scalars. Reading the keys as globs would hand back
    // `["libs"]`, an answer with no relationship to what the manifest says.
    expect(globsFromPnpmText("packages:\n  libs:\n    - a/*\n")).toBeUndefined();
  });
});
