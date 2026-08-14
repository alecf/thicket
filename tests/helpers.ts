import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
