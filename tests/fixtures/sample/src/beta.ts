import { type Point, ORIGIN } from "./util/shared.js";

export function normalizeBeta(items: Point[]): Point[] {
  const out: Point[] = [];
  for (const q of items) {
    const ax = q.x - ORIGIN.x;
    const ay = q.y - ORIGIN.y;
    const mag = Math.sqrt(ax * ax + ay * ay);
    out.push({ x: ax / mag, y: ay / mag });
  }
  return out;
}

export function normalizeExact(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const dx = p.x - ORIGIN.x;
    const dy = p.y - ORIGIN.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    result.push({ x: dx / len, y: dy / len });
  }
  return result;
}
