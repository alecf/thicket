import { SyntaxKind } from "typescript/unstable/ast";
import { compareStrings } from "../order.js";

/**
 * Alias -> canonical SyntaxKind name, derived from the enum itself at load.
 *
 * `SyntaxKind` is a reverse-mapped enum whose range markers share values with
 * real kinds, and the marker can win the reverse map: `SyntaxKind[
 * SyntaxKind.NumericLiteral]` is `"FirstLiteralToken"` and `VariableStatement`
 * comes back as `"FirstStatement"`. Fragment kinds are captured through that
 * reverse map, which is harmless for grouping (it is at least consistent) but
 * wrong in a report a human reads. Derived rather than hardcoded so a new
 * marker in a future TS build is handled without an edit here.
 */
const ALIASES: ReadonlyMap<string, string> = buildAliases();

function buildAliases(): Map<string, string> {
  const byValue = new Map<number, string[]>();
  for (const [name, value] of Object.entries(SyntaxKind)) {
    if (typeof value !== "number") continue;
    const names = byValue.get(value);
    if (names) names.push(name);
    else byValue.set(value, [name]);
  }

  const out = new Map<string, string>();
  for (const [value, names] of byValue) {
    if (names.length < 2) continue;
    // A range marker is a `First*`/`Last*` name sharing a value with a real
    // kind; the real kind is whatever is left.
    const real = names
      .filter((n) => !n.startsWith("First") && !n.startsWith("Last"))
      .sort(compareStrings);
    // Ambiguous or all-marker values keep the reverse-mapped name: guessing
    // would be worse than printing what the enum actually says.
    const canonical = real.length === 1 ? real[0]! : SyntaxKind[value];
    if (typeof canonical !== "string") continue;
    for (const name of names) if (name !== canonical) out.set(name, canonical);
  }
  return out;
}

/**
 * Display name for a fragment kind. Unknown names pass through unchanged.
 *
 * Applied at render time only: `Fragment.kind` feeds the token streams that
 * produce cluster ids, so rewriting it there would change every finding id.
 */
export function canonicalKind(kind: string): string {
  return ALIASES.get(kind) ?? kind;
}
