import { type Vec, UNIT } from "../../shared/src/util.js";

export function growA(v: Vec): Vec {
  return { x: v.x + UNIT.x, y: v.y + UNIT.y };
}
