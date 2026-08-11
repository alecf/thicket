// Closes a real file-level cycle with `mid`, so this SCC is not a grouping
// artifact and the fix chooser actually runs on it.
import { label } from "../mid/use.js";

export class BadRequestError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {
  readonly where = label;
}
