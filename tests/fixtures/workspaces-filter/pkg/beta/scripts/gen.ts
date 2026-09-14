// Outside beta's `src/**`, so it is beta's gap. Both `pkg/beta/tsconfig.extra.json`
// and the root's `tsconfig.all.json` cover it, which is what makes the two
// attributions tell each other apart.
export function filterBetaScript(): string {
  return "beta's gap, and beta's to close";
}
