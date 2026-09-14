// Outside `src/**`, so `tools/alpha/tsconfig.json` does not cover it, and
// inside the ROOT `tsconfig.build.json`'s `tools/**/*.ts`, so that config does.
//
// This is `tools/alpha`'s gap. A correctly scoped check looks for a sibling
// config inside `tools/alpha`, finds none, and reports a permanent gap; it
// never reaches for a config at the root. Without this file every file under
// `tools/` is already covered by alpha's own config, so a root check that
// computes its gap GLOBALLY -- "files no chosen config covers yet" -- sees a
// residual of `{scripts/root-only.ts}` alone, which `tsconfig.build.json` does
// not cover, and declines to adopt it for the wrong reason.
export function alphaBuildScript(): string {
  return "not covered by tools/alpha/tsconfig.json";
}
