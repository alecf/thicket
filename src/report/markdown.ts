import type { Scope } from "../extract/scope.js";
import { compareStrings } from "../order.js";
import type { Census } from "./census.js";
import type { Dependents } from "./context.js";
import { canonicalKind } from "./kinds.js";
import { isTestMajority, type Ranked } from "./rank.js";

/** One dependency edge inside a tangle, with what it would cost to remove. */
export interface TangleEdge {
  from: string;
  to: string;
  /**
   * Import sites across the edge: one per symbol per importing file, with
   * `export … from` re-exports counted as the imports they are. NOT distinct
   * symbol names — a symbol imported in eight files counts eight times, which
   * is the point, since it is a proxy for how many edits severing the edge
   * costs.
   */
  weight: number;
  /** Files in `from` that carry it, sorted. This is the number of edits. */
  files: string[];
  /** How many of `weight` are erased at compile time. */
  erased: number;
  /** ALL of it erased, so not a runtime dependency at all. */
  typeOnly: boolean;
}

export interface CycleFinding {
  id: string;
  modules: string[];
  /**
   * Every dependency edge with both endpoints inside the SCC — the actual
   * shape of the tangle, which the module list alone cannot express. Carried
   * on the finding rather than recomputed at render time so the Markdown chart
   * and the JSON sidecar are guaranteed to describe the same graph.
   */
  edges: TangleEdge[];
  cuts: TangleEdge[];
  /**
   * Modules still mutually dependent after the suggested cuts, i.e. the
   * largest SCC that survives. Equal to `modules.length` when nothing was
   * found. Stating it is what stops "suggested cuts (1)" reading as "apply
   * this and the tangle is gone" — the first cut on a real 7-module tangle
   * detached one leaf and left the other six knotted.
   */
  residual: number;
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
  /**
   * Duplication whose copies are mostly test files, kept in a section of its
   * own so it cannot displace production findings (see `isTestMajority`).
   */
  testDuplication: Ranked[];
  cycles: CycleFinding[];
  /** Candidate count BEFORE any truncation, so "N of M" is meaningful. */
  totalFindings: number;
  /** What is in the tail the report did not print. */
  census: Census;
  /** Hard ceiling on the whole report (PRD §9.3). Omit for no ceiling. */
  budgetTokens?: number;
  /**
   * Files one finding may name before the rest are counted. Omit to name every
   * one, which is the default: a location an agent cannot look up is not a
   * finding it can act on.
   */
  maxFilesPerFinding?: number;
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

/**
 * What `L0` and `L1` mean, stated where the findings are.
 *
 * Two characters, no legend, and the most load-bearing field on a duplication
 * finding: the level decides cluster membership and therefore whether the
 * location list is complete. An agent handed a 115-copy L0 finding took 115 for
 * the total; it was 115 of ~130 occurrences of that literal shape, the rest
 * differing only in the order of two object keys. Saying so turns the location
 * list from a claimed inventory into what it is — one exact shape's copies.
 */
const LEVEL_LEGEND =
  "`L0` matches copies that are identical once formatting is normalized;" +
  " `L1` also ignores what identifiers are called. Each finding is therefore" +
  " the copies of one exact shape — a near-variant that differs by an inserted" +
  " line is a separate finding, cross-referenced as **see also** where one exists.";

/**
 * Text printed once under a section heading, before its findings.
 *
 * The tangle charts carried an unlabelled number on every arrow and no legend
 * anywhere in a 2,600-line report. A reader guesses it means imports or files;
 * it means neither, and on a real edge the difference between 12 symbols and
 * the 7 files you would actually edit is most of the estimate.
 *
 * "Import sites", not "distinct symbols", because that is what it counts: one
 * per symbol per importing file, re-exports included. The wrong name was worse
 * than no name — an agent computed distinct symbol names, mismatched the report
 * on every edge of a 26-edge tangle, and concluded the tool was broken before
 * working out what the number really was.
 */
const SECTION_PREAMBLE: Record<string, string> = {
  "## Module tangle":
    "Arrows run importer → imported. The number is import sites — one per" +
    " symbol per importing file, `export … from` re-exports included; `type`" +
    " marks an edge erased at compile time and so not a runtime dependency at" +
    " all. The dotted arrow is the suggested cut.",
  "## Duplication": LEVEL_LEGEND,
  "## Duplication in tests": LEVEL_LEGEND,
};

function sectionHeader(section: string): string[] {
  const preamble = SECTION_PREAMBLE[section];
  // Blank line after the heading: without it the first body line becomes a
  // lazy continuation of nothing in some parsers and a paragraph glued to
  // the heading in others.
  return preamble === undefined ? [section, ""] : [section, "", preamble, ""];
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
    ...input.duplication.map((r) => ({
      section: "## Duplication",
      lines: duplicationBlock(r, input.maxFilesPerFinding),
    })),
    ...input.cycles.map((c) => ({ section: "## Module tangle", lines: cycleBlock(c) })),
    // Last, so a token budget spends itself on production work first. Test
    // duplication is real -- 231 copies of a mock logger wants a helper -- but
    // it is not what the report exists to rank.
    ...input.testDuplication.map((r) => ({
      section: "## Duplication in tests",
      lines: duplicationBlock(r, input.maxFilesPerFinding),
    })),
  ];

  const emitted = selectWithinBudget(input, blocks);
  const shown = emitted.length;

  const lines = [...headerLines(input, shown)];
  let section: string | undefined;
  for (const block of emitted) {
    if (block.section !== section) {
      section = block.section;
      lines.push(...sectionHeader(section));
    }
    lines.push(...block.lines);
  }
  const shownIn = (section: string) => emitted.filter((b) => b.section === section).length;
  lines.push(
    ...omittedSection(input, {
      duplication: shownIn("## Duplication"),
      testDuplication: shownIn("## Duplication in tests"),
      cycles: shownIn("## Module tangle"),
    }),
  );

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

  // Priced against the largest count any of these lines can carry, so the
  // reservation cannot be undershot once the real counts are known.
  const fixed = [
    ...headerLines(input, input.totalFindings),
    ...omittedSection(input, {
      duplication: input.census.duplication,
      testDuplication: input.census.testDuplication,
      cycles: input.census.cycles,
    }),
  ];
  let used = estimateTokens(fixed.join("\n") + "\n");

  const out: Block[] = [];
  let section: string | undefined;
  for (const block of blocks) {
    const text = (
      block.section === section ? block.lines : [...sectionHeader(block.section), ...block.lines]
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

/**
 * What did not fit, and what it consists of.
 *
 * This replaced a single line — `… 18768 further findings omitted` — which was
 * true, unreadable, and the only thing standing between the reader and three
 * incompatible conclusions: that the codebase is a mess of cycles, that one
 * tangle is being restated thousands of times, or that the thresholds admit
 * mostly noise. A bare five-digit number argues weakly for all three. The
 * category split settles the first two in one line each, and the size
 * histogram settles the third.
 *
 * The histogram covers every candidate rather than only the omitted ones: the
 * question being answered is what kind of pile the printed findings came off,
 * and a distribution with its top forty cut out is a worse answer to that.
 */
function omittedSection(
  input: ReportInput,
  shown: { duplication: number; testDuplication: number; cycles: number },
): string[] {
  const printed = shown.duplication + shown.testDuplication + shown.cycles;
  const omitted = input.totalFindings - printed;
  if (omitted <= 0) return [];
  const c = input.census;

  const rows: [string, number, number][] = [
    ["duplication", c.duplication, shown.duplication],
    ["duplication in tests", c.testDuplication, shown.testDuplication],
    ["module tangle", c.cycles, shown.cycles],
  ];

  const lines = [
    "## Omitted",
    "",
    `${omitted} of ${input.totalFindings} findings are not shown above.` +
      ` They rank below the ones that are; this is what they consist of.`,
    "",
    "| category | candidates | shown |",
    "| --- | --- | --- |",
    ...rows.map(([label, total, seen]) => `| ${label} | ${total} | ${seen} |`),
    "",
  ];

  if (c.bands.length > 0) {
    lines.push(
      "Duplication candidates by the lines a successful extraction would remove" +
        " — the same number every finding above is ranked on:",
      "",
      "| recoverable lines | candidates |",
      "| --- | --- |",
      ...c.bands.map((b) => `| ${b.label} | ${b.count} |`),
      "",
    );
  }

  if (c.singleFile > 0) {
    // Down-weighted by the ranker rather than dropped (PRD §5.4), so this is
    // most of the tail and almost none of the top. Saying so is what stops the
    // totals reading as untouched work.
    //
    // "each within one file" rather than "inside a single file": the latter
    // reads as one particular file the report is coyly withholding the name
    // of, when what it states is a per-candidate property that holds across
    // thousands of different files.
    lines.push(
      `${c.singleFile} of those candidates repeat each within one file rather than` +
        ` across files — a different file for each — which is ranked down rather` +
        ` than excluded, so they fill the tail and rarely reach the report.`,
      "",
    );
  }

  return lines;
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
function duplicationBlock(r: Ranked, maxFiles?: number): string[] {
  const c = r.cluster;
  const tag = r.tag === "source" ? "" : ` · **[${r.tag}]**`;
  return [
    // The heading carries what a reader scans for -- the id to cite and the
    // size to judge by. Level and kind go on a line beneath it rather than
    // inflating the heading past a line's width.
    //
    // The ranker's score is not printed. It is an internal sort key, the
    // report is already emitted in score order, and two of three agents asked
    // to act on a finding named it as noise -- one noting that on an all-test
    // cross-module cluster the weights multiply to 1.0, so it silently
    // reprints the recoverable-lines figure and reads as a bug.
    `### ${c.id} · ${c.occurrences.length} copies × ~${r.linesPerCopy} lines · ` +
      `~${r.recoverableLines} lines recoverable`,
    "",
    `${c.level} · \`${canonicalKind(c.kind)}\`${tag}`,
    "",
    ...contextLines(r),
    // An AST kind alone does not say whether a finding is worth acting on;
    // deciding meant opening files, and a cluster can span a hundred of them.
    ...excerptBlock(r),
    ...formatOccurrences(r, maxFiles),
    "",
  ];
}

/**
 * Files named as dependents before they are only counted.
 *
 * Naming a handful is strictly better than counting them, because a re-export
 * barrel among them tells the reader the number is a floor rather than a total.
 */
const MAX_DEPENDENTS_NAMED = 4;

/**
 * What sits around the cluster.
 *
 * Given a report and asked whether its top finding was actionable, three
 * independent agents named the same missing fact: the finding says "here are
 * 19 identical things" and nothing about the code around them. One of those
 * clusters turned out to share a base class that already had the exact generic
 * factory methods all 19 copies reimplement -- the difference between
 * designing an abstraction and deleting overrides -- and the report knew every
 * one of them imported it.
 */
function contextLines(r: Ranked): string[] {
  const context = r.context;
  if (context === undefined) return [];
  const lines: string[] = [];


  if (context.sharedImports.length > 0) {
    // `shim.ts` → `packages/models/Base.ts` when the copies import a re-export
    // that stands in front of the real thing. Naming only the first sent an
    // agent to a nine-line `export * from` when what it needed -- the base
    // class with the factory methods all 19 copies reimplement -- was one hop
    // further on.
    const named = context.sharedImports.map((s) =>
      s.forwardsTo === undefined ? `\`${s.path}\`` : `\`${s.path}\` → \`${s.forwardsTo}\``,
    );
    lines.push(`- **every copy imports:** ${named.join(", ")}`);
  }

  for (const variant of r.variants ?? []) {
    // The percentage, not just the link: 81% alike is "the same template with
    // a field added", and a reader deciding whether to fold the two together
    // needs to know which end of the range they are looking at.
    lines.push(
      `- **see also \`${variant.id}\`:** ${Math.round(variant.similarity * 100)}% the same shape,` +
        ` ${variant.copies} more cop${variant.copies === 1 ? "y" : "ies"}`,
    );
  }

  const dependents = dependentsLine(r, context.dependents);
  if (dependents !== undefined) lines.push(dependents);
  lines.push("");
  return lines;
}

/**
 * How much of the codebase reaches into the cluster.
 *
 * The direct count alone was a floor presented as a total. On a real 19-file
 * cluster it read `5 files outside the cluster` — four co-located tests and an
 * `index.ts` — while 17 further files reached the cluster through that index.
 * An agent checked, could not reconcile 5 with what it found, and concluded the
 * number was a bug. It was not; it was half the sentence.
 *
 * Suppressed entirely for a test-majority cluster, where it is a constant
 * dressed as evidence: nothing imports a test file, so `nothing outside the
 * cluster` is guaranteed for all 115 members and says nothing about any of them.
 */
function dependentsLine(r: Ranked, d: Dependents): string | undefined {
  if (isTestMajority(r.cluster)) return undefined;
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  if (d.direct === 0) return `- **directly imported by:** nothing outside the cluster`;

  const barrels = d.barrels.map((b) => `\`${b}\``).join(", ");
  const hidden =
    d.throughBarrels === 0
      ? ""
      : `, and ${files(d.throughBarrels)} more through ${barrels}`;
  return `- **directly imported by:** ${files(d.direct)} outside the cluster${hidden}`;
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
 * One list item per file — `` - `src/alpha.ts:4,16` `` — rather than per
 * occurrence. A reader following up on a cluster opens files, not offsets.
 *
 * A list rather than a run of space-separated paths on one line: six of these
 * paths is already several hundred characters, and Markdown renders that as a
 * single justified paragraph in which no individual location can be picked
 * out. Backticks keep the punctuation in a path from being read as emphasis.
 *
 * Every location, by default. These lists were capped at six files, which cost
 * fewer tokens and made the finding unusable: "… and 13 more files" tells an
 * agent that work remains and gives it no way to find the work, so the only
 * move left is to grep for the shape by hand — which is the job the report was
 * supposed to have already done. `maxFiles` exists for callers that would
 * rather truncate than lose a whole finding to a token budget.
 */
function formatOccurrences(r: Ranked, maxFiles?: number): string[] {
  const byFile = new Map<string, number[]>();
  for (const o of r.cluster.occurrences) {
    const lines = byFile.get(o.filePath);
    if (lines) lines.push(o.line);
    else byFile.set(o.filePath, [o.line]);
  }
  const sorted = [...byFile.entries()].sort((a, b) => compareStrings(a[0], b[0]));
  const shown = maxFiles === undefined ? sorted : sorted.slice(0, maxFiles);
  const items = shown.map(([path, lines]) => {
    const unique = [...new Set(lines)].sort((a, b) => a - b);
    return `- \`${path}:${unique.join(",")}\``;
  });
  const hidden = sorted.length - shown.length;
  // Stated, never silent — the same rule the omitted-findings line follows.
  if (hidden > 0) items.push(`- … and ${hidden} more files`);
  return items;
}

function cycleBlock(cycle: CycleFinding): string[] {
  const lines = [`### ${cycle.id} · SCC of ${cycle.modules.length} modules`, ""];
  // The chart when it fits, the member list when it does not — never both, and
  // never a chart with edges left out.
  lines.push(...(mermaidCycle(cycle) ?? memberFallback(cycle)));
  lines.push(...cutLines(cycle));
  lines.push("");
  return lines;
}

/**
 * Files named individually before an edge is summarized by count.
 *
 * A one-symbol edge is one line of one file, and printing that line is the
 * whole difference between acting on the suggestion and going to grep for it.
 * Past a few files the list stops being a location and starts being a wall.
 */
const MAX_CUT_FILES_NAMED = 3;

function cutLines(cycle: CycleFinding): string[] {
  if (cycle.cuts.length === 0) {
    return [
      `- **no single edge breaks this cycle** — all ${cycle.modules.length} modules stay` +
        ` mutually dependent whichever one you remove.`,
    ];
  }

  const out = cycle.cuts.map((cut) => {
    const kind = cut.typeOnly ? " type-only" : "";
    const symbols = `${cut.weight}${kind} symbol${cut.weight === 1 ? "" : "s"}`;
    const where =
      cut.files.length <= MAX_CUT_FILES_NAMED
        ? ` in ${cut.files.map((f) => `\`${f}\``).join(", ")}`
        : ` across ${cut.files.length} files`;
    return `- **suggested cut:** \`${cut.from}\` → \`${cut.to}\` — ${symbols}${where}`;
  });

  // What is left, always. A cut that detaches one leaf and a cut that
  // dissolves the tangle read identically without this line.
  out.push(
    cycle.residual <= 1
      ? `- **leaves:** nothing — this breaks the cycle completely.`
      : `- **leaves:** ${cycle.residual} of ${cycle.modules.length} modules still mutually` +
        ` dependent.`,
  );
  return out;
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
 * Nodes are named by their module path wherever mermaid's grammar allows it —
 * `apps/web/lib -->|2273| apps/web/models` says what the chart means without a
 * legend. Only when some name in the component is not a legal bare identifier
 * does the whole chart fall back to slugs with the true path as a label.
 */
function mermaidCycle(cycle: CycleFinding): string[] | undefined {
  if (cycle.modules.length > MAX_CHART_MODULES) return undefined;
  if (cycle.edges.length > MAX_CHART_EDGES) return undefined;

  // Sorted for the id assignment and the declaration block, so the chart is a
  // pure function of the graph rather than of the order Tarjan returned the
  // component in (AGENTS.md §1).
  const modules = [...cycle.modules].sort(compareStrings);
  const id = nodeIds(modules);
  const cuts = new Set(cycle.cuts.map((c) => `${c.from} -> ${c.to}`));

  const edges = [...cycle.edges].sort(
    (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to),
  );

  // A path used as its own id already reads as itself, so declaring it again
  // would be the same string twice on two lines.
  const declarations = modules.every((m) => id.get(m) === m)
    ? []
    : modules.map((m) => `  ${id.get(m)}["${mermaidLabel(m)}"]`);

  const body = [
    "flowchart LR",
    ...declarations,
    ...edges.map((e) => {
      const from = id.get(e.from);
      const to = id.get(e.to);
      // A dotted, labelled arrow for the edge `suggestCuts` verified breaks the
      // cycle: the one thing the reader is meant to do with this picture.
      const label = edgeLabel(e);
      return cuts.has(`${e.from} -> ${e.to}`)
        ? `  ${from} -. "cut · ${label}" .-> ${to}`
        : `  ${from} -->|${label}| ${to}`;
    }),
  ];

  const fence = fenceFor(body);
  return [`${fence}mermaid`, ...body, fence, ""];
}

/**
 * `148`, `12 type`, or `5 (4 type)`.
 *
 * The middle form is the whole edge erased; the third says most of it is, which
 * is where the cheap fixes are. A real 7-module tangle printed a bare `5` for an
 * edge that was four `import type` bindings plus one runtime import in a single
 * file — relocate that file and the edge disappears, but nothing on the chart
 * suggested looking. An edge with nothing erased stays bare rather than
 * carrying `(0 type)`: annotating the majority to flag the minority is noise.
 */
function edgeLabel(e: TangleEdge): string {
  if (e.typeOnly) return `${e.weight} type`;
  return e.erased > 0 ? `${e.weight} (${e.erased} type)` : `${e.weight}`;
}

/**
 * Characters mermaid accepts in a bare flowchart node id.
 *
 * Deliberately narrower than what its grammar really takes. The set was fixed
 * by running candidate names through mermaid's own parser: everything here is
 * confirmed to parse, and the characters left out (`[`, `(`, `<`, `=`, `|`,
 * `@`, space) are confirmed to break it. `[` is not hypothetical — a Next.js
 * dynamic route directory is literally `app/[id]`, so at file granularity the
 * unguarded form would emit a chart that fails to render.
 */
const SAFE_BARE_ID = /^[A-Za-z0-9/_.-]+$/;

/**
 * Words mermaid's flowchart grammar claims for itself. `end`, `graph`,
 * `subgraph`, `click`, `style`, `class`, `classDef`, `linkStyle` and
 * `flowchart` were each confirmed to fail as a bare id; `direction`, `default`,
 * `o`, `x` and `v` parsed but are listed anyway because they are meaningful in
 * link syntax (`--o`, `--x`) and the only cost of being wrong here is a slug.
 */
const MERMAID_KEYWORDS = new Set([
  "end",
  "graph",
  "subgraph",
  "flowchart",
  "click",
  "style",
  "class",
  "classdef",
  "linkstyle",
  "direction",
  "default",
  "o",
  "x",
  "v",
]);

function isSafeBareId(name: string): boolean {
  return SAFE_BARE_ID.test(name) && !MERMAID_KEYWORDS.has(name.toLowerCase());
}

/**
 * Module name -> node id.
 *
 * All-or-nothing per chart: one unsafe name puts every node in the component on
 * slugs, because a chart that named some nodes by path and others by slug would
 * read as though the two kinds of node were different kinds of thing.
 */
function nodeIds(modules: readonly string[]): Map<string, string> {
  if (modules.every(isSafeBareId)) return new Map(modules.map((m) => [m, m]));

  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const module of modules) {
    // Legible even in the fallback: `app/[id]/page.tsx` becomes
    // `app/_id_/page.tsx`, which a reader can still match to the label.
    let slug = module.replaceAll(/[^A-Za-z0-9/_.-]/g, "_");
    if (!isSafeBareId(slug)) slug = `_${slug}`;
    // Distinct modules can slug alike (`a/b` and `a:b` both give `a_b`), and
    // two nodes sharing an id would silently merge into one, turning a cycle
    // into a self-loop. `modules` is sorted, so the suffix is deterministic.
    const base = slug;
    for (let n = 2; taken.has(slug); n++) slug = `${base}_${n}`;
    taken.add(slug);
    ids.set(module, slug);
  }
  return ids;
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
