import { fna } from "./a.js";
import { fnc } from "./c.js";
import { fnd } from "./d.js";

export function fnb(depth: number): number {
  if (depth <= 0) return 0;
  if (depth === 1) return fna(depth - 1);
  if (depth === 3) return fnc(depth - 1);
  if (depth === 4) return fnd(depth - 1);
  return depth;
}
