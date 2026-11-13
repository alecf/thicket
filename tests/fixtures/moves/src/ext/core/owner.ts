// `stamp` calls `left-pad`, which only this package lists. The app's view
// adds no import as a home, but its package cannot load `left-pad`.
// `left-pad` is not installed. It resolves to no file, like any package.
import { readFileSync } from "fs";
import { join } from "node:path";
import pad from "left-pad";
import { render } from "../app/view.js";
import { base } from "./base.js";
import { fmt } from "./fmt.js";

export function stamp(text: string): string {
  return pad(base(fmt(text)), 8);
}

export function all(): string {
  return render() + readFileSync(join("a", "b"), "utf8");
}
