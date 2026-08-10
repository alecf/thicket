// model -> pure, a value import: the runtime half of the model<->pure cycle.
import { describe } from "../pure/describe.js";

export function label(kind: string): string {
  return describe({ kind, size: 1 });
}
