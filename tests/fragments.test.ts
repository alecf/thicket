import { describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { extractFragments } from "../src/fingerprint/fragments.js";
import { fixtureConfig } from "./helpers.js";

describe("extractFragments", () => {
  it("emits fragments at multiple nesting levels", async () => {
    const project = await openProject(fixtureConfig());
    const file = project.files().find((f) => f.path === "src/alpha.ts")!;
    const frags = extractFragments(file, { minNodes: 8 });
    const kinds = new Set(frags.map((f) => f.kind));
    expect(kinds.has("FunctionDeclaration")).toBe(true);
    expect(kinds.has("Block")).toBe(true);
  });

  it("never emits import/export boilerplate", async () => {
    const project = await openProject(fixtureConfig());
    for (const file of project.files()) {
      for (const f of extractFragments(file, { minNodes: 4 })) {
        expect(f.kind).not.toMatch(/^(Import|Export|Named)/);
      }
    }
  });

  it("respects the minimum node threshold", async () => {
    const project = await openProject(fixtureConfig());
    const file = project.files().find((f) => f.path === "src/alpha.ts")!;
    for (const f of extractFragments(file, { minNodes: 20 })) {
      expect(f.nodeCount).toBeGreaterThanOrEqual(20);
    }
  });

  it("records byte ranges that map back to real source", async () => {
    const project = await openProject(fixtureConfig());
    const file = project.files().find((f) => f.path === "src/alpha.ts")!;
    const frag = extractFragments(file, { minNodes: 20 })[0]!;
    const text = file.sourceFile.text.slice(frag.start, frag.end);
    expect(text.length).toBeGreaterThan(0);
    expect(frag.end).toBeGreaterThan(frag.start);
  });

  it("emits nested fragments: a Block fragment lies inside a FunctionDeclaration fragment", async () => {
    const project = await openProject(fixtureConfig());
    const file = project.files().find((f) => f.path === "src/alpha.ts")!;
    const frags = extractFragments(file, { minNodes: 8 });
    const fn = frags.find((f) => f.kind === "FunctionDeclaration")!;
    const inner = frags.find(
      (f) =>
        f.kind === "Block" && f.start >= fn.start && f.end <= fn.end && f.nodeCount < fn.nodeCount,
    );
    // Multi-granularity is the whole point: a function, the loop inside it, and
    // the conditional inside that must all be independently reported.
    expect(inner).toBeDefined();
  });

  it("captures literal values at L0 and drops them at L1, despite aliased enum names", async () => {
    // SyntaxKind is a reverse-mapped enum in which an ALIAS can win the reverse
    // map: SyntaxKind[SyntaxKind.NumericLiteral] is "FirstLiteralToken", and
    // SyntaxKind[SyntaxKind.NoSubstitutionTemplateLiteral] is
    // "FirstTemplateToken". Neither ends with "Literal", so classifying leaves
    // by their reverse-mapped NAME silently skips both -- and L0, the level
    // that is supposed to be exact, stops distinguishing `scale(p, 2)` from
    // `scale(p, 3)`. Literal kinds must be matched by enum VALUE.
    const project = await openProject(fixtureConfig());
    const file = project.files().find((f) => f.path === "src/alpha.ts")!;
    const arrow = extractFragments(file, { minNodes: 2 }).find((f) => f.kind === "ArrowFunction")!;
    expect(file.sourceFile.text.slice(arrow.start, arrow.end)).toContain("scale(p, 2)");
    expect(arrow.tokensL0.some((t) => t.endsWith(":2"))).toBe(true);
    expect(arrow.tokensL1.some((t) => t.endsWith(":2"))).toBe(false);
  });

  it("is deterministic across runs", async () => {
    const project = await openProject(fixtureConfig());
    const file = project.files().find((f) => f.path === "src/alpha.ts")!;
    const a = extractFragments(file, { minNodes: 8 }).map((f) => `${f.kind}:${f.start}:${f.end}`);
    const b = extractFragments(file, { minNodes: 8 }).map((f) => `${f.kind}:${f.start}:${f.end}`);
    expect(a).toEqual(b);
  });
});
