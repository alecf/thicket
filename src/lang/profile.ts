/**
 * Everything the language-neutral pipeline needs to ask about one language.
 *
 * Clustering, the module graph, ranking and the cache work on token streams,
 * paths and counts. The rules that make a report short enough to act on do
 * not: each one names syntax kinds of a particular language. This interface
 * collects those rules in one place, so a second language is a second profile
 * rather than an edit to every rule. See `docs/plans/2026-10-01-multi-language.md`.
 *
 * A missing answer here does not fail. It reads as agreement. `NAME_HOLDERS`
 * once lacked JSX attributes, and every JSX finding scored "no drift" where it
 * meant "nothing to measure" (AGENTS.md §4). A new profile must answer every
 * member deliberately.
 */
export interface LanguageProfile {
  /**
   * The name a node kind is written as in the token stream.
   *
   * Feeds the hashes that make cluster ids, so it must be stable for a given
   * parser version. It need not be readable: `canonicalKind` fixes it for
   * display.
   */
  kindName(kind: number): string;
  /** True for a leaf whose text is a name. L1 α-renames these. */
  isIdentifier(kind: number): boolean;
  /** True for a leaf whose text is a value. L0 keeps it and L1 drops it. */
  isLiteral(kind: number): boolean;
  /** True for a kind that never becomes a fragment. */
  isIgnored(kind: number): boolean;

  /** Display name for a kind as the token stream spells it. */
  canonicalKind(name: string): string;
  /** True for a kind that exists only in the type system. */
  isTypeKind(name: string): boolean;

  /**
   * Kinds whose first identifier child names a field rather than binds a
   * value. `fieldNameDrift` reads these.
   */
  nameHolders: ReadonlySet<string>;
  /** The kinds `isBareCall` reasons about. */
  callSites: CallSiteVocabulary;

  /** True for a path that holds tests. */
  isTestPath(path: string): boolean;
  /** Code fence language tag for an excerpt from `path`, or "" if none. */
  fenceLanguage(path: string): string;
}

/**
 * The kinds `isBareCall` needs, as the token stream spells them.
 *
 * The algorithm in `src/report/callsite.ts` is language-neutral. It walks a
 * spine of wrappers down to one call and rejects anything carrying work of its
 * own. Which kinds are wrappers, calls and bodies is the language's answer.
 */
export interface CallSiteVocabulary {
  /** A call. The fragment must reduce to exactly one. */
  calls: ReadonlySet<string>;
  /** Kinds that only wrap the expression beneath them. */
  wrappers: ReadonlySet<string>;
  /**
   * Wrappers whose extra children are independent work rather than parts of
   * one binding. A wrapper here must have exactly one child.
   */
  bindingLists: ReadonlySet<string>;
  /** Kinds that carry a body of their own. */
  bodies: ReadonlySet<string>;
  /** Keyword tokens that are a value, though they carry no text. */
  keywordValues: ReadonlySet<string>;
  /** Parents in which a keyword value is data rather than part of an expression. */
  dataPositions: ReadonlySet<string>;
  /** Kind prefixes whose text never reaches the stream. */
  opaqueTextPrefixes: readonly string[];
}
