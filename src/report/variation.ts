/**
 * What differs between the copies of one finding.
 *
 * The report said 19 classes are the same shape and stopped there. What an
 * agent asked to act on it actually needed — and spent most of its
 * investigation rebuilding by hand — was the small table of what VARIES,
 * because that is the difference between "19 similar classes" and "19 rows of a
 * config table that got compiled into classes". The second phrasing hands you
 * the abstraction: a base class with six static fields.
 *
 * It also finds things nobody was looking for. Extracting those constants by
 * hand is how that agent noticed two of the nineteen declared the same LOINC
 * code — a live query-correctness bug, unrelated to the duplication, that a
 * list of varying values makes impossible to miss.
 */
export interface Variation {
  /**
   * What to look for in the excerpt: the nearest identifier that is the SAME in
   * every copy, which for `static readonly loincCode = "39156-5"` is
   * `loincCode`.
   */
  label: string;
  /** Distinct values it takes across the copies COMPARED, not across all. */
  values: number;
  /**
   * True when every compared copy differed, so `values` is a floor.
   *
   * The caller compares a bounded sample. When the count saturates, a bare
   * number reads as a measurement and means the opposite of the truth: on a
   * real report `103 copies · description (20)` said "a small enumerable
   * parameter set — build a table", when there were 101 distinct descriptions
   * and the only sound design keeps it a free parameter. Rendered `≥20`.
   */
  saturated: boolean;
}

/** Varying constants named before the list stops being a summary. */
const MAX_VARIATIONS = 6;

/** Label for a varying literal with no constant identifier before it. */
const UNNAMED = "an unnamed literal";

/** A leaf carrying an identifier's text, as opposed to a literal's value. */
function isIdentifier(token: string): boolean {
  return token.startsWith("Id:");
}

/**
 * `copies` are the L0 token streams of a cluster's occurrences.
 *
 * Positional comparison is sound precisely because these fragments matched at
 * L1: the streams are the same pre-order walk of the same shape, so index `i`
 * is the same syntactic slot in every copy. Streams of differing length did not
 * match at L1 and are not comparable, so they yield nothing rather than a
 * confident list of nonsense.
 */
export function variations(copies: readonly (readonly string[])[]): Variation[] {
  if (copies.length < 2) return [];
  const first = copies[0]!;
  if (copies.some((c) => c.length !== first.length)) return [];

  // Two passes. Which positions vary has to be known before any of them can be
  // labelled, because a label is only usable if it is constant everywhere --
  // an identifier that differs between copies names nothing the reader can
  // find in all of them.
  const varying: number[] = [];
  for (let i = 0; i < first.length; i++) {
    if (copies.some((c) => c[i] !== first[i])) varying.push(i);
  }
  if (varying.length === 0) return [];
  const varies = new Set(varying);

  // Literals only. An identifier that differs between copies is not a
  // parameter of the shape -- it is what L1 matching already means, and
  // reporting each renamed local under whatever identifier happens to precede
  // it buries the four constants that ARE the parameter list under a dozen
  // `x`, `y`, `sqrt`. The question is what the copies are configured with, and
  // configuration is literals.
  const reportable = varying.filter((i) => copies.every((c) => !isIdentifier(c[i] ?? "")));
  if (reportable.length === 0) return [];

  // Positions grouped by label, so a two-number range under one constant reads
  // as one thing that varies rather than two.
  const positions = new Map<string, number[]>();
  for (const i of reportable) {
    const label = labelFor(first, i, varies);
    const list = positions.get(label);
    if (list) list.push(i);
    else positions.set(label, [i]);
  }

  // Insertion order is source order, which is the order the reader will meet
  // them in the excerpt -- and it is a pure function of the token stream, so
  // two runs agree (AGENTS.md §1).
  return [...positions.entries()].slice(0, MAX_VARIATIONS).map(([label, at]) => {
    // Distinct COMBINATIONS, one per copy, never more than there are copies.
    // Pooling the values of a label's positions instead would report a
    // two-position range across two copies as four values.
    const values = new Set(copies.map((c) => at.map((i) => c[i]).join("\u0000"))).size;
    // Nothing repeated within the sample, so copies not compared may add more.
    return { label, values, saturated: values === copies.length };
  });
}

function labelFor(tokens: readonly string[], at: number, varies: ReadonlySet<number>): string {
  for (let i = at - 1; i >= 0; i--) {
    if (varies.has(i)) continue;
    const token = tokens[i]!;
    if (isIdentifier(token)) return token.slice(3);
  }
  return UNNAMED;
}

/**
 * Node kinds whose first identifier child NAMES A FIELD rather than binds a
 * value: an object key, a class property, a method, an enum member, a JSX
 * attribute.
 *
 * `JsxAttribute` is here because leaving it out made the drift signal blind to
 * every JSX finding, which is where it was needed most. An attribute name is
 * an `Identifier` leaf like any other, so L1 α-renames it, and `<p role=…
 * className=…>` then matches `<Badge variant=… className=…>`. On a real
 * 5540-file application all sixteen JSX findings scored `total: 0` and kept
 * full weight; ten of them took the top of the report, and a reader asked to
 * act on them rejected them all by hand for exactly this reason. Adding it
 * removes four and moves nothing else.
 *
 * The tag name is deliberately NOT here, though `JsxOpeningElement` holds one
 * in the same position. Tried and measured: it frees six slots and surfaces
 * work the noise was burying, and it also drops two findings that are real.
 * `<AlertDialogHeader>`, `<DialogHeader>`, `<SheetHeader>` and `<CardHeader>`
 * wrapping one Title-plus-Description shape are four parallel primitives, and
 * `<div>` beside `<TabsList>` and `<SelectContent>` is a syntax template.
 * Both are four or five distinct tag names, so `fieldNameDrift` cannot
 * separate them, and three normalizations by distinct-value count and by
 * off-modal share all failed to. An attribute name carries no such ambiguity.
 */
const NAME_HOLDERS = new Set([
  "PropertyAssignment",
  "PropertyDeclaration",
  "PropertySignature",
  "ShorthandPropertyAssignment",
  "MethodDeclaration",
  "MethodSignature",
  "EnumMember",
  "JsxAttribute",
]);

/** Tokens scanned after a name holder before giving up on finding its name. */
const NAME_LOOKAHEAD = 6;

/**
 * How much of a cluster's field vocabulary differs between copies.
 *
 * The signal that separates duplication worth consolidating from duplication
 * that only looks like it. Both of these are L1 clusters with almost no exactly
 * identical members:
 *
 * - 19 observation classes whose `loincCode`, `unit` and `junctionKey` hold
 *   different strings. Same fields, different values: one concept with a
 *   parameter list, and a base class absorbs it. `varying` is 0.
 * - 193 three-field projections — `{ labOrderId: p.labOrderId, … }` beside
 *   `{ average: s.average, … }`. 89 distinct key-sets, 62 of them appearing
 *   exactly once. Different fields: these are different objects that happen to
 *   share a syntax template, and consolidating them produces a generic no
 *   future change can benefit from. `varying` equals `total`.
 *
 * Measured across the top findings of a real application, the split is total:
 * every cluster an agent judged worth refactoring had `varying = 0`, and every
 * cluster it judged not worth refactoring had `varying = total`.
 *
 * Deliberately NOT counting renamed locals. Same logic under different binding
 * names is precisely what an L1 match means, and it is extractable — only the
 * names of FIELDS say the copies are different things.
 */
export function fieldNameDrift(
  copies: readonly (readonly string[])[],
): { varying: number; total: number } {
  const none = { varying: 0, total: 0 };
  if (copies.length < 2) return none;
  const first = copies[0]!;
  if (copies.some((c) => c.length !== first.length)) return none;

  let varying = 0;
  let total = 0;
  for (const at of fieldNamePositions(first)) {
    total += 1;
    if (copies.some((c) => c[at] !== first[at])) varying += 1;
  }
  return { varying, total };
}

/** Positions of the leaf identifiers that name a field. */
function fieldNamePositions(tokens: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!NAME_HOLDERS.has(tokens[i]!)) continue;
    const limit = Math.min(tokens.length, i + NAME_LOOKAHEAD);
    for (let j = i + 1; j < limit; j++) {
      const token = tokens[j]!;
      // The name is the first identifier inside this node. Stop at a nested
      // name holder, whose identifier belongs to it and not to this one.
      if (NAME_HOLDERS.has(token)) break;
      if (isIdentifier(token)) {
        out.push(j);
        break;
      }
    }
  }
  return out;
}
