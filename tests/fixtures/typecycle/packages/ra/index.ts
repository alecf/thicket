// `ra` and `rb` are mutually dependent both ways: one edge is erased, the
// other runs. Either cut breaks the cycle, so the tie is broken on which one
// is real -- a crash at module init is a worse problem than a knot in the
// type graph.
import type { RbShape } from "../rb/index.js";
import { rbValue } from "../rb/index.js";

export interface RaShape {
  raLabel: string;
  raPeer: RbShape | null;
}

export const raValue = (): number => rbValue() + 1;
