// `ra` and `rb` are mutually dependent both ways: one edge is erased, the
// other runs. Either cut breaks the cycle. Erasing the types leaves no cycle,
// so nothing can fail at module init, and the cheaper move wins: the type
// goes, and the runtime import stays.
import type { RbShape } from "../rb/index.js";
import { rbValue } from "../rb/index.js";

export interface RaShape {
  raLabel: string;
  raPeer: RbShape | null;
}

export const raValue = (): number => rbValue() + 1;
