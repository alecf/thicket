import { type Point } from "./util/shared.js";
import { normalizeAlpha } from "./alpha.js";

export function scale(p: Point, k: number): Point {
  return { x: p.x * k, y: p.y * k };
}

export function normalizeThenScale(points: Point[]): Point[] {
  return normalizeAlpha(points).map((p) => scale(p, 2));
}
