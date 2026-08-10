import { cachePathFor, openCache, type Cache } from "./cache/db.js";
import { analysisScope, type Scope } from "./extract/scope.js";
import { openProject } from "./extract/ts-adapter.js";
import { findDuplication } from "./fingerprint/cluster.js";
import { buildModuleGraph, type ModuleEdge } from "./graph/build.js";
import { propagationCost, stronglyConnected } from "./graph/metrics.js";
import { hash, initHash } from "./hash.js";
import { compareStrings } from "./order.js";
import { redundantByteFraction } from "./report/coverage.js";
import { excerptOf } from "./report/excerpt.js";
import { findingId } from "./report/findings.js";
import { canonicalKind } from "./report/kinds.js";
import { census, type Census } from "./report/census.js";
import { renderReport, type CycleFinding, type ReportInput } from "./report/markdown.js";
import { rankClusters, subsume, type Ranked } from "./report/rank.js";
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
 * Excerpt size. Three lines is usually enough to tell a genuine missing
 * abstraction from two things that merely share a shape, and at roughly 60
 * tokens per finding it is the best value per token in the report. The column
 * cap stops one minified or generated line from flooding it.
 */
const EXCERPT_LINES = 3;
const EXCERPT_COLUMNS = 100;

/**
 * Above this an exhaustive single-edge cut search stops being cheap, and a
 * tangle that large is not fixed by one cut anyway. We report no cuts rather
 * than a guess.
 */
const MAX_CUT_SEARCH_MODULES = 32;

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

    const components = stronglyConnected(graph.modules, graph.adjacency).filter(
      (c) => c.length > 1,
    );
    const cycles: CycleFinding[] = components.map((modules) => {
      const members = new Set(modules);
      return {
        id: findingId("CYC", [...modules].sort(compareStrings).join(",")),
        modules,
        // `graph.edges` is already sorted by (from, to), and filtering
        // preserves that, so the chart's arrow order is fixed by the graph.
        edges: graph.edges.filter((e) => members.has(e.from) && members.has(e.to)),
        cuts: suggestCuts(modules, graph.edges),
      };
    });

    // Excerpts are resolved only for what the report will print: the lookup
    // needs the file texts, and a cluster can span a hundred files.
    const byPath = new Map(files.map((f) => [f.path, f.sourceFile.text]));
    const emitted = ranked.slice(0, maxFindings).map((r) => {
      const first = r.cluster.occurrences[0]!;
      const text = byPath.get(first.filePath);
      if (text === undefined) return r;
      return {
        ...r,
        excerpt: excerptOf(text, first.start, first.end, {
          maxLines: EXCERPT_LINES,
          maxColumns: EXCERPT_COLUMNS,
        }),
      };
    });
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
      duplication: emitted,
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
        duplication: emitted.map((r) => ({
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
 * The lowest-weight single edge inside the SCC whose removal provably breaks
 * it, verified by re-running Tarjan on the induced subgraph. Returns nothing
 * when no single edge suffices: a suggested cut that does not break the cycle
 * costs the reader a refactor and buys nothing, so an empty list is the
 * honest answer.
 */
function suggestCuts(
  component: readonly string[],
  edges: readonly ModuleEdge[],
): { from: string; to: string }[] {
  if (component.length > MAX_CUT_SEARCH_MODULES) return [];
  const members = new Set(component);
  const inner = edges
    .filter((e) => members.has(e.from) && members.has(e.to))
    .sort(
      (a, b) =>
        a.weight - b.weight || compareStrings(a.from, b.from) || compareStrings(a.to, b.to),
    );

  for (const candidate of inner) {
    const adjacency = new Map<string, string[]>(component.map((m) => [m, []]));
    for (const e of inner) {
      if (e === candidate) continue;
      adjacency.get(e.from)!.push(e.to);
    }
    const broken = stronglyConnected(component, adjacency).every(
      (c) => c.length < component.length,
    );
    if (broken) return [{ from: candidate.from, to: candidate.to }];
  }
  return [];
}
