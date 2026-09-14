// In no workspace, and covered by the root's own `tsconfig.json` -- so the
// root has no gap of its own once that config is loaded, and any gap it is
// seen to have came from somewhere else.
export function filterRoot(n: number): number {
  return n + 1;
}
