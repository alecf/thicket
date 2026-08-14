import { fnb } from "./b.js";
import { fnc } from "./c.js";
import { fnd } from "./d.js";
import { fnleaf } from "./leaf.js";

export function fna(depth: number): number {
  if (depth <= 0) return 0;
  if (depth === 2) return fnb(depth - 1);
  if (depth === 3) return fnc(depth - 1);
  if (depth === 4) return fnd(depth - 1);
  if (depth === 9) return fnleaf(depth - 1);
  return depth;
}
