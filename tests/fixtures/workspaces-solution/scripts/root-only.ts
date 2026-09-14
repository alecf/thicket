// In no workspace, and covered by no config: the root owns zero files. A
// genuine permanent coverage gap, not one a sibling config can close.
export function rootOnly(): string {
  return "uncovered";
}
