// effect -> model, by a side-effect import and an erased one, and nothing
// else. Every *binding* on this edge is erased -- there is exactly one and it
// is `import type` -- so "erased === bindings" calls the edge type-only. It is
// not: `import "../model/consts.js"` binds no names precisely because it exists
// for its runtime effect, and it is the one import form that cannot be
// counted out of existence.
import "../model/consts.js";
import type { Shape } from "../model/types.js";

export function register(shape: Shape): string {
  return shape.kind;
}
