// Exists so `tsconfig.json`'s file set is a PROPER superset of
// `tsconfig.build.json`'s, which names only `src/a.ts`. Nothing imports this.
export function alphaSubsetGuard(n: number): number {
  return n * 3;
}
