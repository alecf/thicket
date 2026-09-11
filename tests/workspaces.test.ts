import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverWorkspaces,
  globsFromPnpmText,
  workspaceGlobs,
} from "../src/extract/workspaces.js";
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
 * holds two of them is itself under test. A name may carry directories, since
 * a workspace root's members live in subdirectories of it.
 */
function withRoot(files: Record<string, string>, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "thicket-ws-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
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

  it("lets an empty package.json declaration win over a pnpm manifest", () => {
    // `[]` is not nullish, so the pnpm file is never consulted -- and that is
    // the right answer, not an accident of `??`. An explicit empty declaration
    // is still a declaration: a root saying "I have no workspaces" must not be
    // overruled by a second manifest left behind by a half-finished migration.
    withRoot(
      {
        "package.json": JSON.stringify({ workspaces: [] }),
        "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
      },
      (root) => expect(workspaceGlobs(root)).toEqual([]),
    );
  });

  it("reads a root whose members are on disk beside the manifest", () => {
    // The answer comes from the manifest alone -- what is on disk neither adds
    // to it nor subtracts from it at this layer -- so this is also the one case
    // that builds a nested path through `withRoot`. Task 4 expands globs
    // against real directories and needs the helper to express one; without the
    // recursive mkdir the write throws ENOENT, and this is where that surfaces.
    withRoot(
      {
        "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
        "libs/beta/package.json": JSON.stringify({ name: "beta" }),
      },
      (root) => {
        expect(existsSync(join(root, "libs", "beta", "package.json"))).toBe(true);
        expect(workspaceGlobs(root)).toEqual(["libs/*"]);
      },
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

  it("reads a manifest with CRLF line endings", () => {
    // `\r` is a JavaScript line terminator, so `.` cannot match it and `$` does
    // not assert before it: a comment regex applied before `trimEnd` never
    // fires on a CRLF line. Both halves of that are silent. A trailing comment
    // survives into the glob -- `a/* # c` is well-formed and matches nothing,
    // so one workspace vanishes from discovery while the rest are reported
    // confidently -- and a full-line comment inside the list becomes an
    // unparseable line, discarding the whole manifest. Git for Windows defaults
    // to `core.autocrlf=true` and this repo has no `.gitattributes`, so a
    // Windows checkout of the fixture beside this file takes the second path.
    // Both symptoms, because they are separate failures: the first line has a
    // full-line comment (undefined before the fix) and the second a trailing
    // one (`["a/* # c"]` before the fix).
    expect(globsFromPnpmText("packages:\r\n  # why\r\n  - a/* # trailing\r\n")).toEqual(["a/*"]);
    expect(globsFromPnpmText("packages:\r\n  - a/* # c\r\n")).toEqual(["a/*"]);
  });

  it("reads a manifest that starts with a byte order mark", () => {
    // The BOM defeats `/^packages:\s*$/` on the very first line, so the whole
    // manifest is discarded and a pnpm monorepo reads as a plain single
    // project -- the same silent symptom the BOM strip on `package.json`
    // exists to prevent, and thicket-specific: YAML permits a leading BOM and
    // pnpm reads the file fine. Stripped here rather than at the read, so this
    // pure function is correct on its own and the case needs no filesystem.
    expect(globsFromPnpmText("\uFEFFpackages:\n  - a/*\n")).toEqual(["a/*"]);
  });

  it("stops at the next top-level key", () => {
    expect(
      globsFromPnpmText("packages:\n  - a/*\ncatalog:\n  react: ^18\nignoredKey:\n  - b/*\n"),
    ).toEqual(["a/*"]);
  });

  it("stops at a top-level key whose own list is flush", () => {
    // The item regex runs before the top-level-key break and no longer requires
    // indentation, so this is the shape that would leak if the break were ever
    // moved below it or loosened: `- esbuild` is a well-formed list item
    // belonging to somebody else's key. Nothing is wrong today -- this is here
    // so the next person to touch either regex does not have to re-derive it.
    expect(globsFromPnpmText("packages:\n  - a/*\nonlyBuiltDependencies:\n- esbuild\n")).toEqual([
      "a/*",
    ]);
  });

  it("answers [] for a packages key with no members", () => {
    // YAML calls this value `null`, and `undefined` would be the literal
    // reading. `[]` is the right answer anyway: the file declares `packages:`,
    // so this IS a pnpm workspace root, it just lists nobody -- the same
    // semantics `{"workspaces": []}` already has in package.json. The
    // `undefined`-versus-`[]` contract asks "is this a workspace root", which
    // the key's presence answers, and the two manifest formats agreeing on it
    // matters more than matching YAML's null/empty-list distinction.
    //
    // Ending at a later key and ending at EOF agree; both are pinned because
    // nothing else here would notice if only one of them changed.
    expect(globsFromPnpmText("packages:\ncatalog:\n  react: ^18.3.1\n")).toEqual([]);
    expect(globsFromPnpmText("packages:\n")).toEqual([]);
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

describe("discoverWorkspaces", () => {
  it("finds workspaces under non-conventional directory names", () => {
    // `tools/` and `libs/`, not `apps/` and `packages/`: a hardcoded layout
    // name finds nothing here rather than passing by luck.
    expect(discoverWorkspaces(workspacesRoot())).toEqual([
      { dir: "deep/a/b/gamma", name: "@fix/gamma" },
      { dir: "libs/beta", name: "beta" },
      { dir: "tools/alpha", name: "@fix/alpha" },
      { dir: "tools/cfgonly", name: "@fix/cfgonly" },
    ]);
  });

  // The negation glob is the only thing excluding `libs/ignored`; it has a
  // package.json AND a tsconfig.json like the others, so honouring the negation
  // is the only thing keeping its source out of the analyzed set.
  it("honours negation globs", () => {
    const dirs = discoverWorkspaces(workspacesRoot()).map((w) => w.dir);
    expect(dirs).not.toContain("libs/ignored");
  });

  // `deep/a/b/gamma` is reachable only through the `deep/**` glob. Every other
  // workspace sits at depth 2 under a `dir/*` glob, so without this one a naive
  // single-level expansion passes every test here -- and the decision to walk
  // for package.json and MATCH, rather than expand globs into paths, would be
  // asserted by nothing.
  it("matches a workspace nested below a ** glob", () => {
    const dirs = discoverWorkspaces(workspacesRoot()).map((w) => w.dir);
    expect(dirs).toContain("deep/a/b/gamma");
  });

  // Delete the node_modules skip in the package walk and `dep` becomes a
  // workspace -- and every transitive dependency of a real repo with it.
  it("never treats a package inside node_modules as a workspace", () => {
    const dirs = discoverWorkspaces(workspacesRoot()).map((w) => w.dir);
    expect(dirs.some((d) => d.includes("node_modules"))).toBe(false);
  });

  it("subtracts a negation wherever in the list it appears", () => {
    // `workspaceGlobs` preserves declaration order because `--filter` reads it
    // that way, and its docstring used to claim negation was order-sensitive
    // too -- a spec the code never had. Exclusions are subtracted from the
    // whole match, so position cannot matter. Pinned rather than asserted,
    // because that is how the wrong claim survived: nothing contradicted it.
    const files = {
      "libs/beta/package.json": JSON.stringify({ name: "beta" }),
      "libs/ignored/package.json": JSON.stringify({ name: "ignored" }),
    };
    const dirs = (globs: string[]) => {
      let out: string[] = [];
      withRoot({ ...files, "package.json": JSON.stringify({ workspaces: globs }) }, (root) => {
        out = discoverWorkspaces(root).map((w) => w.dir);
      });
      return out;
    };
    expect(dirs(["libs/*", "!libs/ignored"])).toEqual(["libs/beta"]);
    expect(dirs(["!libs/ignored", "libs/*"])).toEqual(["libs/beta"]);
  });

  // `deep/**` matches `deep/a` and `deep/a/b` too, and neither is a package.
  // Expanding the globs into paths and calling the results workspaces would
  // hand Task 7 two directories with nothing to analyze in them; walking for
  // `package.json` first cannot propose them at all.
  it("does not propose a matched directory that holds no package.json", () => {
    const dirs = discoverWorkspaces(workspacesRoot()).map((w) => w.dir);
    expect(dirs).not.toContain("deep/a");
    expect(dirs).not.toContain("deep/a/b");
  });

  it("answers [] for a root that declares no workspaces", () => {
    // `undefined` globs and `[]` globs are different answers to "is this a
    // workspace root" -- that distinction lives in `workspaceGlobs` and is
    // Task 5's to act on. Discovery has the same thing to say about both: no
    // members. What it must not do is walk the tree and report every package
    // it finds in a repo whose manifest never asked for workspaces.
    //
    // `libs/beta` is what makes that assertion mean anything. Without a
    // package on disk, a root that answered "every directory I can find" would
    // still answer `[]` here, and this case would pass with the check deleted.
    const member = { "libs/beta/package.json": JSON.stringify({ name: "beta" }) };
    withRoot({ ...member, "package.json": JSON.stringify({ name: "plain" }) }, (root) =>
      expect(discoverWorkspaces(root)).toEqual([]),
    );
    withRoot({ ...member, "package.json": JSON.stringify({ workspaces: [] }) }, (root) =>
      expect(discoverWorkspaces(root)).toEqual([]),
    );
  });

  it("sorts by code unit, not by walk order and not by locale", () => {
    // Both halves of this are constructed, because both mutations otherwise
    // survive.
    //
    // Walk order: the walk emits a package before descending into it, so `a`
    // and `a/c` are adjacent in its output no matter what order the filesystem
    // hands back -- and `a-b` sorts BETWEEN them (`-` is 0x2D, `/` is 0x2F).
    // No readdir permutation can produce the sorted answer by accident, so
    // deleting the sort fails here on every filesystem rather than on whichever
    // one returns entries unordered.
    //
    // Locale: `Tools` is capitalized, so `localeCompare` under `en-US` folds
    // the case and moves it to the end while code-unit order keeps it first.
    // That is the exact failure AGENTS.md §1 describes, and CI's locale matrix
    // is what would otherwise have to catch it.
    withRoot(
      {
        "Tools/package.json": JSON.stringify({ name: "tools" }),
        "a/package.json": JSON.stringify({ name: "a" }),
        "a/c/package.json": JSON.stringify({ name: "c" }),
        "a-b/package.json": JSON.stringify({ name: "a-b" }),
        "libs/package.json": JSON.stringify({ name: "libs" }),
        "package.json": JSON.stringify({ workspaces: ["*", "a/*"] }),
      },
      (root) =>
        expect(discoverWorkspaces(root).map((w) => w.dir)).toEqual([
          "Tools",
          "a",
          "a-b",
          "a/c",
          "libs",
        ]),
    );
  });

  it("lets the globs decide whether a package nested inside a workspace is one", () => {
    // Real monorepos nest packages, and the manifest is the only thing that
    // knows whether the inner one is a member or an implementation detail of
    // the outer one. So the walk keeps descending through a match and the
    // globs arbitrate: `tools/*` reaches one level and `tools/**` reaches
    // both. Stopping the walk at the first match would make `tools/**` mean
    // `tools/*`, silently, and no glob could ever name the inner package.
    const files = {
      "tools/alpha/package.json": JSON.stringify({ name: "alpha" }),
      "tools/alpha/sub/package.json": JSON.stringify({ name: "sub" }),
    };
    withRoot({ ...files, "package.json": JSON.stringify({ workspaces: ["tools/*"] }) }, (root) =>
      expect(discoverWorkspaces(root).map((w) => w.dir)).toEqual(["tools/alpha"]),
    );
    withRoot({ ...files, "package.json": JSON.stringify({ workspaces: ["tools/**"] }) }, (root) =>
      expect(discoverWorkspaces(root).map((w) => w.dir)).toEqual([
        "tools/alpha",
        "tools/alpha/sub",
      ]),
    );
  });

  it("stops the package walk at MAX_WALK_DEPTH", () => {
    // A `**` glob puts no bound on how deep the walk goes, so the walk carries
    // its own. Both sides are pinned: a bound nothing reaches is a constant
    // pretending to be a guard, and a bound one level tighter would silently
    // drop a legitimate workspace. Eight is past any real layout -- the
    // deepest fixture here sits at four.
    const deep = (n: number) =>
      Array.from({ length: n }, (_, i) => `d${i + 1}`).join("/") + "/package.json";
    withRoot(
      {
        [deep(8)]: JSON.stringify({ name: "at-the-bound" }),
        [deep(9)]: JSON.stringify({ name: "past-the-bound" }),
        "package.json": JSON.stringify({ workspaces: ["**"] }),
      },
      (root) => {
        const dirs = discoverWorkspaces(root).map((w) => w.dir);
        expect(dirs).toEqual(["d1/d2/d3/d4/d5/d6/d7/d8"]);
      },
    );
  });

  it("omits the name when the package.json has none", () => {
    // A nameless package is still a workspace: `name` is what `--filter` will
    // match on, and having none means no filter can name it, not that its
    // source stops existing.
    withRoot(
      {
        "libs/nameless/package.json": JSON.stringify({ version: "0.0.0" }),
        "package.json": JSON.stringify({ workspaces: ["libs/*"] }),
      },
      // `toStrictEqual`, so that a `name: undefined` key fails here: `toEqual`
      // treats an explicit undefined property as absent, which is what makes
      // the ternary that omits it look untested.
      (root) => expect(discoverWorkspaces(root)).toStrictEqual([{ dir: "libs/nameless" }]),
    );
  });

  it("reads manifests written with a byte order mark", () => {
    // `JSON.parse` throws on a leading U+FEFF, and every read here degrades to
    // "not a workspace" rather than throwing -- so a BOM makes a monorepo
    // authored on Windows look like a plain single project, and a BOM on a
    // member makes that workspace nameless. Both are silent. This is the same
    // blind spot the CRLF bug came from: the fixtures are all LF, so nothing
    // else in this file would notice.
    withRoot(
      {
        "libs/beta/package.json": "\uFEFF" + JSON.stringify({ name: "beta" }),
        "package.json": "\uFEFF" + JSON.stringify({ workspaces: ["libs/*"] }),
      },
      (root) => expect(discoverWorkspaces(root)).toEqual([{ dir: "libs/beta", name: "beta" }]),
    );
  });

  // Not a guard on the call site -- on POSIX `path === path.posix`, so no test
  // here can catch the `posix.` being deleted. This pins the REASON it is
  // written: the two implementations disagree, so which one runs must not be a
  // property of the host. If node ever unifies them this fails, and the
  // explicitness above becomes deletable rather than silently pointless.
  it("win32 and posix matchesGlob disagree on a backslash in a directory name", () => {
    expect(win32.matchesGlob("tools\\alpha", "tools/*")).toBe(true);
    expect(posix.matchesGlob("tools\\alpha", "tools/*")).toBe(false);
  });

  // A backslash is a legal character in a POSIX directory name and an
  // impossible one on Windows, which is why this case can only run here.
  it.skipIf(process.platform === "win32")(
    "treats a backslash in a directory name as part of the name",
    () => {
      // These strings are built from readdir names joined with `/`, so they
      // are already POSIX and must not be "normalized" a second time: the
      // `toPosix` idiom used elsewhere in this codebase -- a blanket
      // `split("\\").join("/")` -- turns this one directory into a
      // two-segment path that its own glob no longer matches, and the
      // workspace disappears. This is what the walk's join is guarded on; the
      // matcher's own backslash behaviour is pinned separately above.
      withRoot(
        {
          "weird\\name/package.json": JSON.stringify({ name: "weird" }),
          "package.json": JSON.stringify({ workspaces: ["*"] }),
        },
        (root) => expect(discoverWorkspaces(root)).toEqual([{ dir: "weird\\name", name: "weird" }]),
      );
    },
  );
});
