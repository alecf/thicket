import { fna } from "./a.js";
import { fnb } from "./b.js";
import { fnd } from "./d.js";

export function fnc(depth: number): number {
  if (depth <= 0) return 0;
  if (depth === 1) return fna(depth - 1);
  if (depth === 2) return fnb(depth - 1);
  if (depth === 4) return fnd(depth - 1);
  return depth;
}
