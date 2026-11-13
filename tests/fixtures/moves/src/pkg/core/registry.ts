// Packages `a` and `b` both import `tagged`, and neither can import the
// other. So no file of theirs can hold it, and it goes to a new file here.
import { renderA } from "../a/view.js";
import { renderB } from "../b/view.js";

const TAG = "core";

export function tagged(text: string): string {
  return `${TAG}:${text}`;
}

export function renderAll(): string {
  return renderA() + renderB();
}
