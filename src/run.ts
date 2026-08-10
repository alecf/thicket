import { cachePathFor, openCache, type Cache } from "./cache/db.js";
import { analysisScope, type Scope } from "./extract/scope.js";
import { openProject } from "./extract/ts-adapter.js";
import { findDuplication } from "./fingerprint/cluster.js";
import { buildModuleGraph, type ModuleEdge } from "./graph/build.js";
import { fileCycles } from "./graph/file-cycles.js";
import { propagationCost, stronglyConnected } from "./graph/metrics.js";
import { hash, initHash } from "./hash.js";
import { compareStrings } from "./order.js";
import { redundantByteFraction } from "./report/coverage.js";
import { excerptOf } from "./report/excerpt.js";
import { findingId } from "./report/findings.js";
import { canonicalKind } from "./report/kinds.js";
import { extractFragments } from "./fingerprint/fragments.js";
import { census, type Census } from "./report/census.js";
import { buildImportIndex, findingContext } from "./report/context.js";
import { findVariants } from "./report/variants.js";
import { variations } from "./report/variation.js";
import { renderReport, type CycleFinding, type ReportInput } from "./report/markdown.js";
import { isTestMajority, rankClusters, subsume, type Ranked } from "./report/rank.js";
import { VERSION } from "./version.js";

export interface RunOptions {
  config: string | string[];
  minNodes?: number;
  /** Smallest fragment worth reporting, in lines. See `ExtractOptions`. */
  minLines?: number;
  granularity?: "auto" | "file" | number;
  budgetTokens?: number;
  /** Cap on findings emitted per section, before the token budget applies. */
  maxFindings?: number;
  /**
   * Files one finding may name in the Markdown before the rest are counted.
   * Unset means every one: an agent cannot open "and 13 more files".
   */
  maxLocations?: number;
  /** Analyze generated/vendored directories too (see `GENERATED_DIR_SEGMENTS`). */
  includeGenerated?: boolean;
  /**
   * Reuse `.thicket/cache.db` under the project root to skip re-walking files
   * whose content has not changed. On by default. It changes how long the run
   * takes and nothing else — the report is identical either way.
   */
  cache?: boolean;
}

export interface ReportJson {
  version: string;
  configHash: string;
  fileCount: number;
  lineCount: number;
  granularity: string;
  moduleCount: number;
  metrics: ReportInput["metrics"];
  /** What the program covered of the tree on disk, and what it missed. */
  scope: Scope;
  duplication: {
    /** THK-DUP finding id; identical to the one the Markdown prints. */
    id: string;
    /** The normalized shape hash the id is derived from. */
    shapeHash: string;
    score: number;
    tag: Ranked["tag"];
    level: string;
    kind: string;
    nodeCount: number;
    occurrences: { filePath: string; line: number; start: number; end: number }[];
  }[];
  cycles: CycleFinding[];
  /** Candidates found, before the per-section cap or the token budget. */
  totalFindings: number;
  /** The shape of the tail the Markdown summarizes rather than prints. */
  census: Census;
  /** How many of them the Markdown actually printed. */
  shownInMarkdown: number;
}

/**
 * Raised instead of emitting a report over nothing.
 *
 * "0 files / 0 LOC ... 0 findings" is a well-formed report, and a harness
 * reading it concludes the codebase is clean. There is no way for the reader
 * to tell that apart from a genuinely clean tree, which makes the empty
 * report the worst output this tool can produce -- worse than a crash. The
 * message names the configs and the three ways a run actually ends up here,
 * because the caller is usually automated and gets one line to act on.
 */
export class EmptyProjectError extends Error {
  constructor(readonly configs: string | readonly string[]) {
    const list = (Array.isArray(configs) ? configs : [configs]).join(", ");
    super(
      `no source files to analyze from: ${list} — ` +
        `a solution-style config whose "references" do not resolve, a wrong ` +
        `--config path, or an "include" that matches nothing.`,
    );
    this.name = "EmptyProjectError";
  }
}

const DEFAULT_MIN_NODES = 15;

/**
 * A node threshold does not bound the span in lines -- 15 AST nodes fit
 * comfortably on one line -- and on a real repository 28 of 40 reported
 * findings averaged under 7 lines per copy. Four lines is the smallest span
 * whose extraction can pay for itself.
 */
const DEFAULT_MIN_LINES = 4;
const DEFAULT_MAX_FINDINGS = 40;

/**
 * Excerpt size, as a share of one copy's span.
 *
 * A flat three lines was too little on exactly the findings that needed it
 * most. On a 15-line duplicated block the elided lines 4-13 were the ONLY
 * thing separating that cluster from five near-identical siblings -- the three
 * shown were the part every variant had in common -- so the excerpt showed a
 * reader the agreement and hid the disagreement. Three lines of a 100-line
 * class is still the right call, hence a fraction with a ceiling rather than a
 * bigger constant.
 */
const EXCERPT_SHARE = 0.6;

/**
 * Ceiling on that share. Ten lines is roughly 200 tokens, and a report of
 * forty findings spends about 8k tokens on excerpts -- affordable against a
 * document whose whole point is that a reader never has to open the files.
 */
const EXCERPT_LINES_MAX = 10;

/** Floor, so a shape short enough to elide nothing still shows in full. */
const EXCERPT_LINES_MIN = 3;

function excerptLines(linesPerCopy: number): number {
  const share = Math.round(linesPerCopy * EXCERPT_SHARE);
  return Math.min(EXCERPT_LINES_MAX, Math.max(EXCERPT_LINES_MIN, share));
}

/**
 * Slots the test-duplication section gets, as a share of the production
 * section's.
 *
 * Small on purpose. Test duplication is real work -- 231 copies of a mock
 * logger wants a helper -- but it is not the work this report exists to rank,
 * and a handful of entries is enough to say "your test setup has an
 * abstraction missing". Being wrong here costs a few slots in a secondary
 * section rather than reordering the report.
 */
const TEST_FINDINGS_SHARE = 8;

function testFindings(maxFindings: number): number {
  return Math.max(1, Math.round(maxFindings / TEST_FINDINGS_SHARE));
}
const EXCERPT_COLUMNS = 100;

/**
 * Above this an exhaustive single-edge cut search stops being cheap, and a
 * tangle that large is not fixed by one cut anyway. We report no cuts rather
 * than a guess.
 */
const MAX_CUT_SEARCH_MODULES = 32;

/**
 * Copies compared when working out what varies between them.
 *
 * A bound on work, not on truth: the answer is which constants differ, and a
 * shape that is parameterized by `loincCode` shows that in its first twenty
 * copies as clearly as in its hundred and fifteenth. The printed value counts
 * are therefore counts within the sample, which is why they are rendered as a
 * plain number rather than "N of N copies".
 */
const MAX_COPIES_COMPARED = 20;

/**
 * Orchestration only. Every algorithm lives in its own module; this wires
 * extract -> duplication -> rank -> graph -> render and computes the summary
 * numbers, which is the one place they can be assembled coherently.
 */
export async function runReport(
  opts: RunOptions,
): Promise<{ markdown: string; json: ReportJson }> {
  await initHash();
  const minNodes = opts.minNodes ?? DEFAULT_MIN_NODES;
  const minLines = opts.minLines ?? DEFAULT_MIN_LINES;
  const granularity = opts.granularity ?? "auto";
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const includeGenerated = opts.includeGenerated ?? false;
  // Every knob that can change the finding set belongs in the hash: two
  // reports with the same configHash must have been produced the same way.
  const configHash = hash(
    JSON.stringify({
      version: VERSION,
      minNodes,
      minLines,
      granularity: String(granularity),
      includeGenerated,
    }),
  ).slice(0, 8);

  const project = await openProject(opts.config, { includeGenerated });
  // Opened against the project root rather than the cwd, so the cache belongs
  // to the codebase being analyzed and not to wherever the tool was invoked.
  // `openCache` answers null rather than throwing on anything it cannot use.
  const cache: Cache | null =
    opts.cache === false ? null : openCache(cachePathFor(project.root), configHash);
  try {
    const files = project.files();
    if (files.length === 0) throw new EmptyProjectError(opts.config);
    let lineCount = 0;
    let totalBytes = 0;
    for (const file of files) {
      lineCount += file.sourceFile.text.split("\n").length;
      // The denominator of the coverage metric. Measured in the same UTF-16
      // code units as the occurrence offsets it will be divided into.
      totalBytes += file.sourceFile.text.length;
    }

    const scope = analysisScope(
      project.root,
      files.map((f) => f.path),
    );

    const graph = buildModuleGraph(project, { granularity });
    const clusters = subsume(await findDuplication(project, { minNodes, minLines, cache }));
    // `Cluster.id` is the normalized shape hash — the right key for grouping,
    // but not what the report speaks. Swap in the THK-DUP finding id for the
    // emitted copy so Markdown and the JSON sidecar name findings identically
    // (PRD §9.1); the shape hash survives as `shapeHash` in the JSON.
    const ranked = rankClusters(clusters, graph.moduleOf).map((r) => ({
      ...r,
      cluster: { ...r.cluster, id: findingId("DUP", r.cluster.id) },
      shapeHash: r.cluster.id,
    }));

    // Hoisted above the cycle block, which needs it to walk file-level imports.
    const byRelPath = new Map(files.map((f) => [f.path, f]));

    const components = stronglyConnected(graph.modules, graph.adjacency).filter(
      (c) => c.length > 1,
    );
    const cycles: CycleFinding[] = components.map((modules) => {
      const members = new Set(modules);
      // `graph.edges` is already sorted by (from, to), and filtering preserves
      // that, so the chart's arrow order is fixed by the graph.
      const inner = graph.edges.filter((e) => members.has(e.from) && members.has(e.to));
      const { cuts, residual } = suggestCuts(modules, inner);
      // Whether anything here is circular at the file level, which is the
      // difference between a defect and an artifact of how files were grouped.
      // Same Tarjan, one granularity down, over the files of these modules only.
      const componentFiles = files
        .map((f) => f.path)
        .filter((p) => members.has(graph.moduleOf[p] ?? ""));
      const cycles = fileCycles(
        componentFiles,
        (p) => {
          const handle = byRelPath.get(p);
          return handle === undefined ? [] : project.importsOf(handle);
        },
        (p) => graph.moduleOf[p],
      );
      return {
        id: findingId("CYC", [...modules].sort(compareStrings).join(",")),
        modules,
        edges: inner,
        cuts,
        residual,
        fileCycles: cycles,
      };
    });

    // Two sections with two budgets, rather than one ranking that has to
    // arbitrate between them. Test scaffolding took 10 of the top 40 slots on a
    // real application -- 231 copies of `{ info: vi.fn(), warn: vi.fn() }` and
    // the like -- and no setting of the test weight fixed that without also
    // discarding real findings: the score curve is smooth, so every threshold
    // was an arbitrary point on it. Splitting the sections makes the question
    // moot, because the two kinds of work no longer compete for a slot.
    const production = ranked.filter((r) => !isTestMajority(r.cluster));
    const testDuplication = ranked.filter((r) => isTestMajority(r.cluster));

    // Excerpts and surroundings are resolved only for what the report will
    // print: both need whole-project lookups, and a cluster can span a hundred
    // files.
    const byPath = new Map(files.map((f) => [f.path, f.sourceFile.text]));
    const importIndex = buildImportIndex(
      files.map((f) => f.path),
      (path) => {
        const handle = byRelPath.get(path);
        return handle === undefined ? [] : project.importsOf(handle);
      },
      (path) => {
        const handle = byRelPath.get(path);
        return handle === undefined ? [] : project.reexportsOf(handle);
      },
    );
    const decorate = <T extends (typeof ranked)[number]>(r: T): T => {
      const first = r.cluster.occurrences[0]!;
      const text = byPath.get(first.filePath);
      const context = findingContext(
        [...new Set(r.cluster.occurrences.map((o) => o.filePath))],
        importIndex,
        files.length,
      );
      if (text === undefined) return { ...r, context };
      return {
        ...r,
        context,
        excerpt: excerptOf(text, first.start, first.end, {
          maxLines: excerptLines(r.linesPerCopy),
          maxColumns: EXCERPT_COLUMNS,
        }),
      };
    };
    const emitted = production.slice(0, maxFindings).map(decorate);
    const emittedTests = testDuplication.slice(0, testFindings(maxFindings)).map(decorate);

    // Fragments re-extracted rather than read from the cache, so a warm run
    // compares exactly what a cold one does (AGENTS.md §5). Memoized per file
    // because a 115-copy cluster would otherwise re-walk 115 ASTs, and two
    // findings in one file would walk it twice.
    const fragmentsByFile = new Map<string, ReturnType<typeof extractFragments>>();
    const fragmentAt = (o: { filePath: string; start: number; end: number }) => {
      let all = fragmentsByFile.get(o.filePath);
      if (all === undefined) {
        const handle = byRelPath.get(o.filePath);
        all = handle === undefined ? [] : extractFragments(handle, { minNodes, minLines });
        fragmentsByFile.set(o.filePath, all);
      }
      return all.find((f) => f.start === o.start && f.end === o.end);
    };

    // What varies between the copies -- the parameter list of the abstraction
    // the finding is asking for. Only emitted findings pay for it.
    const varies = new Map<string, ReturnType<typeof variations>>();
    for (const r of [...emitted, ...emittedTests]) {
      const streams = r.cluster.occurrences
        .slice(0, MAX_COPIES_COMPARED)
        .map((o) => fragmentAt(o)?.tokensL0);
      if (streams.some((s) => s === undefined)) continue;
      varies.set(r.cluster.id, variations(streams as string[][]));
    }

    // Near-variants, across both sections, for the findings actually printed.
    const variants = findVariants(
      [...emitted, ...emittedTests].flatMap((r) => {
        const first = r.cluster.occurrences[0]!;
        const fragment = fragmentAt(first);
        return fragment === undefined
          ? []
          : [
              {
                id: r.cluster.id,
                tokens: fragment.tokensL1,
                occurrences: r.cluster.occurrences,
                copies: r.cluster.occurrences.length,
              },
            ];
      }),
    );
    const withVariants = <T extends { cluster: { id: string } }>(r: T): T => {
      const found = variants.get(r.cluster.id);
      const differs = varies.get(r.cluster.id);
      const out = found === undefined ? r : { ...r, variants: found };
      return differs === undefined || differs.length === 0 ? out : { ...out, varies: differs };
    };
    const duplicatedMass = ranked.reduce((sum, r) => sum + r.cluster.mass, 0);
    const totalFindings = ranked.length + cycles.length;

    const input: ReportInput = {
      version: VERSION,
      configHash,
      fileCount: files.length,
      lineCount,
      granularity: graph.granularity,
      moduleCount: graph.modules.length,
      metrics: {
        duplicatedMass,
        redundantByteFraction: redundantByteFraction(
          ranked.map((r) => r.cluster),
          totalBytes,
        ),
        propagationCost: propagationCost(graph.modules, graph.adjacency),
        cycleCount: cycles.length,
        largestScc: components.reduce((max, c) => Math.max(max, c.length), 0),
      },
      scope,
      duplication: emitted.map(withVariants),
      testDuplication: emittedTests.map(withVariants),
      cycles: cycles.slice(0, maxFindings),
      totalFindings,
      census: census(ranked, cycles.length),
      ...(opts.budgetTokens === undefined ? {} : { budgetTokens: opts.budgetTokens }),
      ...(opts.maxLocations === undefined ? {} : { maxFilesPerFinding: opts.maxLocations }),
    };

    const { markdown, shown } = renderReport(input);

    return {
      markdown,
      json: {
        version: input.version,
        configHash,
        fileCount: input.fileCount,
        lineCount,
        granularity: input.granularity,
        moduleCount: input.moduleCount,
        metrics: input.metrics,
        scope,
        duplication: [...emitted, ...emittedTests].map((r) => ({
          id: r.cluster.id,
          shapeHash: r.shapeHash,
          score: r.score,
          tag: r.tag,
          level: r.cluster.level,
          kind: canonicalKind(r.cluster.kind),
          nodeCount: r.cluster.nodeCount,
          occurrences: r.cluster.occurrences.map((o) => ({
            filePath: o.filePath,
            line: o.line,
            start: o.start,
            end: o.end,
          })),
        })),
        cycles: input.cycles,
        totalFindings,
        census: input.census,
        shownInMarkdown: shown,
      },
    };
  } finally {
    cache?.close();
    project.close();
  }
}

/**
 * The single edge whose removal dissolves the most of the SCC, with what is
 * left after it.
 *
 * The previous rule took the lowest-weight edge that broke the component at
 * all, which reliably found the LEAST interesting cut: on a real 7-module
 * tangle it proposed a one-symbol edge that detached a leaf and left the other
 * six knotted, and on a 12-module one it did the same. Cheapness is a
 * tie-break, not the objective — the objective is how much tangle the cut
 * dissolves, so every inner edge is scored by the largest SCC that survives it.
 *
 * Ties go to the cut a human would rather make: a type-only edge first, since
 * it is erased at compile time and breaking it usually means moving a types
 * file; then fewest files to edit, which is the real unit of work; then fewest
 * symbols; then name, so the result never depends on iteration order.
 *
 * Returns no cut when no single edge helps. A suggestion that does not shrink
 * the component costs the reader a refactor and buys nothing, and `residual`
 * then reports the component unchanged.
 */
function suggestCuts(
  component: readonly string[],
  inner: readonly ModuleEdge[],
): { cuts: ModuleEdge[]; residual: number } {
  const unchanged = { cuts: [], residual: component.length };
  if (component.length > MAX_CUT_SEARCH_MODULES) return unchanged;

  const candidates = [...inner].sort(
    (a, b) =>
      Number(b.typeOnly) - Number(a.typeOnly) ||
      a.files.length - b.files.length ||
      a.weight - b.weight ||
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to),
  );

  let best: { edge: ModuleEdge; residual: number } | undefined;
  for (const candidate of candidates) {
    const residual = largestSccWithout(component, inner, candidate);
    if (residual >= component.length) continue;
    // Strictly better only, so among equally dissolving cuts the cheapest
    // wins -- `candidates` is already in ascending cost order.
    if (best === undefined || residual < best.residual) best = { edge: candidate, residual };
    // Nothing can beat every module standing alone.
    if (residual <= 1) break;
  }

  return best === undefined ? unchanged : { cuts: [best.edge], residual: best.residual };
}

/** Size of the largest SCC of `component` once `omit` is removed. */
function largestSccWithout(
  component: readonly string[],
  inner: readonly ModuleEdge[],
  omit: ModuleEdge,
): number {
  const adjacency = new Map<string, string[]>(component.map((m) => [m, []]));
  for (const e of inner) {
    if (e === omit) continue;
    adjacency.get(e.from)!.push(e.to);
  }
  return stronglyConnected(component, adjacency).reduce((max, c) => Math.max(max, c.length), 0);
}
