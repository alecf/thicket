// Imports only through `core`'s own entry point, so this edge is 100%
// pass-through -- and it must NOT be dissolved, because what `core/index.ts`
// forwards lives in `core`. Repointing at `core/errors.js` would reach past a
// boundary that exists on purpose.
import { ConflictError } from "../core/index.js";

export const label = "mid";
export const conflict = () => new ConflictError();
