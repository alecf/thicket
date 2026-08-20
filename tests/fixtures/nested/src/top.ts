// Four files at four different directory depths. A fixed depth folds the
// deeper ones into the shallower; `dir` gives each its own module.
import { one } from "./a/one.js";
export const top = (): number => one() + 1;
