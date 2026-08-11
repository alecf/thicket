// Every binding this takes from `api` is forwarded by `api/errors.ts` from
// `core`. So `app -> api` is routing, not a dependency: repointing the
// specifier at `core/errors.js` deletes the edge with no semantic change.
import { BadRequestError, NotFoundError } from "../api/errors.js";

export const runAction = () => {
  throw new BadRequestError();
};

export const missing = () => new NotFoundError();
