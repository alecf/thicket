import { compareStrings } from "../order.js";
import { canonicalKind } from "./kinds.js";
import type { Ranked } from "./rank.js";

export interface CycleFinding {
  id: string;
  modules: string[];
  cuts: { from: string; to: string }[];
}

export interface ReportInput {
  version: string;
  configHash: string;
  fileCount: number;
  lineCount: number;
  granularity: string;
  moduleCount: number;
  metrics: {
    duplicatedMass: number;
    duplicatedPct: number;
    propagationCost: number;
    cycleCount: number;
    largestScc: number;
  };
  duplication: Ranked[];
  cycles: CycleFinding[];
  /** Candidate count BEFORE any truncation, so "N of M" is meaningful. */
  totalFindings: number;
  /** Hard ceiling on the whole report (PRD §9.3). Omit for no ceiling. */
  budgetTokens?: number;
}

/**
 * Chars/4. A deliberate approximation: exact tokenization would mean shipping
 * a tokenizer per consuming model, and the budget only has to be close enough
 * that a report sized for a context window fits it. Code tokenizes slightly
 * denser than 4 chars, so this errs toward over-counting, which is the safe
 * direction for a ceiling.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One finding rendered as its own block, plus the section it belongs under. */
interface Block {
  section: string;
  lines: string[];
}

export function renderMarkdown(input: ReportInput): string {
  const blocks: Block[] = [
    ...input.duplication.map((r) => ({ section: "## Duplication", lines: duplicationBlock(r) })),
    ...input.cycles.map((c) => ({ section: "## Module tangle", lines: cycleBlock(c) })),
  ];

  const emitted = selectWithinBudget(input, blocks);
  const shown = emitted.length;
  const omitted = input.totalFindings - shown;

  const lines = [...headerLines(input, shown)];
  let section: string | undefined;
  for (const block of emitted) {
    if (block.section !== section) {
      section = block.section;
      lines.push(section);
    }
    lines.push(...block.lines);
  }
  if (omitted > 0) lines.push(omittedLine(omitted));

  return lines.join("\n") + "\n";
}

/**
 * Findings are already rank-ordered, so the budget takes a prefix of them:
 * skipping an expensive finding to fit a cheaper lower-ranked one would put
 * the report out of rank order for a handful of tokens.
 *
 * Header and summary are unconditional -- a report that states its metrics and
 * no findings is useful; a report that states nothing is not -- and room for
 * the omitted-count line is reserved up front so truncation is never silent.
 */
function selectWithinBudget(input: ReportInput, blocks: readonly Block[]): Block[] {
  if (input.budgetTokens === undefined) return [...blocks];

  // Priced against the largest count either line can carry, so the reservation
  // cannot be undershot once the real counts are known.
  const fixed = [...headerLines(input, input.totalFindings), omittedLine(input.totalFindings)];
  let used = estimateTokens(fixed.join("\n") + "\n");

  const out: Block[] = [];
  let section: string | undefined;
  for (const block of blocks) {
    const text = (block.section === section ? block.lines : [block.section, ...block.lines]).join(
      "\n",
    );
    const cost = estimateTokens(text) + 1; // +1 for the joining newline
    if (used + cost > input.budgetTokens) break;
    used += cost;
    section = block.section;
    out.push(block);
  }
  return out;
}

function headerLines(input: ReportInput, shown: number): string[] {
  return [
    "# thicket report",
    `thicket ${input.version} · config ${input.configHash} · ` +
      `${input.fileCount} files / ${input.lineCount} LOC · ` +
      `granularity: ${input.granularity} (${input.moduleCount} modules)`,
    "",
    "## Summary",
    `  duplicated mass      ${input.metrics.duplicatedMass} nodes (${input.metrics.duplicatedPct.toFixed(1)}%)`,
    `  propagation cost     ${input.metrics.propagationCost.toFixed(2)}`,
    `  dependency cycles    ${input.metrics.cycleCount} (largest SCC: ${input.metrics.largestScc} modules)`,
    `  findings             ${shown} of ${input.totalFindings} shown`,
    "",
  ];
}

function omittedLine(omitted: number): string {
  return `… ${omitted} further findings omitted`;
}

function duplicationBlock(r: Ranked): string[] {
  const c = r.cluster;
  const tag = r.tag === "source" ? "" : `  [${r.tag}]`;
  return [
    `### ${c.id} · score ${Math.round(r.score)} · ${c.level} · ` +
      `${c.occurrences.length} copies × ${c.nodeCount} nodes${tag}`,
    `  ${formatOccurrences(r)}`,
    `  ${canonicalKind(c.kind)}`,
    "",
  ];
}

/**
 * `src/alpha.ts:4,16  src/beta.ts:2` — one entry per file rather than per
 * occurrence. Report tokens are the scarce resource, and a reader following up
 * on a cluster opens files, not offsets.
 */
function formatOccurrences(r: Ranked): string {
  const byFile = new Map<string, number[]>();
  for (const o of r.cluster.occurrences) {
    const lines = byFile.get(o.filePath);
    if (lines) lines.push(o.line);
    else byFile.set(o.filePath, [o.line]);
  }
  return [...byFile.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([path, lines]) => `${path}:${[...new Set(lines)].sort((a, b) => a - b).join(",")}`)
    .join("  ");
}

function cycleBlock(cycle: CycleFinding): string[] {
  const lines = [
    `### ${cycle.id} · SCC of ${cycle.modules.length} modules`,
    `  cycle: ${cycle.modules.join(" → ")}`,
  ];
  if (cycle.cuts.length > 0) {
    lines.push(
      `  suggested cuts (${cycle.cuts.length}): ` +
        cycle.cuts.map((c) => `${c.from}→${c.to}`).join(", "),
    );
  }
  lines.push("");
  return lines;
}
