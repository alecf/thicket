// Covered by `tools/alpha/tsconfig.json`, so the parent workspace has no gap
// of its own and never looks at its sibling.
export function nestAlpha(n: number): number {
  return n + 1;
}
