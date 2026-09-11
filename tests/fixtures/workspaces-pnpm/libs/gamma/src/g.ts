// The one workspace that exists on disk here. This root is read by the
// manifest parser and by nothing else, so the other globs in
// `pnpm-workspace.yaml` deliberately match nothing.
export function gammaPnpmGuard(n: number): number {
  return n + 3;
}
