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
    const chosen = await configsFor(workspacesRoot(), [
      { dir: "deep/a/b/gamma", name: "@fix/gamma" },
      { dir: "libs/beta", name: "beta" },
      { dir: "tools/alpha", name: "@fix/alpha" },
      { dir: "tools/cfgonly", name: "@fix/cfgonly" },
    ]);
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

  it("uses two probes for the whole repository, not one per workspace", async () => {
    await configsFor(workspacesRoot(), [
      { dir: "deep/a/b/gamma" },
      { dir: "libs/beta" },
      { dir: "tools/alpha" },
      { dir: "tools/cfgonly" },
    ]);
    // One over every primary config, one over the candidate siblings that
    // survived the gap check. Five workspaces including the root.
    expect(probeCalls()).toBe(2);
  });

  it("probes once when no workspace has a gap a sibling could close", async () => {
    // `libs/beta` and the root cover everything they own, so there is nothing
    // for a second probe to answer. The second probe is conditional, not
    // unconditional -- a fixed pair pays for a `tsgo` spawn nobody asked for
    // on the common case, where every workspace has exactly one config.
    await configsFor(workspacesRoot(), [{ dir: "libs/beta", name: "beta" }]);
    expect(probeCalls()).toBe(1);
  });

  it("contributes no config for a workspace that has none", async () => {
    // A workspace can exist to publish shared compiler settings and own no
    // source: `tools/cfgonly` has `base.json` and a `.d.ts` and nothing else.
    // It must contribute nothing rather than throw or invent a config.
    const chosen = await configsFor(workspacesRoot(), [
      { dir: "tools/cfgonly", name: "@fix/cfgonly" },
    ]);
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
    const chosen = await configsFor(solutionWorkspacesRoot(), [
      { dir: "tools/alpha", name: "@sol/alpha" },
    ]);
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
    const chosen = await configsFor(solutionWorkspacesRoot(), [{ dir: "tools/alpha" }]);
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
    const chosen = await configsFor(nestedWorkspacesRoot(), NESTED_WORKSPACES);
    expect(chosen).toEqual([
      // First, and only under code-unit order: `Z` < `a`, while `localeCompare`
      // folds case and puts `tools/alpha` ahead of it. This is the one datum
      // here that tells the two comparators apart (AGENTS.md §1).
      "tools/Zed/tsconfig.json",
      // `sub/scripts/gen.ts` is `tools/alpha/sub`'s gap and this is the config
      // that covers it.
      "tools/alpha/sub/tsconfig.extra.json",
      "tools/alpha/sub/tsconfig.json",
      "tools/alpha/tsconfig.json",
    ]);
    // Blame the parent for its child's uncovered file and the parent goes
    // looking for a sibling of its own -- and finds one whose `include`
    // reaches into `sub/`.
    expect(chosen).not.toContain("tools/alpha/tsconfig.build.json");
  });

  it("never probes a sibling of a workspace that is missing nothing", async () => {
    // `tools/alpha` has a sibling whose `include` reaches into `sub/`, and no
    // gap of its own. Probing it anyway would be a whole extra program load
    // to ask a question whose answer cannot change the result -- and the
    // second probe's input is the only place that decision is visible, since
    // the sibling is rejected by the keep-check either way.
    await configsFor(nestedWorkspacesRoot(), NESTED_WORKSPACES);
    expect(probeCalls()).toBe(2);
    const second = vi.mocked(sourceFileNames).mock.calls[1]![0];
    expect([...second].map((c) => relative(nestedWorkspacesRoot(), c))).toEqual([
      // Every primary, sorted, then the candidates -- and `tools/alpha`'s
      // sibling is not among them.
      join("tools", "Zed", "tsconfig.json"),
      join("tools", "alpha", "sub", "tsconfig.json"),
      join("tools", "alpha", "tsconfig.json"),
      join("tools", "alpha", "sub", "tsconfig.extra.json"),
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

    const chosen = await configsFor(nestedWorkspacesRoot(), selected);
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

    const chosen = await configsFor(filterWorkspacesRoot(), selected, {}, all);
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

    const chosen = await configsFor(filterWorkspacesRoot(), selected, {}, withoutBeta);
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
    const chosen = await configsFor(filterWorkspacesRoot(), all, {}, all);
    expect(chosen).toEqual([
      "pkg/alpha/tsconfig.json",
      "pkg/beta/tsconfig.extra.json",
      "pkg/beta/tsconfig.json",
      "tsconfig.json",
    ]);
  });

  it("attributes to the selected workspaces alone when told nothing more", async () => {
    // The documented default: `discovered` defaults to `workspaces`, so an
    // unfiltered caller -- where the two lists are equal anyway -- needs to
    // know nothing about it. Pinned because the default is what every caller
    // that does not filter will use, and because omitting it on a FILTERED
    // run is the behaviour the parameter exists to replace: beta's files fall
    // through to the root, and the repo-spanning sibling is adopted.
    const all = discoverWorkspaces(filterWorkspacesRoot());
    expect(await configsFor(filterWorkspacesRoot(), all)).toEqual(
      await configsFor(filterWorkspacesRoot(), all, {}, all),
    );
    const filtered = selectWorkspaces(all, ["@filt/alpha"]);
    expect(await configsFor(filterWorkspacesRoot(), filtered)).toContain("tsconfig.all.json");
  });

  it("refuses a probe root above the repository root", async () => {
    // A repo-relative path cannot express a file outside the repo, so a probe
    // whose root sits above the repository root has nothing to rebase
    // against. It happens when a config `references` one outside the tree:
    // `expandReferences` opens it, and the common ancestor moves up.
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
      await mkdir(join(dir, "repo/pkg"), { recursive: true });
      await mkdir(join(dir, "outside/src"), { recursive: true });
      await writeFile(join(dir, "repo/package.json"), JSON.stringify({ name: "escape-root" }));
      // A solution config owns no files, which is the only shape
      // `expandReferences` follows.
      await writeFile(
        join(dir, "repo/pkg/tsconfig.json"),
        JSON.stringify({ files: [], references: [{ path: "../../outside" }] }),
      );
      await writeFile(
        join(dir, "outside/tsconfig.json"),
        JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }),
      );
      await writeFile(join(dir, "outside/src/x.ts"), "export const x = 1;\n");

      await expect(configsFor(join(dir, "repo"), [{ dir: "pkg" }])).rejects.toThrow(
        /outside|above/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
