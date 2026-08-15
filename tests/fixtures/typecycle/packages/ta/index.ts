// `ta` and `tb` depend on each other through types alone. Nothing here exists
// at runtime, and the cycle is still real complexity: a reader cannot
// understand either module without the other. Cutting one edge breaks it
// completely, so it is worth proposing -- labelled for what it is.
import type { TbShape } from "../tb/index.js";

export interface TaShape {
  taLabel: string;
  taPeer: TbShape | null;
}
