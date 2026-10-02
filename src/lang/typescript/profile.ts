import { SyntaxKind } from "typescript/unstable/ast";
import type { CallSiteVocabulary, LanguageProfile } from "../profile.js";
import { canonicalKind, isTypeKind } from "./kinds.js";

/**
 * Kinds carrying no refactoring signal, matched by enum VALUE.
 *
 * Two groups:
 *
 *  - **Import/export boilerplate**, structurally identical in every file.
 *    Without this filter the entire top of the report is `ImportDeclaration`
 *    (PRD §2.4 / §5.1).
 *  - **Binding and parameter forms**, which are not extractable at all. A
 *    destructuring pattern is a shape, not code: there is no refactor that
 *    turns two matching `ObjectBindingPattern`s into one. On a real
 *    application these took two of the top five slots, and the top one was a
 *    destructured parameter list repeated across 136 files — which is what
 *    passing the same seven things around looks like, not a duplication a
 *    reader can act on.
 *
 * Matched by value because `SyntaxKind` is reverse-mapped and range-marker
 * aliases can win the reverse lookup, so name matching silently misses cases
 * (PRD §2.4). None of these are shadowed today; keying on the value means a
 * future one cannot quietly slip through.
 */
const IGNORED_KINDS: ReadonlySet<number> = new Set<number>([
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ImportClause,
  SyntaxKind.NamedImports,
  SyntaxKind.ImportSpecifier,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.ExportSpecifier,
  SyntaxKind.NamedExports,
  SyntaxKind.ExportAssignment,
  SyntaxKind.ObjectBindingPattern,
  SyntaxKind.ArrayBindingPattern,
  SyntaxKind.BindingElement,
  SyntaxKind.Parameter,
]);

/**
 * Literal kinds, matched by enum VALUE rather than by reverse-mapped name.
 *
 * SyntaxKind is a reverse-mapped enum containing range-marker aliases, and the
 * alias can win the reverse map: `SyntaxKind[SyntaxKind.NumericLiteral]` is
 * `"FirstLiteralToken"` and `SyntaxKind[SyntaxKind.NoSubstitutionTemplateLiteral]`
 * is `"FirstTemplateToken"`. A `name.endsWith("Literal")` test therefore misses
 * both, which drops their values from the L0 token stream and leaves L0 -- the
 * level whose whole job is exactness -- unable to tell `scale(p, 2)` from
 * `scale(p, 3)`. That is a false-positive generator, not a cosmetic slip.
 */
const LITERAL_KINDS: ReadonlySet<number> = new Set<number>([
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.RegularExpressionLiteral,
]);

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
const NAME_HOLDERS: ReadonlySet<string> = new Set([
  "PropertyAssignment",
  "PropertyDeclaration",
  "PropertySignature",
  "ShorthandPropertyAssignment",
  "MethodDeclaration",
  "MethodSignature",
  "EnumMember",
  "JsxAttribute",
]);

const CALL_SITES: CallSiteVocabulary = {
  calls: new Set(["CallExpression", "NewExpression"]),

  /**
   * Spelled as they arrive in the token stream, which is `SyntaxKind`'s
   * REVERSE mapping and therefore carries range-marker aliases:
   * `VariableStatement` arrives as `FirstStatement`, because the two share an
   * enum value and the alias wins the reverse lookup (PRD §2.4). Both
   * spellings are listed. Elsewhere the rule is to match by enum value, but by
   * the time a fragment is a token stream the value is gone and the name is
   * all there is.
   */
  wrappers: new Set([
    "VariableStatement",
    "FirstStatement",
    "VariableDeclarationList",
    "VariableDeclaration",
    "AwaitExpression",
    "ExpressionStatement",
    "ReturnStatement",
    "ParenthesizedExpression",
  ]),

  /**
   * `const a = load(), b = fallback` has a single call-bearing declarator, so
   * the descent would walk straight past `b` and call the whole statement one
   * call. Every other wrapper's siblings are the binding's name, its type, or
   * a modifier.
   */
  bindingLists: new Set(["VariableDeclarationList"]),

  /**
   * The condition that keeps the rule narrow. `useEffect(() => { … }, [dep])`
   * is a call at its root and carries no literal, and twenty identical copies
   * of one are a custom hook waiting to be written. What makes them
   * extractable is the statements inside the arrow, so any fragment holding a
   * body is left alone.
   */
  bodies: new Set([
    "Block",
    "ArrowFunction",
    "FunctionExpression",
    "FunctionDeclaration",
    "ClassDeclaration",
    "ClassExpression",
    "MethodDeclaration",
  ]),

  /**
   * `undefined` is deliberately absent. TypeScript parses it as an ordinary
   * `Identifier`, so it is already covered.
   */
  keywordValues: new Set(["TrueKeyword", "FalseKeyword", "NullKeyword"]),

  /**
   * Position is the whole rule, and testing for the keyword alone is wrong in
   * both directions. `configure({ retries: true, cache: false })` is a
   * constant argument a shared object absorbs, so it is not a bare call. But
   * `getMatterForAuth({ userRole: user.role ?? null })` -- the 43-copy finding
   * the rule exists for -- is a null-coalescing default inside an expression,
   * not configuration, and a flat "contains a keyword" test un-suppressed it.
   *
   * Keywords are no threat to soundness either way, which is why this is
   * about discrimination and not about safety. `TrueKeyword` and
   * `FalseKeyword` are different tokens, so unlike template and JSX text, L0
   * can already tell two copies apart by them.
   */
  dataPositions: new Set([
    "PropertyAssignment",
    "CallExpression",
    "NewExpression",
    "ArrayLiteralExpression",
  ]),

  /**
   * `TemplateHead` and `JsxText` are not in `LITERAL_KINDS`, so their content
   * is dropped entirely and an L0 match cannot see it. Two calls passing
   * `` `user ${id} failed` `` and `` `order ${id} failed` ``, or
   * `render(<div>a</div>)` and `render(<div>b</div>)`, are one L0 cluster with
   * no literal token between them.
   *
   * Prefixes rather than a list of kinds, which is what keeps a kind nobody
   * thought of from slipping through. JSX children are substantive work
   * besides, exactly as an arrow function's body is.
   */
  opaqueTextPrefixes: ["Template", "Jsx"],
};

/**
 * Anchored on a path separator and on a dot so that `latest/` and `attest.ts`
 * -- ordinary source names containing the substring "test" -- are not
 * mistaken for tests and silently down-weighted out of the report.
 */
const TEST_PATTERN = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)(__tests__|tests?)\/)/;

/** Language tags by extension, for the excerpt's fence. */
const FENCE_LANGUAGE: ReadonlyMap<string, string> = new Map([
  ["ts", "ts"],
  ["mts", "ts"],
  ["cts", "ts"],
  ["tsx", "tsx"],
  ["js", "js"],
  ["mjs", "js"],
  ["cjs", "js"],
  ["jsx", "jsx"],
]);

export const typescript: LanguageProfile = {
  kindName: (node) => SyntaxKind[node.kind] ?? `Unknown${node.kind}`,
  isIdentifier: (kind) => kind === SyntaxKind.Identifier,
  isLiteral: (kind) => LITERAL_KINDS.has(kind),
  isIgnored: (kind) => IGNORED_KINDS.has(kind),
  canonicalKind,
  isTypeKind,
  nameHolders: NAME_HOLDERS,
  callSites: CALL_SITES,
  isTestPath: (path) => TEST_PATTERN.test(path),
  fenceLanguage: (path) => FENCE_LANGUAGE.get(path.split(".").pop() ?? "") ?? "",
};
