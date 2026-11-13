// Not in a cycle. Read by the symbol test: `Mode` is declared twice, and
// `helper` declares a local `inner` that is not top-level.
import type { Point as P } from "./point.js";
import * as points from "./point.js";

export const Mode = { on: "on", off: "off" } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export function helper(p: P): number {
  const inner = points.origin.x;
  return p.x + inner;
}
