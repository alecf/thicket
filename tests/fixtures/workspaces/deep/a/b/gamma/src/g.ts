// Reachable only by expanding the `deep/**` glob past one level: this
// workspace sits at depth 4, where every other one sits at depth 2.
export function gammaDeepGlobGuard(n: number): number {
  return n + 10;
}
