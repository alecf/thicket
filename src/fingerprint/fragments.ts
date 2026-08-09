import { SyntaxKind } from "typescript/unstable/ast";
import type { FileHandle, Node } from "../extract/types.js";
import { forEachChildSafe } from "../extract/traverse.js";

/**
 * Structurally identical in every file and carrying no refactoring signal.
 * Without this filter the entire top of the report is ImportDeclaration.
 * See PRD §2.4 / §5.1.
 */
const IGNORED_KINDS = new Set([
  "ImportDeclaration",
  "ImportClause",
  "NamedImports",
  "ImportSpecifier",
  "ExportDeclaration",
  "ExportSpecifier",
  "NamedExports",
  "ExportAssignment",
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

export interface Fragment {
  filePath: string;
  kind: string;
  nodeCount: number;
  start: number;
  end: number;
  /** Token stream with identifier text preserved (L0 input). */
  tokensL0: string[];
  /** Token stream with identifier text preserved, renumbered later (L1 input). */
  tokensL1: string[];
}

export interface ExtractOptions {
  minNodes: number;
}

export function extractFragments(file: FileHandle, opts: ExtractOptions): Fragment[] {
  const out: Fragment[] = [];

  interface Result {
    nodeCount: number;
    l0: string[];
    l1: string[];
  }

  const visit = (node: Node): Result => {
    const kind = SyntaxKind[node.kind] ?? `Unknown${node.kind}`;
    const l0: string[] = [kind];
    const l1: string[] = [kind];
    let nodeCount = 1;
    let childCount = 0;

    forEachChildSafe(node, (child) => {
      childCount++;
      const r = visit(child);
      nodeCount += r.nodeCount;
      l0.push("(", ...r.l0, ")");
      l1.push("(", ...r.l1, ")");
    });

    if (childCount === 0) {
      if (node.kind === SyntaxKind.Identifier) {
        const text = safeText(node);
        l0[0] = `Id:${text}`;
        l1[0] = `Id:${text}`; // renumbered fragment-locally in normalize()
      } else if (LITERAL_KINDS.has(node.kind)) {
        l0[0] = `${kind}:${safeText(node)}`;
        l1[0] = kind; // L1 keeps literal KIND, drops the value
      }
    }

    if (nodeCount >= opts.minNodes && !IGNORED_KINDS.has(kind)) {
      out.push({
        filePath: file.path,
        kind,
        nodeCount,
        start: node.getStart(),
        end: node.getEnd(),
        tokensL0: l0,
        tokensL1: l1,
      });
    }
    return { nodeCount, l0, l1 };
  };

  forEachChildSafe(file.sourceFile, (child) => {
    visit(child);
  });
  return out;
}

function safeText(node: Node): string {
  try {
    return node.getText();
  } catch {
    return "";
  }
}
