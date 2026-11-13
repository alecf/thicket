// `child.ts` imports `THEME` back from the file that renders it. The one user
// besides this file is `child.ts`, and nothing new has to import it.
import { renderChild } from "./child.js";

export const THEME = { color: "teal" };

export function renderParent(): string {
  return `${THEME.color}:${renderChild()}`;
}
