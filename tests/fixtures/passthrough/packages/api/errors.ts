// Forwards three classes it does not define, and defines one of its own -- the
// shape of a real re-export file that four inbound edges of a 12-module tangle
// went through. The forwarding uses the `import … ; export { … }` form, which
// is not an `export … from` and so cannot be recognised by declaration kind.
import { BadRequestError, ConflictError, NotFoundError } from "../core/errors.js";

export { BadRequestError, ConflictError, NotFoundError };

export function formatError(e: Error): string {
  return e.message;
}
