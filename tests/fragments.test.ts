import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("never emits binding patterns or parameters", async () => {
    // A destructuring pattern is a shape, not code: no refactor turns two
    // matching ObjectBindingPatterns into one. On a real application these
    // took two of the top five report slots, the largest being a destructured
    // parameter list repeated across 136 files -- which is what passing the
    // same seven things around looks like, not an actionable duplication.
    const dir = await mkdtemp(join(tmpdir(), "thicket-bind-"));
    try {
      await writeFile(
        join(dir, "bind.ts"),
        `export function run({ alpha, beta, gamma, delta, epsilon, zeta, eta }:\n` +
          `  { alpha: number; beta: number; gamma: number; delta: number;\n` +
          `    epsilon: number; zeta: number; eta: number }) {\n` +
          `  return alpha + beta + gamma + delta + epsilon + zeta + eta;\n}\n`,
      );
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { noEmit: true }, include: ["bind.ts"] }),
      );
      const project = await openProject(join(dir, "tsconfig.json"));
      const file = project.files().find((f) => f.path === "bind.ts")!;
      const frags = extractFragments(file, { minNodes: 4 });
      const kinds = new Set(frags.map((f) => f.kind));
      // The enclosing function is still a fragment; only the pattern is gone.
      expect(kinds.has("FunctionDeclaration")).toBe(true);
      expect(kinds.has("ObjectBindingPattern")).toBe(false);
      expect(kinds.has("Parameter")).toBe(false);
      project.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
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

  it("records 1-based line numbers that match the source", async () => {
    // A byte offset is close to useless in a report a human or an LLM reads;
    // every reference needs a line (PRD §9.2). `normalizeAlpha` is declared on
    // line 4 of the fixture.
    const project = await openProject(fixtureConfig());
    const file = project.files().find((f) => f.path === "src/alpha.ts")!;
    const frags = extractFragments(file, { minNodes: 8 });
    const fn = frags.find((f) => f.kind === "FunctionDeclaration")!;
    expect(fn.line).toBe(4);
    for (const f of frags) {
      const before = file.sourceFile.text.slice(0, f.start);
      expect(f.line).toBe(before.split("\n").length);
    }
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

  it("extracts from a file far larger than the argument limit", async () => {
    // `l0.push("(", ...r.l0, ")")` passes every token of a child's stream as a
    // separate ARGUMENT. A file's top-level token stream is one entry per AST
    // node, so the spread blows V8's argument limit -- reported as "Maximum
    // call stack size exceeded", which reads like runaway recursion and is not.
    //
    // The distinction matters because it points at the wrong fix: measured
    // across a 5,216-file application, the deepest AST is 41 levels and the
    // median is 18. Depth is never the problem; SIZE is. This fixture is
    // shallow and merely long, so it fails only for the real reason.
    //
    // The statements are wrapped in ONE top-level call because
    // `extractFragments` visits each top-level statement separately: a flat
    // file of 20k sibling statements never accumulates a large stream and
    // passes even unfixed. The shape that actually breaks is a whole file
    // inside a single construct -- exactly how a 5,000-line `describe()` test
    // file is written.
    const dir = await mkdtemp(join(tmpdir(), "thicket-big-"));
    try {
      const body = Array.from(
        { length: 20_000 },
        (_, i) => `  const v${i} = { id: ${i}, name: "n${i}" };`,
      ).join("\n");
      await writeFile(join(dir, "big.ts"), `describe("everything", () => {\n${body}\n});\n`);
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { noEmit: true }, include: ["big.ts"] }),
      );

      const project = await openProject(join(dir, "tsconfig.json"));
      const file = project.files().find((f) => f.path === "big.ts")!;
      const frags = extractFragments(file, { minNodes: 6 });
      // Assert the extraction is real, not merely non-throwing: one fragment
      // per object literal. A guard that swallowed the file would pass a bare
      // "does not throw".
      expect(frags.filter((f) => f.kind === "ObjectLiteralExpression").length).toBe(20_000);
      project.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
