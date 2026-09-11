// A PLAIN DIRECTORY whose name is prefixed by a workspace directory's:
// `tools/alpha/sub-x` starts with `tools/alpha/sub`, and it is not a
// workspace. So this file belongs to `tools/alpha`, and the only thing that
// says so is the separator in the containment test -- `startsWith(dir)`
// without it hands the file to `tools/alpha/sub`, which is a different
// workspace entirely.
//
// The consequence is not cosmetic: `tools/alpha`'s gap goes empty, its
// sibling is never offered, and this file is analyzed by nothing. Shapes like
// `lib` beside `lib-legacy`, or `api` beside `api-v2`, inside a parent
// workspace make it ordinary.
//
// Covered by `tools/alpha/tsconfig.build.json` (`sub*/**`) and by nothing
// else, so whether that config is chosen is the visible answer.
export function nestSubXScript(): string {
  return "tools/alpha's gap, and tools/alpha's to close";
}
