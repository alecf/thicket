// Outside `sub/tsconfig.json`'s `src/**`, so it is the nested workspace's gap
// -- and it is inside BOTH `sub/tsconfig.extra.json` and the parent's
// `tsconfig.build.json`, which is what makes the two attributions
// distinguishable.
export function nestSubScript(): string {
  return "covered only by sub/tsconfig.extra.json";
}
