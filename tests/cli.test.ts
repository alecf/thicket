import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachePathFor } from "../src/cache/db.js";
import { main } from "../src/cli.js";
import {
  emptyConfig,
  filterWorkspacesRoot,
  fixtureConfig,
  fixtureRoot,
  nestedConfig,
  generatedConfig,
  solutionConfig,
  workspacesRoot,
} from "./helpers.js";

/**
 * The CLI's contract with a harness is its exit code, so every case here
 * asserts the code first and the message second. Streams are captured rather
 * than silenced so a regression that stops explaining itself is caught too.
 */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { stdout: () => out.join(""), stderr: () => err.join("") };
}

const temps: string[] = [];

/** A throwaway copy of the sample fixture, so a test may write a cache into it. */
function scratchProject(): { root: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "thicket-cli-"));
  temps.push(root);
  cpSync(fixtureRoot(), root, {
    recursive: true,
    filter: (src) => !src.split(sep).includes(".thicket"),
  });
  return { root, config: join(root, "tsconfig.json") };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

/**
 * A throwaway tree written file by file.
 *
 * Written rather than committed because two of the cases below need a
 * `package.json` that does not parse, and an unparseable manifest checked into
 * `tests/fixtures/` is a trap for every tool that walks this repository.
 */
function scratchTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "thicket-cli-tree-"));
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

/** A root project of two files beside one workspace of one. */
function miniMonorepo(): string {
  return scratchTree({
    "package.json": JSON.stringify({ name: "tree-root", private: true, workspaces: ["pkg/*"] }),
    "tsconfig.json": TSCONFIG,
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    "pkg/one/package.json": JSON.stringify({ name: "one", version: "0.0.0" }),
    "pkg/one/tsconfig.json": TSCONFIG,
    "pkg/one/src/c.ts": "export const c = 3;\n",
  });
}

describe("main", () => {
  it("exits 0 and prints a report for a config with source files", async () => {
    const io = capture();
    expect(await main(["--config", fixtureConfig()])).toBe(0);
    expect(io.stdout()).toContain("# thicket report");
  });

  it("exits non-zero when the project has no source files", async () => {
    const io = capture();
    expect(await main(["--config", emptyConfig()])).not.toBe(0);
    expect(io.stdout()).not.toContain("# thicket report");
    expect(io.stderr()).toMatch(/no source files/i);
  });

  it("names the config and the likely cause when the project is empty", async () => {
    const io = capture();
    await main(["--config", emptyConfig()]);
    expect(io.stderr()).toContain("fixtures/empty/tsconfig.json");
    expect(io.stderr()).toMatch(/references|include/i);
  });

  it("rejects an empty --config instead of silently analyzing the cwd", async () => {
    const io = capture();
    expect(await main(["--config", ""])).not.toBe(0);
    expect(io.stderr()).toMatch(/--config/);
    expect(io.stdout()).toBe("");
  });

  /**
   * Every failure path, checked for shape rather than wording.
   *
   * The prefix is how a harness tells thicket's own diagnostics apart from the
   * compiler's, and the newline is what keeps two of them from running
   * together on one line. Asserted as a property because the per-case
   * assertions above are `toMatch` on a fragment, which stays green if the
   * prefix disappears -- and one site had in fact drifted into supplying its
   * own prefix while the rest added theirs at the call.
   */
  const FAILING_INVOCATIONS: readonly (readonly string[])[] = [
    ["--config", ""],
    ["--config", "/definitely/not/here/tsconfig.json"],
    ["--depth", "9"],
    ["--depth", "not-a-number"],
    ["--types", "sideways"],
    ["--granularity", "sideways"],
    ["cache", "purge"],
    ["one", "two"],
    ["--filter", "a", "--config", fixtureConfig()],
    ["--filter", "a", "--no-workspaces"],
    ["/definitely/not/here"],
    ["--not-a-flag"],
  ];

  it.each(FAILING_INVOCATIONS)("explains itself on stderr: thicket %s %s", async (...argv) => {
    const io = capture();
    expect(await main(argv)).not.toBe(0);
    const err = io.stderr();
    expect(err.startsWith("thicket: ")).toBe(true);
    expect(err.endsWith("\n")).toBe(true);
    expect(io.stdout()).toBe("");
  });

  it("exits non-zero for a nonexistent config path", async () => {
    const io = capture();
    expect(await main(["--config", "/definitely/not/here/tsconfig.json"])).not.toBe(0);
    expect(io.stderr()).toContain("/definitely/not/here/tsconfig.json");
    expect(io.stdout()).toBe("");
  });

  it("--include-generated puts the excluded files back", async () => {
    const off = capture();
    await main(["--config", generatedConfig()]);
    const offFiles = off.stdout();
    vi.restoreAllMocks();
    const on = capture();
    await main(["--config", generatedConfig(), "--include-generated"]);
    // 4 hand-written, plus 2 generated directories and 2 banner-marked files.
    expect(offFiles).toMatch(/\b4 files \//);
    expect(on.stdout()).toMatch(/\b8 files \//);
  });

  it("states what it did not analyze, so a thinned corpus is visible", async () => {
    // The counts above are drawn from what survives the filters. A run that
    // silently analyzed half the tree is the failure this line exists to stop.
    const io = capture();
    await main(["--config", generatedConfig()]);
    expect(io.stdout()).toMatch(
      /\*\*Not analyzed:\*\* 4 generated files — 2 in generated directories, 2 marked generated by a banner comment\./,
    );
  });

  it("--exclude drops matching files and says so", async () => {
    const io = capture();
    await main(["--config", generatedConfig(), "--exclude", "**/distance/**"]);
    expect(io.stdout()).toMatch(/\b3 files \//);
    expect(io.stdout()).toMatch(/1 matching --exclude/);
  });

  it("--no-banner-scan turns off just that opinion, leaving the others", async () => {
    // The banner sniff is an opinion -- "this text means a machine wrote it"
    // -- and every opinion here has to be switchable on its own. Turning it
    // off must NOT drag the directory rule back on with it.
    const io = capture();
    await main(["--config", generatedConfig(), "--no-banner-scan"]);
    // The 4 hand-written files plus the 2 the banner rule was dropping.
    expect(io.stdout()).toMatch(/\b6 files \//);
    expect(io.stdout()).toMatch(/2 in generated directories/);
    expect(io.stdout()).not.toMatch(/banner comment/);
  });

  it("--exclude survives --include-generated, because it is an instruction", async () => {
    const io = capture();
    await main([
      "--config",
      generatedConfig(),
      "--include-generated",
      "--exclude",
      "**/distance/**",
    ]);
    expect(io.stdout()).toMatch(/\b7 files \//);
  });

  it("--granularity dir names modules at their own depth", async () => {
    // Four files at four depths. A fixed depth folds the deeper ones into the
    // shallower one; `dir` must not. Asserting only that the run succeeds, or
    // only the module COUNT against one other setting, passes with the feature
    // deleted -- which is how this test failed its own mutation the first time.
    const io = capture();
    expect(await main(["--config", nestedConfig(), "--granularity", "dir"])).toBe(0);
    expect(io.stdout()).toMatch(/granularity: dir \(4 modules\)/);

    vi.restoreAllMocks();
    const shallow = capture();
    await main(["--config", nestedConfig(), "--granularity", "1"]);
    // Depth 1 collapses three directories into one module. That difference is
    // the whole feature.
    expect(shallow.stdout()).toMatch(/granularity: dir:1 \(2 modules\)/);
  });

  it("still rejects a granularity that is neither a mode nor a depth", async () => {
    const io = capture();
    expect(await main(["--config", fixtureConfig(), "--granularity", "folder"])).not.toBe(0);
    expect(io.stderr()).toMatch(/auto, dir, file, or a directory depth/);
  });

  it("rejects an unknown --types mode instead of quietly analyzing everything", async () => {
    // A typo'd mode that fell back to the default would be indistinguishable
    // from asking for the default, and every number in the report would be
    // drawn from a half the reader did not choose.
    const io = capture();
    expect(await main(["--config", fixtureConfig(), "--types", "typs"])).not.toBe(0);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toMatch(/--types must be include, exclude, or only/);
  });

  it("analyzes a solution-style config rather than reporting it empty", async () => {
    const io = capture();
    expect(await main(["--config", solutionConfig()])).toBe(0);
    expect(io.stdout()).toMatch(/\b3 files \//);
  });

  it("--no-cache leaves no cache behind and reports the same thing", async () => {
    const { root, config } = scratchProject();
    const io = capture();
    expect(await main(["--config", config, "--no-cache"])).toBe(0);
    const plain = io.stdout();
    expect(existsSync(cachePathFor(root))).toBe(false);

    vi.restoreAllMocks();
    const cached = capture();
    expect(await main(["--config", config])).toBe(0);
    expect(existsSync(cachePathFor(root))).toBe(true);
    expect(cached.stdout()).toBe(plain);
  });

  it("cache clear removes the project's cache, and says so either way", async () => {
    const { root, config } = scratchProject();
    capture();
    await main(["--config", config]);
    expect(existsSync(cachePathFor(root))).toBe(true);

    vi.restoreAllMocks();
    const io = capture();
    expect(await main(["cache", "clear", "--config", config])).toBe(0);
    expect(existsSync(cachePathFor(root))).toBe(false);
    expect(existsSync(join(root, ".thicket"))).toBe(false);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toMatch(/cleared/);

    vi.restoreAllMocks();
    const again = capture();
    expect(await main(["cache", "clear", "--config", config])).toBe(0);
    expect(again.stderr()).toMatch(/no cache/);
  });

  it("rejects an unknown command instead of analyzing anyway", async () => {
    const io = capture();
    expect(await main(["cache", "burn", "--config", fixtureConfig()])).not.toBe(0);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toMatch(/unknown command/);
  });
});

describe("main [dir]", () => {
  it("analyzes the directory named as a positional", async () => {
    // Every workspace contributes: the root's `scripts/`, alpha's three files
    // (its sibling test config included), beta's and gamma's one each. Six is
    // the whole point -- a run that ignored the positional would analyze this
    // repository's own tsconfig instead, and one that skipped discovery would
    // report 1.
    const io = capture();
    expect(await main([workspacesRoot(), "--no-cache"])).toBe(0);
    expect(io.stdout()).toMatch(/\b6 files \//);
  });

  it("errors, naming the nearest ancestor with a project, when a directory has none", async () => {
    // No upward search: thicket analyzes exactly where it is pointed. Saying
    // where the nearest project IS costs nothing and is the next command the
    // reader will type.
    const io = capture();
    expect(await main([join(workspacesRoot(), "tools/alpha/src")])).toBe(1);
    expect(io.stdout()).toBe("");
    // The ancestor is the END of the line. Merely `toContain` that path would
    // pass on a message that names only the directory asked for, which
    // contains it as a prefix.
    expect(io.stderr().trimEnd().endsWith(join(workspacesRoot(), "tools/alpha"))).toBe(true);
    expect(io.stderr()).toMatch(/nearest directory above it/);
  });

  it("rejects a positional that is not a directory", async () => {
    const io = capture();
    expect(await main([join(workspacesRoot(), "tsconfig.json")])).toBe(1);
    expect(io.stderr()).toMatch(/not a directory/);
  });

  it("--config suppresses discovery, because the caller asked for something specific", async () => {
    // The root config covers `scripts/` alone. Discovery would make this 6.
    const io = capture();
    expect(await main(["--config", join(workspacesRoot(), "tsconfig.json"), "--no-cache"])).toBe(
      0,
    );
    expect(io.stdout()).toMatch(/\b1 files \//);
  });

  it("--no-workspaces turns off just that opinion, leaving --exclude in force", async () => {
    const root = miniMonorepo();
    const all = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(all.stdout()).toMatch(/\b3 files \//);

    vi.restoreAllMocks();
    const off = capture();
    expect(await main([root, "--no-workspaces", "--no-cache"])).toBe(0);
    expect(off.stdout()).toMatch(/\b2 files \//);

    vi.restoreAllMocks();
    const both = capture();
    expect(await main([root, "--no-workspaces", "--exclude", "src/b.ts", "--no-cache"])).toBe(0);
    expect(both.stdout()).toMatch(/\b1 files \//);
    expect(both.stdout()).toMatch(/1 matching --exclude/);
  });

  it("--filter narrows the run to the workspaces it names", async () => {
    const io = capture();
    expect(await main([workspacesRoot(), "--filter", "@fix/alpha", "--no-cache"])).toBe(0);
    // alpha's three files plus the root's one; beta and gamma are out.
    expect(io.stdout()).toMatch(/\b4 files \//);
  });

  it("--filter that matches nothing errors, listing what is available", async () => {
    const io = capture();
    expect(await main([workspacesRoot(), "--filter", "nope", "--no-cache"])).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toMatch(/nope/);
    expect(io.stderr()).toMatch(/@fix\/alpha/);
  });

  it("refuses --filter beside --config rather than ignoring it", async () => {
    const io = capture();
    expect(
      await main(["--config", join(workspacesRoot(), "tsconfig.json"), "--filter", "@fix/alpha"]),
    ).toBe(1);
    expect(io.stderr()).toMatch(/--filter/);
    expect(io.stderr()).toMatch(/--config/);
  });

  it("refuses --filter beside --no-workspaces rather than ignoring it", async () => {
    const io = capture();
    expect(await main([workspacesRoot(), "--filter", "@fix/alpha", "--no-workspaces"])).toBe(1);
    expect(io.stderr()).toMatch(/--no-workspaces/);
  });

  it("says nothing on stderr when every workspace is analyzed", async () => {
    const io = capture();
    expect(await main([filterWorkspacesRoot(), "--no-cache"])).toBe(0);
    expect(io.stderr()).toBe("");
  });

  it("says nothing about a workspace that holds no TypeScript", async () => {
    // `tools/cfgonly` publishes shared compiler settings and owns no source
    // but a `.d.ts`. It contributes zero configs, correctly -- and there is
    // nothing of its to analyze, so a line about it is false in the sense the
    // reader cares about and unactionable in every sense. At monorepo scale
    // that is one such line per JS package on every run.
    const io = capture();
    expect(await main([workspacesRoot(), "--no-cache"])).toBe(0);
    expect(io.stderr()).toBe("");
  });

  it("warns for a config-less workspace with TypeScript, and not for one without", async () => {
    const root = scratchTree({
      "package.json": JSON.stringify({ name: "tree-root", workspaces: ["pkg/*"] }),
      // Spans `pkg/covered` as well as the root's own source, which is how a
      // workspace with no tsconfig of its own can still be fully analyzed.
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext" },
        include: ["src/**/*.ts", "pkg/covered/**/*.ts"],
      }),
      "src/a.ts": "export const a = 1;\n",
      "pkg/ts/package.json": JSON.stringify({ name: "@t/ts" }),
      "pkg/ts/src/x.ts": "export const x = 1;\n",
      "pkg/js/package.json": JSON.stringify({ name: "@t/js" }),
      "pkg/js/src/x.js": "export const x = 1;\n",
      "pkg/covered/package.json": JSON.stringify({ name: "@t/covered" }),
      "pkg/covered/src/c.ts": "export const c = 1;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(io.stdout()).toMatch(/\b2 files \//);
    // Only the one with TypeScript nothing reached.
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
    expect(io.stderr()).toContain("@t/ts");
    expect(io.stderr()).not.toContain("@t/js");
    expect(io.stderr()).not.toContain("@t/covered");
  });

  it("orders the warnings by what they display, not by directory", async () => {
    // The walk orders workspaces by directory; the line leads with the package
    // name. At 14 workspaces the unsorted form reads as shuffled.
    const root = scratchTree({
      "package.json": JSON.stringify({ name: "tree-root", workspaces: ["pkg/*"] }),
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "pkg/a/package.json": JSON.stringify({ name: "@z/one" }),
      "pkg/a/src/x.ts": "export const x = 1;\n",
      "pkg/b/package.json": JSON.stringify({ name: "@a/two" }),
      "pkg/b/src/y.ts": "export const y = 1;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    const lines = io.stderr().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("@a/two");
    expect(lines[1]).toContain("@z/one");
  });

  it("names a member manifest that would not read, which is why it has no name", async () => {
    // The workspace is discovered -- the file exists -- but `packageName`
    // answers undefined, so `--filter` by name cannot reach it and the error
    // lists a bare `./pkg/bad` among named siblings, explaining nothing. The
    // cause is a file in the reader's own tree.
    const files = {
      "package.json": JSON.stringify({ name: "tree-root", workspaces: ["pkg/*"] }),
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "pkg/bad/package.json": '{ "name": "@x/bad"',
      "pkg/bad/tsconfig.json": TSCONFIG,
      "pkg/bad/src/b.ts": "export const b = 1;\n",
    };
    const root = scratchTree(files);
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
    expect(io.stderr()).toContain(join(root, "pkg/bad/package.json"));

    // And it is said BEFORE selection throws, which is the case it explains.
    vi.restoreAllMocks();
    const filtered = capture();
    expect(await main([root, "--filter", "@x/bad", "--no-cache"])).toBe(1);
    expect(filtered.stderr()).toContain(join(root, "pkg/bad/package.json"));
    expect(filtered.stderr()).toMatch(/matched no workspace/);
  });

  it("says nothing about a member manifest that merely omits a name", async () => {
    // Legal, and `./pkg/anon` still addresses it. A line here would fire on
    // every private package in the tree.
    const root = scratchTree({
      "package.json": JSON.stringify({ name: "tree-root", workspaces: ["pkg/*"] }),
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "pkg/anon/package.json": JSON.stringify({ private: true }),
      "pkg/anon/tsconfig.json": TSCONFIG,
      "pkg/anon/src/b.ts": "export const b = 1;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(io.stderr()).toBe("");
  });

  it("warns once when a manifest exists but could not be read", async () => {
    // `workspaceGlobs` answers undefined for absent, unreadable and
    // unparseable alike, so the coverage banner blames scope and an
    // unreadable `package.json` reads as "not a monorepo".
    const root = scratchTree({
      "package.json": '{ "name": "broken", "workspaces": ["pkg/*"',
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(io.stdout()).toMatch(/\b1 files \//);
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
    expect(io.stderr()).toContain(join(root, "package.json"));
  });

  it("warns when a manifest declares workspaces in a shape it cannot read", async () => {
    const root = scratchTree({
      "package.json": JSON.stringify({ name: "odd", workspaces: { globs: ["pkg/*"] } }),
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
    expect(io.stderr()).toContain("workspaces");
  });

  it("warns when a pnpm manifest holds a glob it refused to read", async () => {
    const root = scratchTree({
      "package.json": JSON.stringify({ name: "pnpm-ish", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - 'pkg/*\n",
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
    expect(io.stderr()).toContain("pnpm-workspace.yaml");
  });

  it("a directory named like a command is reachable as a path", async () => {
    // `cache` and `diff` are checked FIRST, so they stay unambiguous; `./diff`
    // is how someone with a directory of that name gets at it.
    const root = scratchTree({
      "diff/tsconfig.json": TSCONFIG,
      "diff/src/a.ts": "export const a = 1;\n",
    });
    const io = capture();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await main(["./diff", "--no-cache"])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(io.stdout()).toMatch(/\b1 files \//);
  });

  it("warns about a workspaces entry that is not a string, and uses the rest", async () => {
    // `workspaceGlobs` drops these silently, which analyzes a subset of the
    // tree and reports it as the whole of it.
    const root = scratchTree({
      "package.json": JSON.stringify({ name: "tree-root", workspaces: ["pkg/*", 7] }),
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "pkg/one/package.json": JSON.stringify({ name: "one" }),
      "pkg/one/tsconfig.json": TSCONFIG,
      "pkg/one/src/c.ts": "export const c = 3;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(io.stdout()).toMatch(/\b2 files \//);
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
    expect(io.stderr()).toMatch(/not a string/);
  });

  it("names a workspace with no tsconfig even when one of its children has one", async () => {
    // `pkg/parent` and `pkg/parent/child` are both workspaces under `pkg/**`.
    // Test containment by prefix alone and the child's config counts as the
    // parent's, so the parent's source goes unanalyzed and unmentioned.
    const root = scratchTree({
      "package.json": JSON.stringify({ name: "tree-root", workspaces: ["pkg/**"] }),
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "pkg/parent/package.json": JSON.stringify({ name: "parent" }),
      "pkg/parent/src/p.ts": "export const p = 1;\n",
      "pkg/parent/child/package.json": JSON.stringify({ name: "child" }),
      "pkg/parent/child/tsconfig.json": TSCONFIG,
      "pkg/parent/child/src/c.ts": "export const c = 3;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(0);
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
    expect(io.stderr()).toContain("parent");
  });

  it("errors when a workspace root holds no tsconfig anywhere", async () => {
    const root = scratchTree({
      "package.json": JSON.stringify({ name: "tree-root", workspaces: ["pkg/*"] }),
      "pkg/one/package.json": JSON.stringify({ name: "one" }),
      "pkg/one/src/c.ts": "export const c = 3;\n",
    });
    const io = capture();
    expect(await main([root, "--no-cache"])).toBe(1);
    expect(io.stdout()).toBe("");
    // Named with the root, because the per-workspace warning above it also
    // says "no tsconfig" and would satisfy a looser assertion.
    expect(io.stderr()).toContain(`no tsconfig in ${root}`);
  });

  it("errors when --filter is given a directory that declares no workspaces", async () => {
    // Otherwise the filter is a silent no-op and the report reads as the
    // narrowed run the caller asked for.
    const io = capture();
    expect(await main([fixtureRoot(), "--filter", "anything", "--no-cache"])).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toMatch(/--filter/);
  });

  it("cache clear needs no tsconfig beside it", async () => {
    // The cache is pinned to the analyzed directory, so clearing it must not
    // route through a config that may not exist -- a monorepo root whose
    // compiler settings live in its packages has no tsconfig.json at all.
    const root = scratchTree({ "src/a.ts": "export const a = 1;\n" });
    const io = capture();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await main(["cache", "clear"])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(io.stderr()).toMatch(/no cache/);
  });
});

describe("main diff", () => {
  /** Writes a sidecar by actually running a report, so the shape is the real one. */
  async function sidecar(config: string, name: string, into: string): Promise<string> {
    const path = join(into, name);
    const io = capture();
    expect(await main(["--config", config, "--json", path, "--no-cache"])).toBe(0);
    io.stdout();
    vi.restoreAllMocks();
    return path;
  }

  it("compares two sidecars and names what was resolved", async () => {
    const { root, config } = scratchProject();
    const before = await sidecar(config, "before.json", root);
    // Delete one copy of the duplicated function.
    const beta = join(root, "src/beta.ts");
    const bodies = readFileSync(beta, "utf8").split(/\n\n(?=export function )/);
    writeFileSync(beta, bodies.slice(0, -1).join("\n\n").trimEnd() + "\n");
    const after = await sidecar(config, "after.json", root);

    const io = capture();
    expect(await main(["diff", before, after])).toBe(0);
    expect(io.stdout()).toMatch(/[1-9]\d* findings? resolved/);
    expect(io.stdout()).toMatch(/THK-DUP-[0-9a-f]{8}/);
    expect(io.stdout()).toContain("propagation cost");
  });

  it("needs no tsconfig in the working directory", async () => {
    // `--config` defaults to ./tsconfig.json. A diff analyzes nothing, so
    // requiring one would break the command everywhere but a project root.
    const { root, config } = scratchProject();
    const before = await sidecar(config, "before.json", root);
    const io = capture();
    const cwd = process.cwd();
    process.chdir(tmpdir());
    try {
      expect(await main(["diff", before, before])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(io.stdout()).toContain("0 findings resolved");
    expect(io.stderr()).toBe("");
  });

  it("rejects a wrong number of arguments", async () => {
    const io = capture();
    expect(await main(["diff", "only-one.json"])).not.toBe(0);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toMatch(/two report paths/);
  });

  it("names the file it could not read", async () => {
    const io = capture();
    expect(await main(["diff", "/no/such/before.json", "/no/such/after.json"])).not.toBe(0);
    expect(io.stderr()).toContain("/no/such/before.json");
  });

  it("names the file that is not a report", async () => {
    const { root, config } = scratchProject();
    const good = await sidecar(config, "good.json", root);
    const junk = join(root, "junk.json");
    writeFileSync(junk, `{"hello":"world"}\n`);
    const io = capture();
    expect(await main(["diff", good, junk])).not.toBe(0);
    expect(io.stderr()).toContain("junk.json");
    expect(io.stderr()).toMatch(/not a thicket report/);
  });
});
