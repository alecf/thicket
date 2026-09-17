import { describe, expect, it } from "vitest";
import { isBareCall } from "../src/report/callsite.js";
import { runReport } from "../src/run.js";
import { callsiteConfig } from "./helpers.js";

/** A node in the delimited pre-order form `extractFragments` emits. */
const node = (kind: string, ...children: string[][]): string[] => [
  kind,
  ...children.flatMap((c) => ["(", ...c, ")"]),
];
const id = (name: string): string[] => [`Id:${name}`];
const str = (value: string): string[] => [`StringLiteral:"${value}"`];

/** `{ a, b }` — an argument object of shorthand properties. */
const shorthandObject = (...names: string[]): string[] =>
  node(
    "ObjectLiteralExpression",
    ...names.map((n) => node("ShorthandPropertyAssignment", id(n))),
  );

describe("isBareCall", () => {
  it("accepts a helper call bound to a local", () => {
    // Verbatim the finding this exists for: 43 route handlers each opening
    // with `const matter = await getMatterForAuth({ ctx, matterId, userId:
    // user.id })`, reported as 208 recoverable lines. They are 43 call sites
    // of a shared helper, and there is no shorter way to write a call.
    const tokens = node(
      "FirstStatement",
      node(
        "VariableDeclarationList",
        node(
          "VariableDeclaration",
          id("matter"),
          node(
            "AwaitExpression",
            node(
              "CallExpression",
              id("getMatterForAuth"),
              node(
                "ObjectLiteralExpression",
                node("ShorthandPropertyAssignment", id("ctx")),
                node("ShorthandPropertyAssignment", id("matterId")),
                node(
                  "PropertyAssignment",
                  id("userId"),
                  node("PropertyAccessExpression", id("user"), id("id")),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    expect(isBareCall(tokens)).toBe(true);
  });

  it("accepts a bare hook call with no binding", () => {
    // The second of the two the rule found on a real application:
    // `usePricingSheetTracking({ open, mode, onModeChange, livemode })`.
    const tokens = node(
      "CallExpression",
      id("usePricingSheetTracking"),
      shorthandObject("open", "mode", "onModeChange", "livemode"),
    );
    expect(isBareCall(tokens)).toBe(true);
  });

  it("accepts a helper call bound to an ANNOTATED local", () => {
    // `const matter: Matter = await getMatterForAuth({ ctx })`. The annotation
    // is part of the binding, so the fragment is still one call and nothing
    // else. Descending on "the single child that is not an identifier" rejects
    // it, because the type node is a second non-identifier child -- and
    // annotated call sites are the common case in TypeScript.
    const tokens = node(
      "FirstStatement",
      node(
        "VariableDeclarationList",
        node(
          "VariableDeclaration",
          id("matter"),
          node("TypeReference", id("Matter")),
          node(
            "AwaitExpression",
            node("CallExpression", id("getMatterForAuth"), shorthandObject("ctx", "matterId")),
          ),
        ),
      ),
    );
    expect(isBareCall(tokens)).toBe(true);
  });

  it("rejects a call whose argument carries a body", () => {
    // `useEffect(() => { ref.current = value; }, [value])` is a call at its
    // root, holds no literal, and makes exactly ONE call — so every other
    // condition here accepts it. Twenty identical copies are a custom hook
    // waiting to be written, and the statements inside the arrow are what
    // makes them extractable.
    //
    // Written with an assignment rather than a nested call deliberately. The
    // obvious version of this test, `useEffect(() => { subscribe(topic); })`,
    // passes with the body check DELETED, because the inner call trips the
    // one-call condition instead. It reported a guard that was not there.
    const tokens = node(
      "CallExpression",
      id("useEffect"),
      node(
        "ArrowFunction",
        node(
          "Block",
          node(
            "ExpressionStatement",
            node(
              "BinaryExpression",
              node("PropertyAccessExpression", id("ref"), id("current")),
              ["EqualsToken"],
              id("value"),
            ),
          ),
        ),
      ),
      node("ArrayLiteralExpression", id("value")),
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("rejects an argument list that merely contains a call", () => {
    // `{ where: eq(chatMessages.chatThreadId, threadId), columns: { id: flag } }`
    // passes every other condition: one call, no body, and no literal token.
    // It is a four-level argument list a narrower helper could absorb, and the
    // spine check is the only thing that tells the two apart.
    //
    // Written with an identifier rather than `true`. The obvious version used
    // `{ id: true }`, which now trips the keyword-value check instead, so the
    // spine guard could be deleted and this stayed green.
    const tokens = node(
      "ObjectLiteralExpression",
      node(
        "PropertyAssignment",
        id("where"),
        node("CallExpression", id("eq"), id("chatMessages"), id("threadId")),
      ),
      node(
        "PropertyAssignment",
        id("columns"),
        node("ObjectLiteralExpression", node("PropertyAssignment", id("id"), id("flag"))),
      ),
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("rejects a call configured by keyword values", () => {
    // `configure({ retries: true, cache: false, strict: true })`. `true`,
    // `false` and `null` are values, but they are keyword TOKENS rather than
    // colon-delimited literals, so the colon test alone reads this fragment as
    // carrying no configuration at all. A shared constant absorbs a repeated
    // flag block, which is exactly the work the literal check exists to
    // protect.
    const tokens = node(
      "CallExpression",
      id("configure"),
      node(
        "ObjectLiteralExpression",
        node("PropertyAssignment", id("retries"), ["TrueKeyword"]),
        node("PropertyAssignment", id("cache"), ["FalseKeyword"]),
        node("PropertyAssignment", id("strict"), ["NullKeyword"]),
      ),
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("accepts a null-coalescing default inside an argument", () => {
    // The finding this module exists for ends `userRole: user.role ?? null`.
    // A flat "contains a keyword" test rejects it and un-suppresses all 43
    // copies, which is the whole feature. `null` here is an operand of `??`,
    // not a configured value.
    const tokens = node(
      "CallExpression",
      id("getMatterForAuth"),
      node(
        "ObjectLiteralExpression",
        node("ShorthandPropertyAssignment", id("ctx")),
        node("ShorthandPropertyAssignment", id("matterId")),
        node(
          "PropertyAssignment",
          id("userRole"),
          node(
            "BinaryExpression",
            node("PropertyAccessExpression", id("user"), id("role")),
            ["QuestionQuestionToken"],
            ["NullKeyword"],
          ),
        ),
      ),
    );
    expect(isBareCall(tokens)).toBe(true);
  });

  it("rejects a call passing JSX", () => {
    // `render(<div>content</div>)`. JSX text is not a literal kind, so its
    // content never enters the stream and an L0 match cannot see it -- the
    // same hole as an interpolated template. Two calls rendering different
    // markup are one L0 cluster with no literal token between them, and the
    // children are extractable work besides.
    const tokens = node(
      "CallExpression",
      id("render"),
      node("JsxElement", node("JsxOpeningElement", id("div")), ["JsxText"], node("JsxClosingElement", id("div"))),
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("rejects a declaration list that binds more than the call", () => {
    // `const a = load(), b = fallback`. Only the first declarator holds the
    // call, so descending on "the child that holds the call" walks past the
    // second one. The whole fragment is then not one call, and the sentence
    // the report prints about it would be false.
    const tokens = node(
      "FirstStatement",
      node(
        "VariableDeclarationList",
        node("VariableDeclaration", id("a"), node("CallExpression", id("load"), id("key"))),
        node("VariableDeclaration", id("b"), id("fallback")),
      ),
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("rejects a call configured by literals", () => {
    // `createRoute({ method: 'patch', path: '/matters/:id/assignments' })` is
    // ten copies of a 27-line route declaration whose three varying constants
    // ARE the parameter list of the helper it is asking for.
    const tokens = node(
      "CallExpression",
      id("createRoute"),
      node(
        "ObjectLiteralExpression",
        node("PropertyAssignment", id("method"), str("patch")),
        node("PropertyAssignment", id("path"), str("/matters")),
      ),
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("rejects a literal whose kind arrives under a range-marker alias", () => {
    // `SyntaxKind[SyntaxKind.NumericLiteral]` is `FirstLiteralToken`, so a
    // literal check written against a list of kind NAMES misses every number
    // in the language (PRD §2.4). Testing for the colon cannot.
    const tokens = node(
      "CallExpression",
      id("retry"),
      id("task"),
      ["FirstLiteralToken:401"],
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("rejects a call passing an interpolated template", () => {
    // `TemplateHead` and its siblings are not literal kinds, so their text
    // never enters the stream and an L0 match cannot see it. Two calls passing
    // `\`user ${id} failed\`` and `\`order ${id} failed\`` are one L0 cluster
    // with no literal token between them, and calling those the same text
    // would be false.
    const tokens = node(
      "CallExpression",
      id("log"),
      node("TemplateExpression", ["TemplateHead"], node("TemplateSpan", id("id"), ["TemplateTail"])),
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("rejects a call wrapping another call", () => {
    // Two calls mean the arguments do work of their own, and work is what an
    // extraction moves.
    const tokens = node(
      "ExpressionStatement",
      node("CallExpression", id("wrap"), node("CallExpression", id("inner"), id("a"))),
    );
    expect(isBareCall(tokens)).toBe(false);
  });

  it("rejects a fragment holding no call at all", () => {
    expect(isBareCall(shorthandObject("a", "b"))).toBe(false);
    expect(isBareCall([])).toBe(false);
  });
});

describe("a report over repeated calls to one helper", () => {
  const config = callsiteConfig();

  it("leaves the call sites out and keeps the real duplication", async () => {
    const { markdown } = await runReport({ config, cache: false });
    // The control. Without it this test cannot tell suppression from an empty
    // report, and an empty report would pass it.
    expect(markdown).toContain("src/report-one.ts");
    expect(markdown).not.toContain("src/route-alpha.ts");
    // Stated, not silently dropped: the reader has to be able to find the flag.
    expect(markdown).toContain("repeated calls to shared code");
    expect(markdown).toContain("--include-call-sites");
  });

  it("would otherwise rank the call sites ABOVE the real duplication", async () => {
    // What the suppression is worth. The call sites recover 13 lines on paper
    // and the genuine clone recovers 6, so this is not a finding that would
    // have sat harmlessly at the bottom -- it takes the top slot.
    const { markdown } = await runReport({ config, cache: false, includeCallSites: true });
    expect(markdown.indexOf("src/route-alpha.ts")).toBeLessThan(
      markdown.indexOf("src/report-one.ts"),
    );
  });

  it("does not let a suppressed candidate cost a slot", async () => {
    // The re-ranking pool is the top `slots * 3` candidates, and suppression
    // used to run AFTER that slice was taken. Three bare-call clusters outrank
    // the genuine duplication in this fixture, so at one slot the whole pool
    // was suppressed and the report emitted nothing at all -- with a real
    // finding sitting one place below the cut.
    const { markdown, json } = await runReport({ config, cache: false, maxFindings: 1 });
    expect(json.duplication).toHaveLength(1);
    expect(markdown).toContain("src/report-one.ts");
  });

  it("counts findings the rule took off the page, not candidates it matched", async () => {
    // The same three bare-call clusters, read at two budgets. At forty slots
    // all three would have been printed, so all three are reported removed. At
    // one slot the pool still suppresses three, but only the highest could ever
    // have taken that slot -- the other two would have lost the truncation
    // anyway and cost the reader nothing.
    //
    // Reporting the pool count at one slot says `--include-call-sites` will
    // show three more findings. It shows one.
    const wide = await runReport({ config, cache: false });
    expect(wide.markdown).toContain("A rule removed 3 of them");
    const narrow = await runReport({ config, cache: false, maxFindings: 1 });
    expect(narrow.markdown).toContain("A rule removed 1 of them");
    expect(narrow.markdown).toContain("The 1 rule-removed candidate is");
  });

  it("gives the two settings different config hashes", async () => {
    // AGENTS.md §4b: anything that changes the finding set joins the hash, or a
    // warm cache serves an answer from settings the reader cannot see.
    const [off, on] = await Promise.all([
      runReport({ config, cache: false }),
      runReport({ config, cache: false, includeCallSites: true }),
    ]);
    expect(off.json.configHash).not.toBe(on.json.configHash);
  });
});
