// `ka` and `kb` form a runtime cycle. A second loop runs `kb -> kc -> kd`,
// and `kd -> kb` closes it through an erased import. Cutting `kb -> kc`,
// `kc -> kd` or `kd -> kb` leaves the `ka`/`kb` pair, and no single edge does
// better. A runtime cycle exists, so the tie goes to a runtime edge.
import { kbValue } from "../kb/index.js";

export const kaValue = (): number => kbValue() + 1;
export const kaOne = (): number => 1;
