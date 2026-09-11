import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function fixtureRoot(): string {
  return resolve(here, "fixtures/sample");
}
export function fixtureConfig(): string {
  return resolve(fixtureRoot(), "tsconfig.json");
}

/**
 * A second fixture with two tsconfig projects that both include the same
 * `shared` package. Passing the same config path twice does NOT exercise the
 * multi-project code paths — the API dedupes `openProjects` by path and hands
 * back a single project. Only genuinely distinct configs do.
 */
/**
 * A third fixture holding one of every import form that carries a distinct
 * binding count — default, named, namespace, type-only, side-effect,
 * re-export, dynamic. Edge weight is a count of distinct imported symbols, so
 * each of those forms is a separate way to get the weight silently wrong.
 */
export function importsFixtureConfig(): string {
  return resolve(here, "fixtures/imports/tsconfig.json");
}

/**
 * A fourth fixture in the "solution style" the Vite/React template emits: a
 * root config that declares `"files": []` and delegates entirely to
 * `references`. It legitimately owns no source files, so a loader that stops
 * there analyzes nothing. `tsconfig.tools.json` is itself reference-only and
 * points back at the root, so expansion must recurse AND survive a cycle.
 */
export function solutionRoot(): string {
  return resolve(here, "fixtures/solution");
}
export function solutionConfig(): string {
  return resolve(solutionRoot(), "tsconfig.json");
}
export function solutionLeafConfigs(): string[] {
  return [
    resolve(solutionRoot(), "tsconfig.app.json"),
    resolve(solutionRoot(), "tsconfig.node.json"),
  ];
}

/**
 * A config whose `include` matches nothing — there is no `src/` beside it.
 * Stands in for every way a run can end up with no input (wrong path, empty
 * include, unresolvable references), all of which must fail loudly rather
 * than emit a clean-looking report over nothing.
 */
export function emptyConfig(): string {
  return resolve(here, "fixtures/empty/tsconfig.json");
}

/**
 * A fixture holding one generated directory of each shape (`dist/`, a nested
 * `.next/`) beside two source paths that contain those names as substrings
 * (`src/distance/`, `src/outbound.ts`). The pair is the whole point: the
 * exclusion must be by path segment, and a substring match passes the first
 * half of this fixture while silently deleting the second.
 */
/**
 * Four files in a complete mesh plus a leaf hanging off one of them. Every
 * single-edge cut leaves the mesh strongly connected, so the best available
 * cut detaches the leaf and shrinks a 5-module tangle to 4 -- a cut that does
 * not break anything.
 */
/**
 * Four files each carrying the same interface and type alias under different
 * names, beside a much larger duplicated function. The type findings are worth
 * a third as many recoverable lines as the code one, so they lose every
 * contest scored on volume -- which is the whole reason they need a section of
 * their own.
 */
/**
 * Two independent 2-module cycles: one held together by `import type` alone,
 * one where a runtime edge and a type edge each break it.
 */
export function typeCycleConfig(): string {
  return resolve(here, "fixtures/typecycle/tsconfig.json");
}

export function typeShapeConfig(): string {
  return resolve(here, "fixtures/typeshape/tsconfig.json");
}

/** Four files at four different directory depths, one importing the next. */
export function nestedConfig(): string {
  return resolve(here, "fixtures/nested/tsconfig.json");
}

export function meshConfig(): string {
  return resolve(here, "fixtures/mesh/tsconfig.json");
}

export function generatedRoot(): string {
  return resolve(here, "fixtures/generated");
}
export function generatedConfig(): string {
  return resolve(here, "fixtures/generated/tsconfig.json");
}

/**
 * A root config that excludes `packages/`, beside a `packages/lib` that has
 * its own tsconfig — the shape of a real monorepo whose root config covered
 * 3% of the tree. Carries one decoy per way the on-disk count can inflate:
 * `dist/` build output, a `.d.ts`, and a checkout inside a dot-directory.
 */
export function partialRoot(): string {
  return resolve(here, "fixtures/partial");
}
export function partialConfig(): string {
  return resolve(partialRoot(), "tsconfig.json");
}

export function monorepoRoot(): string {
  return resolve(here, "fixtures/monorepo");
}
export function monorepoConfigs(): string[] {
  return [
    resolve(monorepoRoot(), "packages/a/tsconfig.json"),
    resolve(monorepoRoot(), "packages/b/tsconfig.json"),
  ];
}

/**
 * A fixture where the highest-scoring cluster in the codebase is test
 * scaffolding: identical mock-logger setup in four `__tests__` files, against
 * one production clone shared by two source files. On score alone the
 * scaffolding wins, which is what made 10 of the top 40 findings on a real
 * application test setup. The report must still lead with the production
 * clone, because the two live in separate sections.
 */
export function testSplitConfig(): string {
  return resolve(here, "fixtures/testsplit/tsconfig.json");
}

/**
 * The one fixture that populates every census category at once: a production
 * clone, a duplicated interface and type alias, identical scaffolding in three
 * test files, and a two-module runtime cycle. The census claims to partition
 * the candidate pile, and a partition cannot be checked against a fixture that
 * leaves categories empty -- when `typeDuplication` was added to `Census` and
 * left out of the sum, the sum still balanced everywhere it was asserted.
 */
export function censusConfig(): string {
  return resolve(here, "fixtures/census/tsconfig.json");
}

/**
 * Three packages arranged so that every type-only case is distinguishable:
 * `pure -> model` is erased entirely, `view -> model` mixes one type-only
 * import with one value import, and `model -> pure` is plain value. The first
 * two close a cycle with the third, so cut selection has a type-only edge and
 * a runtime edge that dissolve it equally.
 */
export function typeOnlyConfig(): string {
  return resolve(here, "fixtures/typeonly/tsconfig.json");
}

/**
 * A three-package ring with a fourth package hanging off it by a single
 * symbol in each direction. The cheapest edge that breaks the component
 * detaches the leaf and leaves the ring intact; a heavier ring edge dissolves
 * strictly more. Distinguishes "first cut that works" from "best cut".
 */
/**
 * Four classes that differ ONLY in the string constants they carry, which is
 * the shape a real report got wrong: it said "19 classes are the same" and
 * said nothing about what makes each one different, so the reader could not
 * tell a missing abstraction from a config table until they had extracted the
 * varying constants by hand.
 */
export function configTableConfig(): string {
  return resolve(here, "fixtures/config/tsconfig.json");
}

/**
 * A three-package clique no single edge can break, plus a package attached to
 * it by type-only edges alone. Detaching that package is the best available cut
 * by dissolution and is worthless: both its edges erase at compile time.
 */
/**
 * Two duplication clusters of the same syntactic shape and opposite worth: ten
 * three-field projections whose every key differs, and four constant blocks
 * whose keys are identical and whose values differ.
 */
export function driftConfig(): string {
  return resolve(here, "fixtures/drift/tsconfig.json");
}

/**
 * `app -> api -> app`, where every binding `app` takes from `api` is forwarded
 * by `api/errors.ts` from `core`. The edge is routing, not dependency, and
 * repointing the specifier deletes it without changing the program.
 */
export function passThroughConfig(): string {
  return resolve(here, "fixtures/passthrough/tsconfig.json");
}

export function typeCutConfig(): string {
  return resolve(here, "fixtures/typecut/tsconfig.json");
}

export function tangleConfig(): string {
  return resolve(here, "fixtures/tangle/tsconfig.json");
}

/**
 * A workspace root whose own tsconfig covers only `scripts/`, beside four
 * workspaces and one excluded by a negation glob. Directory names are
 * deliberately `tools/` and `libs/`: any hardcoded `apps`/`packages` name
 * fails here instead of passing by luck.
 *
 * Each member is a trap for one way workspace discovery goes wrong:
 * - `tools/alpha` carries two siblings, and they must be told apart by the
 *   files they add: `tsconfig.test.json` adds the one file the main config
 *   excludes, `tsconfig.build.json` names a proper subset and adds nothing.
 * - `tools/cfgonly` publishes shared config and owns no tsconfig and no
 *   source; it must yield zero configs rather than throwing, and its lone
 *   `.d.ts` keeps it out of the denominator. Its `base.json` is a non-tsconfig
 *   JSON file sitting where configs are looked for -- glob `*.json` instead of
 *   `tsconfig*.json` and it gets loaded as a project.
 * - `libs/ignored` has a working config and source, so the negation glob is
 *   the only thing keeping it out of the analyzed set.
 * - `deep/a/b/gamma` is reachable only through a `**` glob, two levels below
 *   where every other workspace sits, so one-level expansion misses it.
 * - `deep/a/b/gamma/node_modules/dep` is a package the walk must skip. It sits
 *   under `deep/**` because that is the only glob here that crosses separators:
 *   anywhere under `tools/*` or `libs/*` the include filter rejects it on path
 *   depth alone, so the walk's own skip would never be what excluded it and
 *   deleting that skip would change nothing.
 *
 * `tools/cfgonly` is also the one workspace with no `"type": "module"`, which
 * is deliberate rather than an oversight: it owns a single `.d.ts` and no
 * module ever resolves against it.
 */
export function workspacesRoot(): string {
  return resolve(here, "fixtures/workspaces");
}

/**
 * A second workspace root in the solution style a real pnpm monorepo uses: the
 * root `tsconfig.json` declares `"files": []` and delegates to `tools/alpha`,
 * so it legitimately owns nothing. `scripts/root-only.ts` sits in no workspace
 * and is covered by no config -- a permanent gap, and the only honest answer
 * is to say so.
 *
 * The root also carries a sibling, `tsconfig.build.json`, whose `include`
 * reaches into `tools/**`. That is what `workspacesRoot()` cannot test: its
 * root has no sibling at all, so a coverage check scoped to the whole tree
 * rather than to files in no workspace passes there by construction. Here it
 * adopts a config that covers only another workspace's files.
 *
 * `tools/alpha/scripts/build.ts` closes the other way that check can be wrong.
 * Scope the root's gap GLOBALLY -- "files no config chosen so far covers" --
 * and with every `tools/` file already covered by alpha's own config the
 * residual is `scripts/root-only.ts` alone, which the sibling does not cover,
 * so the sibling is declined for a reason unrelated to scoping. `build.ts`
 * sits outside alpha's `src/**` and inside the sibling's `tools/**`, so it
 * survives into a global residual and the sibling covers it. Both mis-scopes
 * now adopt it; the correct check looks for a sibling inside `tools/alpha`,
 * finds none, and reports alpha's gap as permanent.
 */
export function solutionWorkspacesRoot(): string {
  return resolve(here, "fixtures/workspaces-solution");
}

/**
 * A third workspace root, declared the pnpm way. Its `package.json` carries no
 * `workspaces` key at all, so `pnpm-workspace.yaml` is the only thing here that
 * can answer -- read the globs from the wrong file and this root looks like a
 * plain single project.
 *
 * The YAML is shaped after a real pnpm monorepo's, because the details that
 * break a hand-written parser are the ones nobody writes into an example:
 * entries that are single-quoted, double-quoted and bare; an entry that is a
 * plain directory name rather than a pattern; comments both above `packages:`
 * and inside its list; and later top-level keys, one holding a nested mapping
 * and one holding a list of its own. The parser must stop at the FIRST of those
 * keys, which makes everything after it unreachable by construction -- the
 * second key is realism, not coverage, and the output is identical with those
 * lines deleted. The shape that would actually leak, a later key whose own list
 * is flush against the margin, is pinned in `tests/workspaces.test.ts` where it
 * can be read beside the regex it constrains.
 *
 * Only `libs/gamma` exists on disk. Nothing expands these globs -- this root is
 * read by the manifest parser and by nothing else -- so the rest deliberately
 * match nothing.
 */
export function pnpmWorkspacesRoot(): string {
  return resolve(here, "fixtures/workspaces-pnpm");
}

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
export function withRoot(files: Record<string, string>, body: (root: string) => void): void {
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
