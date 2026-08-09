import { type Point, ORIGIN } from "./util/shared.js";
import { scale } from "./gamma.js";

export function normalizeAlpha(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const dx = p.x - ORIGIN.x;
    const dy = p.y - ORIGIN.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    result.push({ x: dx / len, y: dy / len });
  }
  return result;
}

export function useScale(points: Point[]): Point[] {
  return points.map((p) => scale(p, 2));
}
