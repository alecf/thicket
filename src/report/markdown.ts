import type { Scope } from "../extract/scope.js";
import { compareStrings } from "../order.js";
import { canonicalKind } from "./kinds.js";
import type { Ranked } from "./rank.js";

export interface CycleFinding {
  id: string;
  modules: string[];
  /**
   * Every dependency edge with both endpoints inside the SCC — the actual
   * shape of the tangle, which the module list alone cannot express. Carried
   * on the finding rather than recomputed at render time so the Markdown chart
   * and the JSON sidecar are guaranteed to describe the same graph.
   */
  edges: { from: string; to: string; weight: number }[];
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
      // Blank line after the heading: without it the first body line becomes a
      // lazy continuation of nothing in some parsers and a paragraph glued to
      // the heading in others.
      lines.push(section, "");
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
    const text = (
      block.section === section ? block.lines : [block.section, "", ...block.lines]
    ).join("\n");
    const cost = estimateTokens(text) + 1; // +1 for the joining newline
    if (used + cost > input.budgetTokens) break;
    used += cost;
    section = block.section;
    out.push(block);
  }
  return out;
}

/**
 * The summary as a table rather than aligned plaintext.
 *
 * The aligned form was two-space indented, which CommonMark folds into the
 * paragraph above: all six metrics rendered as one run-on line. A table is the
 * construct that actually means "label and value", and it survives being
 * pasted anywhere Markdown is rendered.
 */
function headerLines(input: ReportInput, shown: number): string[] {
  const metrics: [string, string][] = [
    [
      "analyzed",
      `${input.scope.analyzed} of ${input.scope.onDisk} source files` +
        ` (${percent(input.scope.analyzed, input.scope.onDisk)})`,
    ],
    ["duplicated mass", `${input.metrics.duplicatedMass} redundant nodes (overlapping; trend only)`],
    [
      "duplicated coverage",
      `${(input.metrics.redundantByteFraction * 100).toFixed(1)}% of source bytes`,
    ],
    ["propagation cost", input.metrics.propagationCost.toFixed(2)],
    [
      "dependency cycles",
      `${input.metrics.cycleCount} (largest SCC: ${input.metrics.largestScc} modules)`,
    ],
    ["findings", `${shown} of ${input.totalFindings} shown`],
  ];

  return [
    "# thicket report",
    "",
    `thicket ${input.version} · config ${input.configHash} · ` +
      `${input.fileCount} files / ${input.lineCount} LOC · ` +
      `granularity: ${input.granularity} (${input.moduleCount} modules)`,
    "",
    "## Summary",
    "",
    "| metric | value |",
    "| --- | --- |",
    ...metrics.map(([label, value]) => `| ${label} | ${value} |`),
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
  // A blockquote, because this is an aside that qualifies everything above it
  // rather than a section of its own -- and because it renders as one visually
  // set-apart unit wherever the report is read.
  const lines = [
    `> **⚠ ${missing} source files are outside this program.** Every number` +
      ` above is drawn from the ${percent(scope.analyzed, scope.onDisk)} that is inside it.`,
    ">",
  ];
  for (const gap of scope.gaps.slice(0, MAX_GAPS_SHOWN)) {
    const fix = gap.config === undefined ? "" : ` — \`--config ${gap.config}\``;
    lines.push(`> - \`${gap.dir}\` — ${gap.fileCount} files${fix}`);
  }
  const rest = scope.gaps.length - MAX_GAPS_SHOWN;
  if (rest > 0) lines.push(`> - … and ${rest} further directories`);
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
  const tag = r.tag === "source" ? "" : ` · **[${r.tag}]**`;
  return [
    // The heading carries what a reader scans for -- the id to cite and the
    // size to judge by. Level, kind and score go on a line beneath it rather
    // than inflating the heading past a line's width.
    `### ${c.id} · ${c.occurrences.length} copies × ~${r.linesPerCopy} lines · ` +
      `~${r.recoverableLines} lines recoverable`,
    "",
    `${c.level} · \`${canonicalKind(c.kind)}\` · score ${Math.round(r.score)}${tag}`,
    "",
    // An AST kind alone does not say whether a finding is worth acting on;
    // deciding meant opening files, and a cluster can span a hundred of them.
    ...excerptBlock(r),
    ...formatOccurrences(r),
    "",
  ];
}

/** Language tags by extension, for the excerpt's fence. */
const FENCE_LANGUAGE: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
};

/**
 * The excerpt as a fenced block, tagged with the language of the file it came
 * from.
 *
 * Fenced rather than indented: an indented code block cannot interrupt a
 * paragraph, so the four-space form was being absorbed into the location list
 * above it instead of rendering as code at all.
 */
function excerptBlock(r: Ranked): string[] {
  const excerpt = r.excerpt ?? [];
  if (excerpt.length === 0) return [];
  const extension = r.cluster.occurrences[0]?.filePath.split(".").pop() ?? "";
  const fence = fenceFor(excerpt);
  return [`${fence}${FENCE_LANGUAGE[extension] ?? ""}`, ...excerpt, fence, ""];
}

/**
 * A fence at least one backtick longer than the longest run inside the
 * content, per CommonMark. Source code contains template literals, and a
 * fragment holding a Markdown snippet would otherwise close its own block and
 * spill the rest of the report onto the page as prose.
 */
function fenceFor(lines: readonly string[]): string {
  let longest = 0;
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
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
 * One list item per file — `` - `src/alpha.ts:4,16` `` — rather than per
 * occurrence. A reader following up on a cluster opens files, not offsets.
 *
 * A list rather than a run of space-separated paths on one line: six of these
 * paths is already several hundred characters, and Markdown renders that as a
 * single justified paragraph in which no individual location can be picked
 * out. Backticks keep the punctuation in a path from being read as emphasis.
 */
function formatOccurrences(r: Ranked): string[] {
  const byFile = new Map<string, number[]>();
  for (const o of r.cluster.occurrences) {
    const lines = byFile.get(o.filePath);
    if (lines) lines.push(o.line);
    else byFile.set(o.filePath, [o.line]);
  }
  const sorted = [...byFile.entries()].sort((a, b) => compareStrings(a[0], b[0]));
  const items = sorted.slice(0, MAX_FILES_SHOWN).map(([path, lines]) => {
    const unique = [...new Set(lines)].sort((a, b) => a - b);
    const head = unique.slice(0, MAX_LINES_PER_FILE).join(",");
    const rest = unique.length - MAX_LINES_PER_FILE;
    return `- \`${path}:${head}${rest > 0 ? `+${rest}` : ""}\``;
  });
  const hidden = sorted.length - MAX_FILES_SHOWN;
  // Stated, never silent — the same rule the omitted-findings line follows.
  if (hidden > 0) items.push(`- … and ${hidden} more files`);
  return items;
}

function cycleBlock(cycle: CycleFinding): string[] {
  const lines = [`### ${cycle.id} · SCC of ${cycle.modules.length} modules`, ""];
  // The chart when it fits, the member list when it does not — never both, and
  // never a chart with edges left out.
  lines.push(...(mermaidCycle(cycle) ?? memberFallback(cycle)));
  if (cycle.cuts.length > 0) {
    lines.push(
      `- **suggested cuts (${cycle.cuts.length}):** ` +
        cycle.cuts.map((c) => `\`${c.from}\` → \`${c.to}\``).join(", "),
    );
  }
  lines.push("");
  return lines;
}

/**
 * Modules in one SCC before its chart stops being worth drawing.
 *
 * Above this a flowchart is a hairball: nothing about which edge to cut is
 * legible, and the layout costs more tokens than the module list it replaced.
 */
const MAX_CHART_MODULES = 20;

/**
 * Edges in one SCC before its chart stops being worth drawing.
 *
 * Set by token cost, not by legibility: the reader is a model, for which the
 * chart text simply is the adjacency list, so a dense graph is harder to lay
 * out but no harder to consume. 120 edges is roughly 600 tokens — a few
 * duplication findings' worth — and it is comfortably above the 61 a real
 * 12-module tangle carried. A complete digraph on `MAX_CHART_MODULES` would be
 * 380, which is where the ceiling earns its keep.
 */
const MAX_CHART_EDGES = 120;

/**
 * The tangle as a mermaid flowchart, or `undefined` when it is too large.
 *
 * All-or-nothing on purpose. Every other list in this report truncates and says
 * so, but a partial dependency chart is not a smaller true statement — drop
 * arrows from a cycle and what remains may be acyclic, so a reader would draw
 * exactly the wrong conclusion from a picture that looks complete.
 *
 * Node ids are synthetic (`m0`, `m1`, …) because module names are paths and
 * mermaid would read the slashes and dots as syntax; the real name lives in the
 * quoted label. They are assigned in sorted name order, not in the order Tarjan
 * happened to return the component, so the chart is a pure function of the
 * graph like everything else here (AGENTS.md §1).
 */
function mermaidCycle(cycle: CycleFinding): string[] | undefined {
  if (cycle.modules.length > MAX_CHART_MODULES) return undefined;
  if (cycle.edges.length > MAX_CHART_EDGES) return undefined;

  const modules = [...cycle.modules].sort(compareStrings);
  const id = new Map(modules.map((m, i) => [m, `m${i}`]));
  const cuts = new Set(cycle.cuts.map((c) => `${c.from} -> ${c.to}`));

  const edges = [...cycle.edges].sort(
    (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to),
  );

  const body = [
    "flowchart LR",
    ...modules.map((m) => `  ${id.get(m)}["${mermaidLabel(m)}"]`),
    ...edges.map((e) => {
      const from = id.get(e.from);
      const to = id.get(e.to);
      // A dotted, labelled arrow for the edge `suggestCuts` verified breaks the
      // cycle: the one thing the reader is meant to do with this picture.
      return cuts.has(`${e.from} -> ${e.to}`)
        ? `  ${from} -. "cut · ${e.weight}" .-> ${to}`
        : `  ${from} -->|${e.weight}| ${to}`;
    }),
  ];

  const fence = fenceFor(body);
  return [`${fence}mermaid`, ...body, fence, ""];
}

/**
 * Mermaid reads a bare `"` as the end of a label. `#quot;` is its own escape
 * for one, so a module whose name contains a quote renders instead of breaking
 * the rest of the chart.
 */
function mermaidLabel(module: string): string {
  return module.replaceAll('"', "#quot;");
}

/** Members named before the rest are counted, when no chart is drawn. */
const MAX_MEMBERS_SHOWN = 8;

function memberFallback(cycle: CycleFinding): string[] {
  const shown = [...cycle.modules].sort(compareStrings).slice(0, MAX_MEMBERS_SHOWN);
  const hidden = cycle.modules.length - shown.length;
  // Joined with commas, not arrows: these are the mutually reachable modules in
  // sorted order, which is not in general an edge path, and rendering them as
  // one would assert edges that may not exist.
  const members =
    shown.map((m) => `\`${m}\``).join(", ") + (hidden > 0 ? `, … and ${hidden} more` : "");
  return [
    `- **members (${cycle.modules.length}):** ${members}`,
    `- **chart omitted:** ${cycle.modules.length} modules, ${cycle.edges.length} edges` +
      ` is past what a flowchart shows usefully`,
  ];
}
