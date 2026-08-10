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
