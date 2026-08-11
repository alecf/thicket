// A package's own entry point: it forwards, but it forwards its OWN internals.
// Every import through it is 100% pass-through and dissolving it would be
// wrong -- this indirection is the package's API surface, and repointing at
// `core/errors.js` reaches past a boundary that exists on purpose. What makes
// the `api/errors.ts` case different is not that it is a barrel; it is that
// what it forwards lives in another module.
export { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
