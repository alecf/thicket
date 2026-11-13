import { base } from "../core/base.js";
import { fmt } from "../core/fmt.js";
import { stamp } from "../core/owner.js";

export function render(): string {
  return stamp(base(fmt("App")));
}
