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

export function monorepoRoot(): string {
  return resolve(here, "fixtures/monorepo");
}
export function monorepoConfigs(): string[] {
  return [
    resolve(monorepoRoot(), "packages/a/tsconfig.json"),
    resolve(monorepoRoot(), "packages/b/tsconfig.json"),
  ];
}
