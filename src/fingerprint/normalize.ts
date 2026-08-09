import { hash } from "../hash.js";

/**
 * Renumber identifiers by order of first appearance WITHIN THIS FRAGMENT.
 *
 * Scoping this per-file instead of per-fragment breaks the level hierarchy:
 * two identical fragments in different files receive different indices
 * depending on what preceded them, so L1 reports FEWER clusters than L0.
 * See PRD §2.5.
 */
export function alphaRename(tokens: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return tokens.map((t) => {
    if (!t.startsWith("Id:")) return t;
    const name = t.slice(3);
    let idx = seen.get(name);
    if (idx === undefined) {
      idx = seen.size;
      seen.set(name, idx);
    }
    return `Id#${idx}`;
  });
}

/** Exact: identifier text and literal values preserved. */
export function normalizeL0(tokens: readonly string[]): string {
  return hash(tokens.join(" "));
}

/** α-renamed: identifiers renumbered fragment-locally, literal values dropped. */
export function normalizeL1(tokens: readonly string[]): string {
  return hash(alphaRename(tokens).join(" "));
}
