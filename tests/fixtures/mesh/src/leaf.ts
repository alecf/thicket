import { fna } from "./a.js";

export function fnleaf(depth: number): number {
  if (depth <= 0) return 0;
  return fna(depth - 1);
}
