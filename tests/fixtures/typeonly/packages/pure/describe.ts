// pure -> model, erased entirely at compile time. Closes a cycle with
// `model/uses.ts` that has no runtime existence on this side.
import type { Shape } from "../model/types.js";

export function describe(shape: Shape): string {
  return `${shape.kind}:${shape.size}`;
}
