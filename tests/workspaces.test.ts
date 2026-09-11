import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverWorkspaces,
  selectWorkspaces,
  type Workspace,
} from "../src/extract/workspaces.js";
import { withRoot, workspacesRoot } from "./helpers.js";

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

  it("finds a workspace deeper than any fixed depth bound", () => {
    // There was a `MAX_WALK_DEPTH = 8` here and it was a bug with a test. A
    // workspace at twelve segments was silently never discovered, while
    // `scanSourceFiles` -- which has no depth limit -- still counted every one
    // of its files, so they surfaced as an unexplained hole in the coverage
    // denominator that no flag could close. Nothing needed bounding: the walk
    // enumerates the filesystem rather than expanding globs, so `**` cannot
    // deepen it, and `readdirSync` reports a symlink as not-a-directory, so it
    // cannot enter a cycle.
    const deep = (n: number) =>
      Array.from({ length: n }, (_, i) => `d${i + 1}`).join("/") + "/package.json";
    withRoot(
      {
        [deep(12)]: JSON.stringify({ name: "deep" }),
        "package.json": JSON.stringify({ workspaces: ["**"] }),
      },
      (root) =>
        expect(discoverWorkspaces(root)).toEqual([
          { dir: "d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12", name: "deep" },
        ]),
    );
  });

  it("discovers a workspace whose glob carries a quoted #", () => {
    // The end-to-end half of the quoted-scalar case, and the reason it is not
    // merely a parser nicety: with the `#` read as a comment the glob becomes
    // `'libs/team`, matches nothing, and this workspace is silently absent
    // from discovery -- no error, just a coverage gap pointing at a directory
    // nobody excluded.
    withRoot(
      {
        "pnpm-workspace.yaml": "packages:\n  - 'libs/team #1/*'\n",
        "libs/team #1/beta/package.json": JSON.stringify({ name: "beta" }),
      },
      (root) =>
        expect(discoverWorkspaces(root)).toEqual([
          { dir: "libs/team #1/beta", name: "beta" },
        ]),
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

/**
 * Three workspaces whose directory order and name order disagree, so a case
 * that means to assert one of them cannot pass on the other by luck.
 */
const WS: Workspace[] = [
  { dir: "libs/beta", name: "beta" },
  { dir: "tools/alpha", name: "@fix/alpha" },
  { dir: "tools/omega", name: "@fix/omega" },
];

describe("selectWorkspaces", () => {
  it("selects by exact name", () => {
    expect(selectWorkspaces(WS, ["beta"]).map((w) => w.dir)).toEqual(["libs/beta"]);
  });

  it("globs on the name, and a scoped name is not read as a path", () => {
    expect(selectWorkspaces(WS, ["@fix/*"]).map((w) => w.dir)).toEqual([
      "tools/alpha",
      "tools/omega",
    ]);
  });

  // THE BUG THIS TEST EXISTS FOR. `matchesGlob` treats `/` as a path
  // separator, so a scoped package name never matches `*`. Measured on a
  // sample monorepo, `--filter=*` silently selected 3 of 10 workspaces and
  // reported a clean-looking result over 30% of the tree; on another, where
  // every name is scoped, it errored instead. A partial selection that does
  // not announce itself is the worse of the two. Name patterns are matched as
  // STRINGS, where `/` is an ordinary character.
  it("selects every workspace for `*`, scoped names included", () => {
    expect(selectWorkspaces(WS, ["*"]).map((w) => w.dir)).toEqual([
      "libs/beta",
      "tools/alpha",
      "tools/omega",
    ]);
  });

  it("treats a ./-prefixed pattern as a path glob", () => {
    expect(selectWorkspaces(WS, ["./tools/*"]).map((w) => w.dir)).toEqual([
      "tools/alpha",
      "tools/omega",
    ]);
  });

  // A path pattern is matched as a PATH -- `/` is a separator -- while a name
  // pattern is matched as a string. `deep/a/b/gamma` is what tells the two
  // apart: `./deep/*` must not reach it and `./deep/**` must.
  it("does not let a single-star path pattern cross a separator", () => {
    const deep: Workspace[] = [{ dir: "deep/a/b/gamma", name: "@fix/gamma" }];
    expect(() => selectWorkspaces(deep, ["./deep/*"])).toThrow(/matched no workspace/);
    expect(selectWorkspaces(deep, ["./deep/**"]).map((w) => w.dir)).toEqual(["deep/a/b/gamma"]);
  });

  // A leading negation starts from everything; otherwise selection starts empty.
  it("starts from all when the first filter is a negation", () => {
    expect(selectWorkspaces(WS, ["!beta"]).map((w) => w.dir)).toEqual([
      "tools/alpha",
      "tools/omega",
    ]);
  });

  it("applies filters in order", () => {
    expect(selectWorkspaces(WS, ["@fix/*", "!@fix/omega"]).map((w) => w.dir)).toEqual([
      "tools/alpha",
    ]);
  });

  it("selects everything when there are no filters at all", () => {
    expect(selectWorkspaces(WS, []).map((w) => w.dir)).toEqual([
      "libs/beta",
      "tools/alpha",
      "tools/omega",
    ]);
  });

  // Silently empty is the failure mode that wastes an afternoon: the report
  // looks clean because nothing was analyzed.
  it("throws naming what is available when a filter matches nothing", () => {
    expect(() => selectWorkspaces(WS, ["nope"])).toThrow(/nope/);
    expect(() => selectWorkspaces(WS, ["nope"])).toThrow(/beta/);
  });

  // The same rule for an exclusion, which is where it is easier to argue
  // yourself out of: a `!` that matches nothing removes nothing, so a typo in
  // one leaves the workspace it meant to drop in the analyzed set and says so
  // nowhere. The check has to run before the negated/positive split.
  it("throws for a negation that matches nothing", () => {
    expect(() => selectWorkspaces(WS, ["*", "!@fix/nope"])).toThrow(/@fix\/nope/);
  });

  // A workspace whose directory name differs from its package name is normal:
  // a directory `evals` publishing as `@scope/evals` makes `--filter=evals`
  // match nothing. That is turbo's behavior too and we keep it -- but the error
  // has to resolve to the thing, so it lists BOTH addresses of every workspace
  // and the reader can see `./evals` works.
  it("lists both the name and the path of each workspace when it fails", () => {
    expect(() => selectWorkspaces(WS, ["alpha"])).toThrow(/@fix\/alpha/);
    expect(() => selectWorkspaces(WS, ["alpha"])).toThrow(/\.\/tools\/alpha/);
  });

  // The pattern is quoted in the message because the patterns most likely to
  // match nothing are the ones you cannot see: an empty string, or one a shell
  // handed over with whitespace still attached.
  it("quotes the failing pattern so an invisible one is still visible", () => {
    expect(() => selectWorkspaces(WS, ["  "])).toThrow('--filter "  " matched no workspace');
  });

  // A nameless workspace is unreachable BY NAME -- that is `packageName`'s
  // stated contract -- so `*` skips it and the error says so by printing the
  // path form, which does reach it. Both halves are pinned: the first is a
  // silent partial selection if `*` ever starts matching nameless workspaces
  // by treating a missing name as "", and the second is the only thing telling
  // the reader what to type instead.
  it("cannot reach a nameless workspace by name, and says what does", () => {
    const nameless: Workspace[] = [{ dir: "libs/nameless" }];
    expect(() => selectWorkspaces(nameless, ["*"])).toThrow(/\.\/libs\/nameless/);
    // Typed back exactly as the message prints it, so the message is pinned
    // to be an instruction rather than a description: `./*` would NOT work
    // here, because a path pattern's `*` does not cross a separator.
    expect(selectWorkspaces(nameless, ["./libs/nameless"]).map((w) => w.dir)).toEqual([
      "libs/nameless",
    ]);
  });

  // The output is sorted, and this is the only case that can tell the sort
  // from the order the filters happened to insert in: `@fix/*` selects both
  // `tools/` workspaces before `beta` joins from `libs/`, so insertion order
  // and sorted order are different lists. The plain `*` case above cannot
  // catch a deleted sort -- its insertion order is already sorted.
  it("sorts by directory, not by the order filters selected in", () => {
    expect(selectWorkspaces(WS, ["@fix/*", "beta"]).map((w) => w.dir)).toEqual([
      "libs/beta",
      "tools/alpha",
      "tools/omega",
    ]);
  });

  // The no-filter path sorts too, so a caller never has to know which path it
  // took to know what it got. `discoverWorkspaces` already sorts, so this is
  // the only input shape that can assert it.
  it("sorts an unsorted input even with no filters", () => {
    const unsorted: Workspace[] = [{ dir: "tools/alpha" }, { dir: "libs/beta" }];
    expect(selectWorkspaces(unsorted, []).map((w) => w.dir)).toEqual(["libs/beta", "tools/alpha"]);
  });

  // The result is the caller's to keep, and the caller's array is not ours to
  // hand back: `configs` is built by mutating what comes out of here.
  it("returns a fresh array rather than the one it was given", () => {
    const out = selectWorkspaces(WS, []);
    out.pop();
    expect(WS).toHaveLength(3);
  });

  // Selection is keyed on `dir`, not on object identity. Two entries for one
  // directory would be analyzed twice -- the phantom-identical-clone hazard in
  // AGENTS.md -- and identity keying cannot collapse them, because nothing in
  // the signature says the caller may not build its list from two sources.
  it("yields one entry per directory even if the input repeats one", () => {
    const twice: Workspace[] = [
      { dir: "libs/beta", name: "beta" },
      { dir: "libs/beta", name: "beta" },
    ];
    expect(selectWorkspaces(twice, ["beta"]).map((w) => w.dir)).toEqual(["libs/beta"]);
  });

  // A name pattern is matched as a string, so everything but `*` is a literal
  // character. Each pair is a pattern beside the name a REGEX built from it
  // would also have matched -- which is what a metacharacter left unescaped
  // buys you: `--filter 'a.b'` quietly selecting `axb` as well.
  it.each([
    ["a.b", "axb"],
    ["a+b", "aab"],
    ["a|b", "a"],
    ["a(b)", "ab"],
    ["a[b]", "ab"],
    ["a{1}", "a"],
    ["a?b", "b"],
    ["a$", "a"],
    ["a^b", undefined],
    ["a\\b", undefined],
  ])("matches %j literally, never as a regular expression", (pattern, regexTwin) => {
    const ws: Workspace[] = [{ dir: "a/literal", name: pattern }];
    if (regexTwin !== undefined) ws.push({ dir: "b/regex", name: regexTwin });
    expect(selectWorkspaces(ws, [pattern]).map((w) => w.dir)).toEqual(["a/literal"]);
  });

  // The literal segments have to fit between prefix and suffix without reusing
  // a character. `beta*beta` names two occurrences of `beta` and a workspace
  // called `beta` has one; `a*c*c` needs two `c`s after the `a`. Both positive
  // twins are here so the case cannot pass by rejecting everything.
  it("does not let two segments of one pattern match the same characters", () => {
    const ws: Workspace[] = [
      { dir: "libs/beta", name: "beta" },
      { dir: "a/abc", name: "abc" },
    ];
    expect(() => selectWorkspaces(ws, ["beta*beta"])).toThrow(/matched no workspace/);
    expect(() => selectWorkspaces(ws, ["a*c*c"])).toThrow(/matched no workspace/);
    const twins: Workspace[] = [
      { dir: "libs/twice", name: "betaXbeta" },
      { dir: "a/acc", name: "acc" },
    ];
    expect(selectWorkspaces(twins, ["beta*beta"]).map((w) => w.dir)).toEqual(["libs/twice"]);
    expect(selectWorkspaces(twins, ["a*c*c"]).map((w) => w.dir)).toEqual(["a/acc"]);
  });

  // A BOUNDARY PIN, not another example of the case above it. This is the only
  // case where the prefix/suffix guard sits exactly at `at === end`: `@fix/` is
  // five characters and `alpha` is five, so a ten-character name leaves the
  // star an EMPTY run to match -- which `at > end` allows and `at >= end` would
  // refuse. Nothing else here is near that boundary; `beta*beta` against `beta`
  // sits at at=4, end=0, four characters clear of it, so the overlap case
  // cannot be extended to cover this.
  //
  // Why it is worth its own case: the interior guard four lines below compares
  // against the same `end` with the same `>`, and IS pinned at its boundary by
  // `a*c*c` against `acc` (2 > 2). Two sibling comparisons, one protected. The
  // likeliest edit anyone makes here is normalizing them to match, which flips
  // whichever one is unpinned.
  it("lets a star match an empty run between prefix and suffix", () => {
    expect(
      selectWorkspaces([{ dir: "d", name: "@fix/alpha" }], ["@fix/*alpha"]).map((w) => w.dir),
    ).toEqual(["d"]);
    // The twin, so the case cannot pass by matching everything: the prefix is
    // genuinely required, and a name missing it is still refused.
    expect(() => selectWorkspaces([{ dir: "d", name: "@fixalpha" }], ["@fix/*alpha"])).toThrow();
  });

  it("matches a bare * and a ** alike, and an empty pattern only against nothing", () => {
    const ws: Workspace[] = [{ dir: "libs/beta", name: "beta" }];
    expect(selectWorkspaces(ws, ["**"]).map((w) => w.dir)).toEqual(["libs/beta"]);
    expect(() => selectWorkspaces(ws, [""])).toThrow(/matched no workspace/);
  });

  // Not a style preference, and not a hypothetical. `*a*a*...*ab` against a
  // name of 40 `a`s is the textbook catastrophic backtrack, and both obvious
  // implementations take it. At ten stars on that input: the compiled
  // `^.*a.*a...ab$` costs 8.1s under node 24 and 1.2s under bun 1.4, and
  // `posix.matchesGlob` 6.4s under node and nothing at all under bun, which is
  // native. Each roughly triples per further star.
  //
  // Which runtime runs this matters to what the case catches, so: vitest runs
  // on node, where both regressions blow the budget. Moved to a bun runner, the
  // compiled form still does -- 1.2s against 1000ms is the whole reason the
  // budget is not looser -- while a `matchesGlob` regression would slip past
  // here. It would not slip past the file: the scoped-`*` case and the
  // literal-matching cases above fail on it too, and this case is the only one
  // covering the compiled form. Neither guard rests on the other.
  //
  // Ten stars rather than twenty on purpose: twenty makes a regressed
  // implementation run for hours, and a test that hangs the suite reports the
  // regression far worse than one that fails in eight seconds. The correct
  // implementation answers in microseconds, so the budget has four orders of
  // magnitude of room.
  it("answers a pathological star pattern immediately", () => {
    const ws: Workspace[] = [
      { dir: "x", name: "x" },
      { dir: "a/lit", name: "a".repeat(40) },
    ];
    const started = performance.now();
    expect(() => selectWorkspaces(ws, ["*a".repeat(10) + "b"])).toThrow(/matched no workspace/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // The two halves of this file compose or neither is worth anything. The
  // fixture is what makes `*` discriminating: three of its four workspaces are
  // scoped, so a name matched as a path selects `beta` alone.
  it("selects over what discoverWorkspaces actually found", () => {
    const all = discoverWorkspaces(workspacesRoot());
    expect(selectWorkspaces(all, ["*"]).map((w) => w.dir)).toEqual([
      "deep/a/b/gamma",
      "libs/beta",
      "tools/alpha",
      "tools/cfgonly",
    ]);
    expect(selectWorkspaces(all, ["./tools/*", "!@fix/cfgonly"]).map((w) => w.dir)).toEqual([
      "tools/alpha",
    ]);
  });
});
