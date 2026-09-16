/**
 * Whether a fragment is nothing but a call to code that already exists.
 *
 * The one case where the report is not merely ranked badly but wrong. On a
 * real application a finding read "43 copies × ~6 lines · ~208 lines
 * recoverable" over 43 route handlers that each say:
 *
 *     const matter = await getMatterForAuth({ ctx, matterId, userId: user.id });
 *
 * That is not duplication. It is 43 call sites of a shared helper, which is
 * what correct reuse looks like, and a reader who checks one finding and finds
 * it already done discounts the other 58. The matcher cannot see the
 * difference, because a call to a shared function and a copy-pasted block are
 * the same shape of AST.
 *
 * The argument for excluding it is arithmetic rather than judgement, which is
 * why this is a filter and `driftWeight` is a weight. The shortest thing that
 * can replace a call is a call, so an extraction here removes no line. Every
 * condition below exists to make that argument sound.
 */

/**
 * Kinds that only wrap the expression beneath them.
 *
 * Spelled as they arrive in the token stream, which is `SyntaxKind`'s REVERSE
 * mapping and therefore carries range-marker aliases: `VariableStatement`
 * arrives as `FirstStatement`, because the two share an enum value and the
 * alias wins the reverse lookup (PRD §2.4). Both spellings are listed. Elsewhere
 * the rule is to match by enum value, but by the time a fragment is a token
 * stream the value is gone and the name is all there is.
 */
const WRAPPERS: ReadonlySet<string> = new Set([
  "VariableStatement",
  "FirstStatement",
  "VariableDeclarationList",
  "VariableDeclaration",
  "AwaitExpression",
  "ExpressionStatement",
  "ReturnStatement",
  "ParenthesizedExpression",
]);

/**
 * Kinds that carry a body of their own.
 *
 * The condition that keeps this narrow. `useEffect(() => { … }, [dep])` is a
 * call at its root and carries no literal, and twenty identical copies of one
 * are a custom hook waiting to be written. What makes them extractable is the
 * statements inside the arrow, so any fragment holding a body is left alone.
 */
const BODIES: ReadonlySet<string> = new Set([
  "Block",
  "ArrowFunction",
  "FunctionExpression",
  "FunctionDeclaration",
  "ClassDeclaration",
  "ClassExpression",
  "MethodDeclaration",
]);

const CALLS: ReadonlySet<string> = new Set(["CallExpression", "NewExpression"]);

/**
 * True for a token that carries a literal's VALUE rather than a node's kind.
 *
 * Tested by the colon rather than against a list of literal kinds, for the
 * same reason `WRAPPERS` lists two spellings: reverse-mapped aliases mean
 * `NumericLiteral` arrives as `FirstLiteralToken:401`, so a list of names
 * misses cases. A `SyntaxKind` name never contains a colon, so every token
 * holding one is either an identifier or a literal value.
 */
function isLiteralValue(token: string): boolean {
  return token.includes(":") && !token.startsWith("Id:");
}

/**
 * True for a token belonging to a template literal with substitutions.
 *
 * `TemplateHead` and its siblings are not in `LITERAL_KINDS`, so their text
 * never enters the stream at all and an L0 match cannot see it. Two calls
 * passing different template strings are therefore indistinguishable here, and
 * the "every copy is the same text" argument below would be false for them.
 */
function isTemplatePart(token: string): boolean {
  return token.startsWith("Template");
}

interface Node {
  kind: string;
  children: Node[];
}

/**
 * Rebuild the tree `appendDelimited` flattened.
 *
 * Only the spine is needed, but reading it off the flat stream means matching
 * brackets by hand at every level. Depth is bounded by the AST's, which
 * measured 41 at its deepest across a 5216-file application against a median
 * of 18, so the recursion is not the width hazard `appendDelimited` documents.
 */
function parse(tokens: readonly string[], at: number): [Node, number] {
  const kind = tokens[at] ?? "";
  let i = at + 1;
  const children: Node[] = [];
  while (tokens[i] === "(") {
    const [child, next] = parse(tokens, i + 1);
    children.push(child);
    i = next + 1;
  }
  return [{ kind, children }, i];
}

/**
 * True when the fragment is one call and nothing else.
 *
 * `tokens` is the L0 stream, and the caller must have checked the cluster is
 * L0. At L1 identifier text is erased, so `getMatterForAuth({ ctx, matterId })`
 * and `getUserForAuth({ c, uid })` are one shape — two different helpers, and
 * calling that "already reused" would be a worse error than the one this
 * fixes.
 *
 * Given L0, the four conditions together say the copies are the same text:
 * the fragment reduces to a single call, holds no body whose statements could
 * be extracted, and carries no literal or template text that could differ
 * between copies without the stream showing it. What remains is N identical
 * calls, and there is no shorter way to write a call.
 */
export function isBareCall(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;

  let calls = 0;
  for (const token of tokens) {
    if (CALLS.has(token)) calls += 1;
    else if (BODIES.has(token)) return false;
    else if (isTemplatePart(token)) return false;
    if (isLiteralValue(token)) return false;
  }
  // More than one call means the arguments do work of their own, which is work
  // an extraction can move. Zero means this is not a call site at all.
  if (calls !== 1) return false;

  // The call has to BE the fragment, not sit inside it. `{ where: eq(a, b),
  // columns: { id: true } }` is one call, no body and no literal — `true` is a
  // keyword, not a literal token — and it is an argument list four levels deep
  // that a narrower helper could absorb.
  let node = parse(tokens, 0)[0];
  while (WRAPPERS.has(node.kind)) {
    // An identifier child of a wrapper is the name it binds, not the
    // expression it wraps: `VariableDeclaration` holds `Id:matter` beside the
    // initializer.
    const inner = node.children.filter((c) => !c.kind.startsWith("Id:"));
    if (inner.length !== 1) return false;
    node = inner[0]!;
  }
  return CALLS.has(node.kind);
}
