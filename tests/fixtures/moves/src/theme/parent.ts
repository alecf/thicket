// `child.ts` imports `THEME` back from the file that renders it. The one user
// besides this file is `child.ts`, and nothing new has to import it.
// `THEME` reads `TEAL` through a barrel, which must never be the home.
import { renderChild } from "./child.js";
import { TEAL } from "./tokens/index.js";

export const THEME = { color: TEAL };

export function renderParent(): string {
  return `${THEME.color}:${renderChild()}`;
}
