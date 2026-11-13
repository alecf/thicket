// Named so code-unit order (`Lists.ts` first) differs from collation order
// (`alpha.ts` first). See ORDERING_PROBE in tests/helpers.ts.
import { storeKey } from "./store.js";

export function renderList(ids: string[]): string {
  return ids.map(storeKey).join(",");
}
