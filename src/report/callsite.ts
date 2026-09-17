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
 * Keyword tokens that ARE a value, though they carry no text of their own.
 *
 * `undefined` is deliberately absent. TypeScript parses it as an ordinary
 * `Identifier`, so it is already covered.
 */
const KEYWORD_VALUES: ReadonlySet<string> = new Set([
  "TrueKeyword",
  "FalseKeyword",
  "NullKeyword",
]);

/**
 * Parents in which a keyword is DATA rather than part of an expression.
 *
 * Position is the whole rule, and testing for the keyword alone is wrong in
 * both directions. `configure({ retries: true, cache: false })` is a constant
 * argument a shared object absorbs, so it is not a bare call. But
 * `getMatterForAuth({ userRole: user.role ?? null })` -- the 43-copy finding
 * this module exists for -- is a null-coalescing default inside an expression,
 * not configuration, and a flat "contains a keyword" test un-suppressed it.
 *
 * Keywords are no threat to soundness either way, which is why this is about
 * discrimination and not about safety. `TrueKeyword` and `FalseKeyword` are
 * different tokens, so unlike template and JSX text, L0 can already tell two
 * copies apart by them.
 */
const DATA_POSITIONS: ReadonlySet<string> = new Set([
  "PropertyAssignment",
  "CallExpression",
  "NewExpression",
  "ArrayLiteralExpression",
]);

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
 * True for a token whose own TEXT never reaches the stream.
 *
 * `TemplateHead` and `JsxText` are not in `LITERAL_KINDS`, so their content is
 * dropped entirely and an L0 match cannot see it. Two calls passing
 * `` `user ${id} failed` `` and `` `order ${id} failed` ``, or `render(<div>a</div>)`
 * and `render(<div>b</div>)`, are one L0 cluster with no literal token between
 * them. The "every copy is the same text" argument below is false for both.
 *
 * Matched on the prefix rather than on a list of kinds, which is what keeps a
 * kind nobody thought of from slipping through. JSX children are substantive
 * work besides, exactly as an arrow function's body is.
 */
function isOpaqueText(token: string): boolean {
  return token.startsWith("Template") || token.startsWith("Jsx");
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
 * Given L0, the conditions together say the copies are the same text and carry
 * nothing to parameterize. The fragment reduces to a single call. It binds
 * nothing besides that call. It holds no body whose statements could be
 * extracted. It carries no literal, and no template or JSX text, which differ
 * between copies without the stream showing it. And it passes no `true`,
 * `false` or `null` where data goes. What remains is N identical calls, and
 * there is no shorter way to write a call.
 *
 * Deliberately not counted here, because the list has grown twice under
 * review: each condition is named beside the code that enforces it, and a
 * number in this sentence goes stale the next time one is added.
 */
export function isBareCall(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;

  let calls = 0;
  for (const token of tokens) {
    if (CALLS.has(token)) calls += 1;
    else if (BODIES.has(token)) return false;
    else if (isOpaqueText(token)) return false;
    if (isLiteralValue(token)) return false;
  }
  // More than one call means the arguments do work of their own, which is work
  // an extraction can move. Zero means this is not a call site at all.
  if (calls !== 1) return false;

  // The call has to BE the fragment, not sit inside it. `{ where: eq(a, b),
  // columns: { id: true } }` is one call, no body and no literal — `true` is a
  // keyword, not a literal token — and it is an argument list four levels deep
  // that a narrower helper could absorb.
  //
  // Descent follows the child that HOLDS the call, rather than the child that
  // is not an identifier. A wrapper's other children are the binding's own
  // parts: the name, and the type annotation. Filtering on "not an identifier"
  // counts `const matter: Matter = await f(…)` as two candidate children and
  // rejects it, which is most of the annotated call sites in a TypeScript
  // codebase. Enumerating type node kinds instead would be a list to keep in
  // step with the language; there is exactly one call in this stream by now,
  // so asking which child contains it needs no list at all.
  const root = parse(tokens, 0)[0];
  // `true`, `false` and `null` carry no text, so the colon test above cannot
  // see them. Where one sits in a data position it is configuration, and a
  // shared constant absorbs a repeated flag block.
  if (hasKeywordConfig(root)) return false;

  let node = root;
  while (WRAPPERS.has(node.kind)) {
    // A declaration list is the one wrapper whose extra children are
    // independent work rather than parts of one binding. `const a = load(), b
    // = fallback` has a single call-bearing declarator, so the descent below
    // walks straight past `b` and calls the whole statement one call. Every
    // other wrapper's siblings are the binding's name, its type, or a
    // modifier.
    if (node.kind === "VariableDeclarationList" && node.children.length !== 1) return false;
    const inner = node.children.filter(holdsCall);
    if (inner.length !== 1) return false;
    node = inner[0]!;
  }
  return CALLS.has(node.kind);
}

function holdsCall(node: Node): boolean {
  return CALLS.has(node.kind) || node.children.some(holdsCall);
}

/** True when a `true`, `false` or `null` sits where data sits. */
function hasKeywordConfig(node: Node): boolean {
  const here = DATA_POSITIONS.has(node.kind);
  return node.children.some(
    (child) => (here && KEYWORD_VALUES.has(child.kind)) || hasKeywordConfig(child),
  );
}
