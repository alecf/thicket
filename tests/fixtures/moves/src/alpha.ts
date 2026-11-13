import { storeKey } from "./store.js";

export function renderItem(id: string): string {
  return `<${storeKey(id)}>`;
}
