// `ringKey` uses `RING` from `consts.ts`, which is in a cycle of its own with
// `names.ts`. Moving `ringKey` there breaks this cycle and leaves that one as
// it was, so nothing of this tangle is left.
import { RING } from "./consts.js";
import { userName } from "./user.js";

export function ringKey(id: string): string {
  return `${RING}:${id}`;
}

export function ownerName(): string {
  return userName();
}
