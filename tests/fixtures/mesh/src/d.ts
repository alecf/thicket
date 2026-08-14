import { fna } from "./a.js";
import { fnb } from "./b.js";
import { fnc } from "./c.js";

export function fnd(depth: number): number {
  if (depth <= 0) return 0;
  if (depth === 1) return fna(depth - 1);
  if (depth === 2) return fnb(depth - 1);
  if (depth === 3) return fnc(depth - 1);
  return depth;
}
