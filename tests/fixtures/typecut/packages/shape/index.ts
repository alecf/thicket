// In the SCC by two type-only edges and nothing else, so it is not in the
// runtime cycle at all.
import type { GammaId } from "../gamma/index.js";

export interface Shape extends GammaId {
  label: string;
}
