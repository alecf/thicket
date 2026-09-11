// The CAPITAL in `Zed` is the whole reason this workspace exists -- do not
// rename it to something tidier. It is the only name in this fixture whose
// order differs between code-unit comparison and collation: `compareStrings`
// sorts `tools/Zed/...` before `tools/alpha/...` (`Z` < `a`), while
// `localeCompare` folds case and puts `alpha` first. Without it, swapping the
// comparator in `configsFor` leaves every test here green, and AGENTS.md §1 is
// pinned as "some sort happens" rather than as the order it names.
export function nestZed(n: number): number {
  return n - 1;
}
