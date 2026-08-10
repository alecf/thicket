import type { Scope } from "../extract/scope.js";
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
    /**
     * Σ nodeCount × (copies − 1) over the reported clusters. Clusters overlap,
     * so this double counts and is NOT a fraction of anything — it is a trend
     * number. The coverage figure below is the one that means "how much of the
     * codebase is redundant".
     */
    duplicatedMass: number;
    /** Fraction in [0, 1] of source bytes covered by a redundant occurrence. */
    redundantByteFraction: number;
    propagationCost: number;
    cycleCount: number;
    largestScc: number;
  };
  /** How much of the tree on disk this program actually covered. */
  scope: Scope;
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
  return renderReport(input).markdown;
}

/**
 * The rendered report plus how many findings actually survived the budget.
 * The count is not derivable from the input — a JSON sidecar that claimed the
 * Markdown showed everything it was handed would be the same silent-truncation
 * lie the omitted-count line exists to prevent.
 */
export function renderReport(input: ReportInput): { markdown: string; shown: number } {
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

  return { markdown: lines.join("\n") + "\n", shown };
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
    `  analyzed             ${input.scope.analyzed} of ${input.scope.onDisk} source files` +
      ` (${percent(input.scope.analyzed, input.scope.onDisk)})`,
    `  duplicated mass      ${input.metrics.duplicatedMass} redundant nodes (overlapping; trend only)`,
    `  duplicated coverage  ${(input.metrics.redundantByteFraction * 100).toFixed(1)}% of source bytes`,
    `  propagation cost     ${input.metrics.propagationCost.toFixed(2)}`,
    `  dependency cycles    ${input.metrics.cycleCount} (largest SCC: ${input.metrics.largestScc} modules)`,
    `  findings             ${shown} of ${input.totalFindings} shown`,
    "",
    ...scopeWarning(input.scope),
  ];
}

/** Gaps listed before the report is believed, capped so it stays a warning. */
const MAX_GAPS_SHOWN = 5;

/**
 * The block that says the report is partial, and how to make it whole.
 *
 * Placed above the findings rather than below them because it changes what
 * every number beneath it means. A run over 2.8% of a monorepo reported zero
 * dependency cycles and a propagation cost of 0.05; both were artifacts of the
 * missing 97%, and nothing in the report said so.
 */
function scopeWarning(scope: Scope): string[] {
  if (scope.complete) return [];
  const missing = scope.onDisk - scope.analyzed;
  const lines = [
    `⚠ ${missing} source files are outside this program. Every number above is` +
      ` drawn from the ${percent(scope.analyzed, scope.onDisk)} that is inside it.`,
  ];
  for (const gap of scope.gaps.slice(0, MAX_GAPS_SHOWN)) {
    const fix = gap.config === undefined ? "" : `  → --config ${gap.config}`;
    lines.push(`    ${gap.dir}  ${gap.fileCount} files${fix}`);
  }
  const rest = scope.gaps.length - MAX_GAPS_SHOWN;
  if (rest > 0) lines.push(`    … and ${rest} further directories`);
  lines.push("");
  return lines;
}

function percent(part: number, whole: number): string {
  if (whole === 0) return "100%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function omittedLine(omitted: number): string {
  return `… ${omitted} further findings omitted`;
}

/**
 * `12 copies × ~34 lines · ~370 lines recoverable`.
 *
 * Lines, not the AST node count the ranker used to print. A reader cannot
 * calibrate "17 nodes" — it is 4 lines here and 11 lines two findings down —
 * and calibration is the whole question they are asking: three duplicated
 * lines are not worth a refactor and thirty are. `recoverable` states the
 * prize directly, so the reader never has to multiply anything to compare two
 * findings.
 */
function duplicationBlock(r: Ranked): string[] {
  const c = r.cluster;
  const tag = r.tag === "source" ? "" : `  [${r.tag}]`;
  return [
    `### ${c.id} · score ${Math.round(r.score)} · ${c.level} · ` +
      `${c.occurrences.length} copies × ~${r.linesPerCopy} lines · ` +
      `~${r.recoverableLines} lines recoverable${tag}`,
    `  ${formatOccurrences(r)}`,
    `  ${canonicalKind(c.kind)}`,
    "",
  ];
}

/**
 * Files one finding may name before the rest are summarized.
 *
 * Unbounded, a single finding listed 429 paths — thousands of tokens for one
 * entry, in a report whose whole job is fitting a context window. Six is
 * enough to see the shape of where a cluster lives; a reader who needs the
 * remaining sites has the JSON sidecar, which is never truncated.
 */
const MAX_FILES_SHOWN = 6;

/**
 * Line numbers listed for any one file before the rest are counted.
 *
 * Capping files alone is not enough: a shape repeated 200 times inside a
 * single file renders as one path followed by 200 comma-separated line
 * numbers, which is the same budget blowout in a different shape.
 */
const MAX_LINES_PER_FILE = 8;

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
  const sorted = [...byFile.entries()].sort((a, b) => compareStrings(a[0], b[0]));
  const shown = sorted
    .slice(0, MAX_FILES_SHOWN)
    .map(([path, lines]) => {
      const unique = [...new Set(lines)].sort((a, b) => a - b);
      const head = unique.slice(0, MAX_LINES_PER_FILE).join(",");
      const rest = unique.length - MAX_LINES_PER_FILE;
      return `${path}:${head}${rest > 0 ? `+${rest}` : ""}`;
    })
    .join("  ");
  const hidden = sorted.length - MAX_FILES_SHOWN;
  // Stated, never silent — the same rule the omitted-findings line follows.
  return hidden > 0 ? `${shown}  … and ${hidden} more files` : shown;
}

function cycleBlock(cycle: CycleFinding): string[] {
  const lines = [
    `### ${cycle.id} · SCC of ${cycle.modules.length} modules`,
    // `members:`, not `cycle:` — these are the mutually reachable modules in
    // sorted order, which is not in general an edge path. Labelling the join
    // as a cycle would assert edges we never checked; the verified claim is
    // the cut below it.
    `  members: ${cycle.modules.join(" → ")}`,
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
