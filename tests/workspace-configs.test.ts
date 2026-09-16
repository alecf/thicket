import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compareStrings } from "../src/order.js";
import { openProject, sourceFileNames } from "../src/extract/ts-adapter.js";
import { configsFor, discoverWorkspaces, selectWorkspaces } from "../src/extract/workspaces.js";
import {
  filterWorkspacesRoot,
  nestedWorkspacesRoot,
  solutionWorkspacesRoot,
  workspacesRoot,
} from "./helpers.js";

// The probe is counted, not stubbed: every call runs the real thing. One probe
// per workspace is what this design exists to avoid -- see `sourceFileNames`
// for why a probe is not the per-workspace saving it looks like -- and the
// count is invisible in the answer, since a per-workspace implementation
// returns exactly the same list, slowly.
vi.mock("../src/extract/ts-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/extract/ts-adapter.js")>();
  return { ...actual, sourceFileNames: vi.fn(actual.sourceFileNames) };
});

/** Every workspace in the main fixture, as discovery reports them. */
const FIXTURE_WORKSPACES = [
  { dir: "deep/a/b/gamma", name: "@fix/gamma" },
  { dir: "libs/beta", name: "beta" },
  { dir: "tools/alpha", name: "@fix/alpha" },
  { dir: "tools/cfgonly", name: "@fix/cfgonly" },
];

/** Every workspace in the nested fixture, as discovery would report them. */
const NESTED_WORKSPACES = [
  { dir: "tools/Zed", name: "@nest/zed" },
  { dir: "tools/alpha", name: "@nest/alpha" },
  { dir: "tools/alpha/sub", name: "@nest/sub" },
];

const probeCalls = () => vi.mocked(sourceFileNames).mock.calls.length;

beforeEach(() => {
  vi.mocked(sourceFileNames).mockClear();
});

describe("configsFor", () => {
  it("adds a sibling tsconfig only when it contributes files", async () => {
    const { configs: chosen } = await configsFor(workspacesRoot(), {
      selected: FIXTURE_WORKSPACES,
      discovered: FIXTURE_WORKSPACES,
    });
    expect(chosen).toEqual([
      "deep/a/b/gamma/tsconfig.json",
      "libs/beta/tsconfig.json",
      "tools/alpha/tsconfig.json",
      // Adds `src/a.test.ts`, which the main config excludes.
      "tools/alpha/tsconfig.test.json",
      // The root is a workspace too: its config owns `scripts/`, which lives
      // in no workspace and would otherwise be analyzed by nothing.
      "tsconfig.json",
    ]);
    // Two absences carry the rule, and they fail in opposite directions.
    // `tools/alpha/tsconfig.build.json` names a PROPER subset of its main
    // config, so keeping every sibling beside a workspace that has a gap
    // would pull it in. `libs/beta` has no sibling at all, so a rule that
    // added siblings blindly would still leave it alone -- which is why the
    // first absence is the one under test.
    expect(chosen).not.toContain("tools/alpha/tsconfig.build.json");
  });

  /**
   * The declined candidates are reported, not discarded. Only the probe knows
   * this config covers none of `tools/alpha`'s missing file, and the coverage
   * section has no program to find it out with -- so without this list it
   * offers the reader a `--config` already proven to leave the gap where it
   * is.
   *
   * A config that was never a candidate must not appear here: `libs/beta` has
   * no sibling, and the root's config is a primary rather than something that
   * had to earn its place.
   */
  it("reports the candidate siblings it opened and declined", async () => {
    const { rejected } = await configsFor(workspacesRoot(), {
      selected: FIXTURE_WORKSPACES,
      discovered: FIXTURE_WORKSPACES,
    });
    expect(rejected).toEqual(["tools/alpha/tsconfig.build.json"]);
  });

  it("uses two probes for the whole repository, not one per workspace", async () => {
    await configsFor(workspacesRoot(), {
      selected: FIXTURE_WORKSPACES,
      discovered: FIXTURE_WORKSPACES,
    });
    // One over every primary config, one over the candidate siblings that
    // survived the gap check. Five workspaces including the root.
    expect(probeCalls()).toBe(2);
  });

  it("probes once when a sibling exists but no scope has a gap it could close", async () => {
    // The filter fixture's root carries `tsconfig.all.json` beside its own
    // config, so the FIRST probe is earned -- something here could be adopted.
    // Nothing is missing once it runs, so the second has no question to answer.
    // Conditional, not a fixed pair: a second probe is a `tsgo` spawn and a
    // whole program load.
    //
    // The selection matters. Pick a scope set with no sibling anywhere and this
    // passes at ZERO probes, testing the guard below instead of the property
    // named here -- which is what the previous version of this test did the
    // moment that guard landed.
    const all = discoverWorkspaces(filterWorkspacesRoot());
    await configsFor(filterWorkspacesRoot(), {
      selected: [{ dir: "pkg/alpha", name: "@filt/alpha" }],
      discovered: all,
    });
    expect(probeCalls()).toBe(1);
  });

  it("does not probe at all when no scope offers a sibling", async () => {
    // The probe exists to answer one question: does a sibling config close a
    // gap? `candidates` is built from `siblings` alone, so where no scope has
    // one the answer cannot change the result, and the whole probe -- a tsgo
    // spawn and a full program load -- is spent to learn nothing.
    //
    // This is the common shape rather than a corner: on a sample monorepo all
    // eighteen scopes held exactly one `tsconfig.json`, and the wasted probe
    // was 3.1s of a 13s run. The root and `libs/beta` are that shape here.
    await configsFor(workspacesRoot(), {
      selected: [{ dir: "libs/beta", name: "beta" }],
      discovered: FIXTURE_WORKSPACES,
    });
    expect(probeCalls()).toBe(0);
  });

  it("contributes no config for a workspace that has none", async () => {
    // A workspace can exist to publish shared compiler settings and own no
    // source: `tools/cfgonly` has `base.json` and a `.d.ts` and nothing else.
    // It must contribute nothing rather than throw or invent a config.
    const { configs: chosen } = await configsFor(workspacesRoot(), {
      selected: [{ dir: "tools/cfgonly", name: "@fix/cfgonly" }],
      discovered: FIXTURE_WORKSPACES,
    });
    // The exact list, so `base.json` sitting exactly where configs are looked
    // for fails here: the pattern is `tsconfig*.json`, never `*.json`, and a
    // `base.json` opened as a project analyzes a file set nobody asked for.
    expect(chosen).toEqual(["tsconfig.json"]);
  });

  it("scopes the root's own coverage check to files in no workspace", async () => {
    // The root config here is `{"files": [], "references": [...]}` -- it owns
    // zero files. Measure its coverage against the whole tree and every
    // workspace's files read as the ROOT's gap, and `tsconfig.build.json`,
    // whose `include` reaches into `tools/**`, looks like the config that
    // closes it.
    const { configs: chosen } = await configsFor(solutionWorkspacesRoot(), {
      selected: [{ dir: "tools/alpha", name: "@sol/alpha" }],
      discovered: [{ dir: "tools/alpha", name: "@sol/alpha" }],
    });
    expect(chosen).toEqual(["tools/alpha/tsconfig.json", "tsconfig.json"]);
    // Named separately because the two mis-scopes this fixture catches both
    // end here: `tools/alpha/scripts/build.ts` is alpha's gap, and alpha has
    // no sibling, so the honest answer is a permanent gap rather than a root
    // config that happens to cover it.
    expect(chosen).not.toContain("tsconfig.build.json");
  });

  it("analyzes each file once when the root references a workspace", async () => {
    // AGENTS.md §3: a file in N tsconfig projects is visited N times, which
    // surfaces as phantom identical clones. Asserted on the FILE set, because
    // a duplicate CONFIG path is impossible by construction here -- each
    // directory emits configs from its own directory, and the directories are
    // distinct. The hazard lives one layer lower, where the adapter expands
    // the root's `references: [{path: "tools/alpha"}]` and meets
    // `tools/alpha/tsconfig.json`, already on the list.
    const { configs: chosen } = await configsFor(solutionWorkspacesRoot(), {
      selected: [{ dir: "tools/alpha" }],
      discovered: [{ dir: "tools/alpha" }],
    });
    const project = await openProject(chosen.map((c) => resolve(solutionWorkspacesRoot(), c)));
    try {
      const paths = project.files().map((f) => f.path);
      expect(paths).toEqual(["tools/alpha/src/a.ts"]);
      expect(paths).toEqual([...new Set(paths)].sort(compareStrings));
    } finally {
      await project.close();
    }
  });

  it("gives a gapped file to the deepest workspace that contains it", async () => {
    const { configs: chosen } = await configsFor(nestedWorkspacesRoot(), {
      selected: NESTED_WORKSPACES,
      discovered: NESTED_WORKSPACES,
    });
    expect(chosen).toEqual([
      // First, and only under code-unit order: `Z` < `a`, while `localeCompare`
      // folds case and puts `tools/alpha` ahead of it. This is the one datum
      // here that tells the two comparators apart (AGENTS.md §1).
      "tools/Zed/tsconfig.json",
      // `sub/scripts/gen.ts` is `tools/alpha/sub`'s gap, and THIS is the
      // config that closes it -- not the parent's `tsconfig.build.json`,
      // which covers that file too. Blame the parent for its child's
      // uncovered file and this entry is what disappears.
      "tools/alpha/sub/tsconfig.extra.json",
      "tools/alpha/sub/tsconfig.json",
      // Chosen for `sub-x/gen.ts`, which is the parent's own -- see the
      // trailing-separator test below.
      "tools/alpha/tsconfig.build.json",
      "tools/alpha/tsconfig.json",
    ]);
  });

  it("does not let a workspace's name prefix-match a plain sibling directory", async () => {
    // `tools/alpha/sub-x` is a plain directory, and its name starts with the
    // workspace directory `tools/alpha/sub`. Test containment with
    // `startsWith(dir)` and `sub-x/gen.ts` is handed to `tools/alpha/sub`,
    // whose gap it is not: `tools/alpha` is then missing nothing, its sibling
    // is never offered, and the file is analyzed by nothing at all.
    //
    // The `dir.length > best.length` tiebreak hides the obvious version of
    // this -- `tools/alpha` beside `tools/alpha2` is safe because the longer
    // scope wins anyway -- so it takes a NESTED workspace beside a plain
    // directory to reach. `lib` beside `lib-legacy` inside a parent workspace
    // is the same shape.
    const { configs: chosen } = await configsFor(nestedWorkspacesRoot(), {
      selected: NESTED_WORKSPACES,
      discovered: NESTED_WORKSPACES,
    });
    expect(chosen).toContain("tools/alpha/tsconfig.build.json");

    // And the file reaches the program, which is the claim that matters. The
    // path is `alpha/sub-x/gen.ts` rather than `tools/alpha/...` for the same
    // reason this fixture exists: with no root tsconfig, `openProject` roots
    // at the common ancestor of the configs it was handed, which is `tools`.
    const project = await openProject(chosen.map((c) => resolve(nestedWorkspacesRoot(), c)));
    try {
      expect(project.files().map((f) => f.path)).toContain("alpha/sub-x/gen.ts");
    } finally {
      await project.close();
    }
  });

  it("never probes a sibling of a scope that is missing nothing", async () => {
    // The root of the filter fixture owns `scripts/` and covers it, so it is
    // missing nothing -- while carrying `tsconfig.all.json`, a sibling that
    // would cover half the repository. Probing it anyway is a whole extra
    // program load to ask a question whose answer cannot change the result,
    // and the second probe's INPUT is the only place that decision shows:
    // the config is refused by the keep-check either way.
    const all = discoverWorkspaces(filterWorkspacesRoot());
    await configsFor(filterWorkspacesRoot(), { selected: all, discovered: all });
    expect(probeCalls()).toBe(2);
    const second = vi.mocked(sourceFileNames).mock.calls[1]![0];
    expect([...second].map((c) => relative(filterWorkspacesRoot(), c))).toEqual([
      // Every primary, sorted, then the candidates -- and the root's sibling
      // is not among them.
      join("pkg", "alpha", "tsconfig.json"),
      join("pkg", "beta", "tsconfig.json"),
      "tsconfig.json",
      join("pkg", "beta", "tsconfig.extra.json"),
    ]);
  });

  it("measures probe names from the probe's own root, not the repo's", async () => {
    // The premise, pinned rather than assumed: this fixture has no root
    // tsconfig, so the common ancestor of its primaries is `tools` and every
    // name the probe returns is measured from THERE, one segment below the
    // repo root. Add a root config to this fixture and every rebasing
    // assertion below starts passing for a reason that has nothing to do with
    // rebasing.
    const probed = await sourceFileNames(
      NESTED_WORKSPACES.map((w) => resolve(nestedWorkspacesRoot(), w.dir, "tsconfig.json")),
    );
    expect(probed.root).toBe(resolve(nestedWorkspacesRoot(), "tools"));
    expect(probed.names).toEqual(["Zed/src/z.ts", "alpha/src/a.ts", "alpha/sub/src/s.ts"]);
  });

  it("rebases probe names when --filter narrows the run to one workspace", async () => {
    // The shape finding (c) names: with one workspace selected and no root
    // config, the probe's root collapses into that workspace. Diff those
    // names against a repo-relative scan without rebasing and NOTHING
    // overlaps -- the entire repository reads as a gap, and every sibling is
    // then rejected because its names match nothing either.
    //
    // Routed through discovery and `--filter` rather than a hand-written
    // list, because that is the only way a caller reaches this: the root is
    // always a workspace, so its config alone would hold the probe root at
    // the repo root.
    const all = discoverWorkspaces(nestedWorkspacesRoot());
    const selected = selectWorkspaces(all, ["@nest/sub"]);
    expect(selected).toEqual([{ dir: "tools/alpha/sub", name: "@nest/sub" }]);

    const { configs: chosen } = await configsFor(nestedWorkspacesRoot(), { selected, discovered: all });
    expect(chosen).toEqual([
      "tools/alpha/sub/tsconfig.extra.json",
      "tools/alpha/sub/tsconfig.json",
    ]);
  });

  it("leaves an unselected workspace's files to that workspace", async () => {
    // The root sibling here spans the repository, so the only thing keeping a
    // filtered run inside its filter is WHO `pkg/beta`'s files are attributed
    // to. Blame the root and `tsconfig.all.json` closes that gap; blame beta,
    // which is not in this run, and nobody goes looking for a config at all.
    const all = discoverWorkspaces(filterWorkspacesRoot());
    const selected = selectWorkspaces(all, ["@filt/alpha"]);
    expect(selected).toEqual([{ dir: "pkg/alpha", name: "@filt/alpha" }]);

    const { configs: chosen } = await configsFor(filterWorkspacesRoot(), { selected, discovered: all });
    expect(chosen).toEqual(["pkg/alpha/tsconfig.json", "tsconfig.json"]);
    // Both halves of "attribution only", and they fail to different
    // mutations: the root must not adopt a repo-spanning sibling to cover
    // beta, and beta must contribute neither its primary nor its own sibling
    // just for being known about.
    expect(chosen).not.toContain("tsconfig.all.json");
    expect(chosen).not.toContain("pkg/beta/tsconfig.json");
    expect(chosen).not.toContain("pkg/beta/tsconfig.extra.json");

    // And the consequence, asserted where it actually bites: the analyzed
    // file set. A config list that merely looks right is not the claim --
    // beta's source must not reach the graph the report is computed over.
    const project = await openProject(chosen.map((c) => resolve(filterWorkspacesRoot(), c)));
    try {
      expect(project.files().map((f) => f.path)).toEqual([
        "pkg/alpha/src/a.ts",
        "scripts/root.ts",
      ]);
    } finally {
      await project.close();
    }
  });

  it("attributes a selected workspace's files to it even if the list omits it", async () => {
    // `discovered` is meant to be a superset of `workspaces`, and a call site
    // that filters its list in place hands over one that is not. The two
    // lists are unioned rather than trusted, because the failure is silent
    // and identical to the one this parameter was added to fix: the selected
    // workspace's own files fall through to the root, and the repo-spanning
    // root sibling is adopted to cover them.
    // `pkg/beta` is the workspace to select here, and deliberately: it is the
    // one with a gap of its own. A workspace whose primary covers everything
    // it owns cannot show this at all -- misattributing a file that is
    // already covered changes nothing, because only GAPPED files are ever
    // looked up.
    const all = discoverWorkspaces(filterWorkspacesRoot());
    const selected = selectWorkspaces(all, ["@filt/beta"]);
    const withoutBeta = all.filter((w) => w.dir !== "pkg/beta");
    expect(withoutBeta.map((w) => w.dir)).toEqual(["pkg/alpha"]);

    const { configs: chosen } = await configsFor(filterWorkspacesRoot(), {
      selected,
      discovered: withoutBeta,
    });
    expect(chosen).toEqual([
      // Beta's gap stays beta's: its own sibling closes it...
      "pkg/beta/tsconfig.extra.json",
      "pkg/beta/tsconfig.json",
      "tsconfig.json",
    ]);
    // ...and the root's repo-spanning sibling, which also covers that file,
    // is never reached for it.
    expect(chosen).not.toContain("tsconfig.all.json");
  });

  it("still adopts that workspace's sibling once it is selected", async () => {
    // The other direction, and the reason the test above cannot stand alone:
    // `pkg/beta/scripts/gen.ts` is uncovered in both runs, so a fix that
    // simply stopped adopting siblings would pass it. Here beta IS selected,
    // its gap is its own, and its sibling is the config that closes it --
    // while the root's repo-spanning sibling stays out, because the root's
    // own gap is empty either way.
    const all = discoverWorkspaces(filterWorkspacesRoot());
    const { configs: chosen } = await configsFor(filterWorkspacesRoot(), { selected: all, discovered: all });
    expect(chosen).toEqual([
      "pkg/alpha/tsconfig.json",
      "pkg/beta/tsconfig.extra.json",
      "pkg/beta/tsconfig.json",
      "tsconfig.json",
    ]);
  });

  it("loads the first config by code unit when a workspace has no tsconfig.json", async () => {
    // `tsconfig.json` is a convention, and a workspace holding only
    // `tsconfig-base.json` and `tsconfig.app.json` has to pick one to LOAD.
    // The rule is "first in `compareStrings` order", so it is the listing
    // order -- pinned in `tests/scope.test.ts` -- that decides, and nothing
    // pinned the other half: taking the LAST of the list instead left every
    // test green while changing which program gets built.
    //
    // Both configs name the same single file, so whichever loses is left out
    // for adding nothing rather than for being second: the workspace ends up
    // with exactly one config, and which one is the whole answer.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "thicket-primary-")));
    try {
      const config = JSON.stringify({
        compilerOptions: { target: "es2022", module: "nodenext", strict: true, noEmit: true },
        include: ["src/**/*.ts"],
      });
      await mkdir(join(dir, "pkg/a/src"), { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "primary-root" }));
      await writeFile(join(dir, "pkg/a/tsconfig-base.json"), config);
      await writeFile(join(dir, "pkg/a/tsconfig.app.json"), config);
      await writeFile(join(dir, "pkg/a/src/a.ts"), "export const a = 1;\n");

      const pkg = [{ dir: "pkg/a" }];
      const { configs } = await configsFor(dir, { selected: pkg, discovered: pkg });
      expect(configs).toEqual(["pkg/a/tsconfig-base.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adopts no sibling when a project reference escapes the analyzed root", async () => {
    // A probe measures from the common ancestor of the configs it OPENED, so a
    // reference reaching outside the tree puts that ancestor above the repo
    // root and there is no prefix to rebase by. The gap is then unanswerable
    // rather than empty: rebased names would carry `../` and match nothing on
    // either side of the coverage figure, so every workspace would read as
    // uncovered and every sibling in the repo would become a candidate.
    //
    // So the answer is the conservative one -- adopt nothing, keep the
    // primaries -- which errs toward an honest coverage gap rather than toward
    // a widened analysis, the same direction a declined candidate errs in.
    // `openProject` then moves the root up and `run.ts` says so; a run of this
    // shape reports, and names the root its paths are measured from.
    //
    // `pkg` carries a sibling so the probe actually runs: with one config it
    // would return before probing and this would pass without exercising the
    // escape at all.
    //
    // Written to a temp directory because no committed fixture can hold it --
    // it needs a config OUTSIDE the root being analyzed, and the repository
    // is the outside.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "thicket-escape-")));
    try {
      const compilerOptions = {
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
      };
      await mkdir(join(dir, "repo/pkg/src"), { recursive: true });
      await mkdir(join(dir, "outside/src"), { recursive: true });
      await writeFile(join(dir, "repo/package.json"), JSON.stringify({ name: "escape-root" }));
      // A solution config owns no files, which is the only shape
      // `expandReferences` follows.
      await writeFile(
        join(dir, "repo/pkg/tsconfig.json"),
        JSON.stringify({ files: [], references: [{ path: "../../outside" }] }),
      );
      await writeFile(
        join(dir, "repo/pkg/tsconfig.extra.json"),
        JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }),
      );
      await writeFile(join(dir, "repo/pkg/src/a.ts"), "export const a = 1;\n");
      await writeFile(
        join(dir, "outside/tsconfig.json"),
        JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }),
      );
      await writeFile(join(dir, "outside/src/x.ts"), "export const x = 1;\n");

      const pkg = [{ dir: "pkg" }];
      const { configs, rejected } = await configsFor(join(dir, "repo"), {
        selected: pkg,
        discovered: pkg,
      });
      expect(configs).toEqual(["pkg/tsconfig.json"]);
      expect(rejected).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
