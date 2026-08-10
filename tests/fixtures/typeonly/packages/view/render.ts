// The same file imported three times, erased/real/erased. Deciding per
// declaration -- or letting the last one win -- calls this erasable on the
// strength of the trailing `import type` line.
import type { Shape } from "../model/types.js";
import { EMPTY } from "../model/types.js";
import type { Sized } from "../model/types.js";
import { ORIGIN } from "../model/consts.js";

export function render(shape: Shape = EMPTY): string {
  const sized: Sized = { size: shape.size };
  return `${shape.kind}@${ORIGIN}:${sized.size}`;
}
