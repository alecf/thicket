import type { FileHandle, Node } from "../extract/types.js";
import { forEachChildSafe, safeText } from "../extract/traverse.js";
import { typescript } from "../lang/typescript/profile.js";

export interface Fragment {
  filePath: string;
  kind: string;
  nodeCount: number;
  start: number;
  end: number;
  /**
   * 1-based line of `start`. Display only — the cache and the ancestor and
   * subsumption checks all need the byte range, but a byte offset is useless
   * to the human or LLM reading the report (PRD §9.2).
   */
  line: number;
  /**
   * 1-based line of `end`. With `line` this gives the span in lines, which is
   * the unit the ranker scores in and the only size a reader can calibrate
   * against: "17 nodes" says nothing about whether this is worth a refactor.
   */
  endLine: number;
  /**
   * Pre-order ordinal of this node's parent within the file, or -1 at the top
   * level. Two occurrences sharing one are siblings under the same AST node.
   *
   * This is the signal PRD §5.4 records as missing: a 40-node object literal
   * repeated 15 times and a 40-node code block repeated 15 times are otherwise
   * identical in every feature the ranker has, and the first is a data table
   * that nobody will extract. An ordinal rather than the parent's offset
   * because `getStart()` on every node -- most of which are never emitted --
   * costs a walk the counter gives away free.
   */
  parentId: number;
  /**
   * Share of this fragment's named leaves that are literal values rather than
   * identifiers, in [0, 1].
   *
   * L1 erases literal values, so for a fragment whose content largely IS its
   * literals — a label map, a toast call, a config object — L1 equality says
   * only "same shape, different data". That is what let a 5-entry
   * `PROVIDER_LABELS` map cluster with 428 other small string maps.
   */
  literalShare: number;
  /** Token stream with identifier text preserved (L0 input). */
  tokensL0: string[];
  /** Token stream with identifier text preserved, renumbered later (L1 input). */
  tokensL1: string[];
}

export interface ExtractOptions {
  minNodes: number;
  /**
   * Smallest fragment worth reporting, in lines.
   *
   * A node threshold alone does not bound this: 15 AST nodes fit comfortably
   * on one line, and on a real repository 28 of 40 reported findings averaged
   * under 7 lines per copy. Extracting a one-line shape is a strict loss --
   * the call that replaces each copy is a line too -- so the floor removes
   * candidates no reader would act on, before they can crowd out ones they
   * would.
   *
   * Optional, defaulting to no floor, so that extraction stays a mechanism and
   * the policy lives with the depth presets that set it.
   */
  minLines?: number;
}

export function extractFragments(file: FileHandle, opts: ExtractOptions): Fragment[] {
  const out: Fragment[] = [];

  interface Result {
    nodeCount: number;
    l0: string[];
    l1: string[];
    /** Leaves whose text L0 preserves: identifiers and literal values. */
    identifiers: number;
    literals: number;
  }

  // Pre-order ordinal, handed to each node's children as their parent id.
  let counter = 0;

  const visit = (node: Node, parentId: number): Result => {
    const id = counter++;
    const kind = typescript.kindName(node.kind);
    const l0: string[] = [kind];
    const l1: string[] = [kind];
    let nodeCount = 1;
    let childCount = 0;
    let identifiers = 0;
    let literals = 0;

    forEachChildSafe(node, (child) => {
      childCount++;
      const r = visit(child, id);
      nodeCount += r.nodeCount;
      identifiers += r.identifiers;
      literals += r.literals;
      appendDelimited(l0, r.l0);
      appendDelimited(l1, r.l1);
    });

    if (childCount === 0) {
      if (typescript.isIdentifier(node.kind)) {
        const text = safeText(node);
        l0[0] = `Id:${text}`;
        l1[0] = `Id:${text}`; // renumbered fragment-locally in normalize()
        identifiers = 1;
      } else if (typescript.isLiteral(node.kind)) {
        l0[0] = `${kind}:${safeText(node)}`;
        l1[0] = kind; // L1 keeps literal KIND, drops the value
        literals = 1;
      }
    }

    if (nodeCount >= opts.minNodes && !typescript.isIgnored(node.kind)) {
      const start = node.getStart();
      const end = node.getEnd();
      const named = identifiers + literals;
      const line = file.sourceFile.getLineAndCharacterOfPosition(start).line + 1;
      const endLine = file.sourceFile.getLineAndCharacterOfPosition(end).line + 1;
      if (endLine - line + 1 >= (opts.minLines ?? 1)) {
        out.push({
          filePath: file.path,
          kind,
          nodeCount,
          start,
          end,
          line,
          endLine,
          parentId,
          literalShare: named === 0 ? 0 : literals / named,
          tokensL0: l0,
          tokensL1: l1,
        });
      }
    }
    return { nodeCount, l0, l1, identifiers, literals };
  };

  forEachChildSafe(file.sourceFile, (child) => {
    visit(child, -1);
  });
  return out;
}

/**
 * Append `child`'s tokens to `parent`, wrapped in structure markers.
 *
 * Written as a loop because `parent.push("(", ...child, ")")` passes every
 * token of `child` as a separate ARGUMENT, and a file written as one top-level
 * construct — a 5,000-line `describe()`, a large component tree — overruns
 * V8's argument limit. It surfaces as `RangeError: Maximum call stack size
 * exceeded`, which reads like runaway recursion and sends you looking for a
 * depth bound that is not the problem: across a 5,216-file application the
 * deepest AST measured 41 levels against a median of 18. The limit is on
 * WIDTH, so no traversal rewrite fixes it and no realistic depth cap trips it.
 */
function appendDelimited(parent: string[], child: readonly string[]): void {
  parent.push("(");
  for (const token of child) parent.push(token);
  parent.push(")");
}
