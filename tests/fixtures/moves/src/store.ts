// `Lists.ts` and `alpha.ts` both import `storeKey`, and this file imports both
// of them. Cutting one edge leaves a 2-file cycle. Moving `storeKey` and its
// helper `PREFIX` to a new file removes both edges into this file at once.
import { renderList } from "./Lists.js";
import { renderItem } from "./alpha.js";

const PREFIX = "store";

export function storeKey(id: string): string {
  return `${PREFIX}:${id}`;
}

export function renderStore(ids: string[]): string {
  return renderList(ids) + renderItem(ids[0] ?? "");
}
