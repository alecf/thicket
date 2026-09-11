import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { cachePathFor, openCache, type Cache } from "./cache/db.js";
import { manifestProblems, workspaceGlobs } from "./extract/manifest.js";
import { analysisScope, scanSourceFiles, type ScanOptions, type Scope } from "./extract/scope.js";
import { openProject, type ExcludedCounts } from "./extract/ts-adapter.js";
import {
  configsFor,
  discoverWorkspaces,
  selectWorkspaces,
  type Workspace,
} from "./extract/workspaces.js";
import { findDuplication } from "./fingerprint/cluster.js";
import { buildModuleGraph, type ModuleEdge } from "./graph/build.js";
import { fileCycles } from "./graph/file-cycles.js";
import { propagationCost, stronglyConnected } from "./graph/metrics.js";
import { hash, initHash } from "./hash.js";
import { compareStrings } from "./order.js";
import { redundantByteFraction } from "./report/coverage.js";
import { excerptOf } from "./report/excerpt.js";
import { findingId } from "./report/findings.js";
import { canonicalKind, isTypeKind } from "./report/kinds.js";
import { extractFragments } from "./fingerprint/fragments.js";
import { census, type Census } from "./report/census.js";
import { buildImportIndex, findingContext } from "./report/context.js";
import { findVariants } from "./report/variants.js";
import { fieldNameDrift, variations } from "./report/variation.js";
import { renderReport, type CycleFinding, type ReportInput } from "./report/markdown.js";
import {
  driftWeight,
  isTestMajority,
  rankClusters,
  subsume,
  type Ranked,
} from "./report/rank.js";
import { VERSION } from "./version.js";

export interface RunOptions {
  /**
   * The tsconfigs to analyze. When absent they are discovered under `dir`:
   * every selected workspace's, or the one beside it in a plain project.
   *
   * Naming them suppresses discovery entirely, workspaces included. The caller
   * asked for something specific, and widening past it would change every
   * number in the report -- the analysis is a graph computation over the file
   * set, so a file added silently moves propagation cost, coverage and
   * clusters, not just the finding list.
   */
  config?: string | string[];
  /**
   * The directory being analyzed, and the root every repo-relative path is
   * measured from -- which is where `.thicket/cache.db` lives.
   *
   * Without it the root is `commonRootDir` of the configs actually opened,
   * which moves with the config set: `--filter` down to one workspace
   * collapses it into that workspace, putting the cache inside a subpackage
   * and renaming every path in the report. Pinning it keeps one cache at the
   * top of the tree whose rows a run of any scope can hit.
   *
   * Ignored -- with a warning through `warn` -- when a config reaches above
   * it, because a file above the root cannot be named by a repo-relative path.
   */
  dir?: string;
  /**
   * Workspace `--filter` patterns, applied in order. See `selectWorkspaces`.
   * Empty selects every discovered workspace.
   */
  filter?: readonly string[];
  /**
   * Read workspace manifests under `dir`. On by default, and its own switch:
   * turning discovery off must not turn off `--exclude` or the banner sniff
   * (AGENTS.md §4b).
   */
  workspaces?: boolean;
  /**
   * Where a line about the run itself goes -- a manifest that would not read,
   * a workspace with no tsconfig, a root that could not be pinned.
   *
   * A sink rather than a write, because nothing below `src/cli.ts` owns a
   * stream. Absent means those lines are dropped, which is right for a
   * programmatic caller and wrong for a terminal, and only the caller knows
   * which it is.
   */
  warn?: (message: string) => void;
  minNodes?: number;
  /** Smallest fragment worth reporting, in lines. See `ExtractOptions`. */
  minLines?: number;
  granularity?: "auto" | "file" | "dir" | number;
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
  /** Detect generated files by their banner comment. On by default. */
  bannerScan?: boolean;
  /**
   * Which half of the codebase to analyze.
   *
   * `include` (default) reports both: a duplicated interface and a duplicated
   * function are both complexity, and a cycle in the type system is a knot a
   * reader still has to hold in their head. `exclude` restricts to what ships
   * -- the graph that can fail at module-init time. `only` is the pass for
   * conceptual structure: three near-identical interfaces that should be one.
   */
  types?: TypesMode;
  /**
   * Globs whose files are not analyzed, matched against repo-relative paths.
   * An instruction rather than a heuristic, so `includeGenerated` leaves it in
   * force.
   */
  exclude?: readonly string[];
  /**
   * Reuse `.thicket/cache.db` under the project root to skip re-walking files
   * whose content has not changed. On by default. It changes how long the run
   * takes and nothing else — the report is identical either way.
   */
  cache?: boolean;
}

/** See `RunOptions.types`. */
export type TypesMode = "include" | "exclude" | "only";

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
  /** How many files each exclusion rule dropped from inside that program. */
  excluded: ExcludedCounts;
  /** The type-duplication section, same shape as `duplication`. */
  typeDuplication: ReportJson["duplication"];
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

/**
 * Slots the type-duplication section gets, as a share of the code section's.
 *
 * Larger than the test section's share. A duplicated type is usually a whole
 * concept declared twice rather than a body of code repeated, so a handful of
 * them is a substantial finding -- and there are far fewer of them to list: on
 * a real application, 33 groups against 4468 code candidates.
 */
const TYPE_FINDINGS_SHARE = 4;

function typeFindings(maxFindings: number): number {
  return Math.max(1, Math.round(maxFindings / TYPE_FINDINGS_SHARE));
}
const EXCERPT_COLUMNS = 100;

/**
 * Above this an exhaustive single-edge cut search stops being cheap, and a
 * tangle that large is not fixed by one cut anyway. We report no cuts rather
 * than a guess.
 */
const MAX_CUT_SEARCH_MODULES = 32;

/**
 * The most of a tangle a suggested cut may leave standing.
 *
 * A cut exists to break the tangle, not to shave a module off it. Refusing the
 * pointless cuts -- type-only edges, SCCs no file cycle underlies -- left a
 * gap: the chooser rejected the bad candidate and then reached for the next
 * one, rather than concluding it had nothing to say. On a real 9-module tangle
 * every available cut left 8 of the 9 mutually dependent, and the report
 * printed one anyway, directly above the line admitting it changed almost
 * nothing. Two thirds is the bar; a cut that eliminates the cycle outright is
 * always worth printing, however small the tangle it came from.
 */
const MAX_RESIDUAL_SHARE = 2 / 3;

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

const toPosix = (p: string) => (sep === "\\" ? p.split(sep).join("/") : p);

/** What discovery decided, and the one thing only the loaded program can judge. */
interface Discovery {
  /** Absolute tsconfig paths to open. */
  configs: string[];
  /**
   * Candidate configs the workspace probe opened and declined, repo-relative
   * POSIX. Read only by the coverage section, which must not offer a config
   * already proven to cover none of the gap. Empty whenever no probe ran.
   */
  rejected: readonly string[];
  /**
   * Selected workspaces that contributed no config of their own. Whether that
   * matters depends on what the other configs reached, so it is answered after
   * the load by `warnUnreachedWorkspaces`.
   */
  unconfigured: readonly Workspace[];
}

/**
 * The tsconfigs to analyze under `root` when the caller named none.
 *
 * Workspace discovery first, a single `tsconfig.json` second, and an error
 * third. There is deliberately NO upward search: thicket analyzes the
 * directory it was pointed at, and a run that silently walked up would report
 * a tree the caller did not name -- the same class of surprise as widening a
 * filtered run. Where the nearest project actually is gets named in the error
 * instead, because it is the next command the reader will type.
 *
 * Every manifest that would not read gets a line on `warn`, and so does every
 * selected workspace with no tsconfig of its own. Both are states the coverage
 * banner describes as SCOPE -- "this run saw 15% of the tree" -- and neither
 * is fixable by the `--config` that banner suggests.
 */
async function discoverConfigs(
  root: string,
  opts: {
    filter: readonly string[];
    workspaces: boolean;
    scan: ScanOptions;
    warn: (message: string) => void;
  },
): Promise<Discovery> {
  if (opts.workspaces) {
    for (const problem of manifestProblems(root)) {
      opts.warn(`${problem.path} ${problem.reason}; no workspace was discovered from it`);
    }
    const discovered = discoverWorkspaces(root);
    if (discovered.length > 0) {
      warnNamelessWorkspaces(root, discovered, opts.warn);
      // `selected` decides what is analyzed and `discovered` is attribution
      // only -- passing the filtered list for both makes a filtered run adopt
      // a repo-spanning root config to cover the workspaces it excluded.
      const selected = selectWorkspaces(discovered, opts.filter);
      const chosen = await configsFor(root, { selected, discovered }, opts.scan);
      if (chosen.configs.length > 0) {
        return {
          configs: chosen.configs.map((c) => resolve(root, c)),
          rejected: chosen.rejected,
          // Reported only once the program is loaded: whether a workspace with
          // no config of its own goes unanalyzed depends on what the OTHER
          // configs reached, and nothing here knows that yet.
          unconfigured: selected.filter(
            (ws) => !chosen.configs.some((c) => ownConfigOf(ws.dir, c)),
          ),
        };
      }
      throw new Error(
        `no tsconfig in ${root} or in any of the ${selected.length} workspaces selected there`,
      );
    }
  }
  if (opts.filter.length > 0) {
    throw new Error(
      `--filter selects workspaces, and no workspace was discovered under ${root}`,
    );
  }
  const single = join(root, "tsconfig.json");
  if (existsSync(single)) return { configs: [single], rejected: [], unconfigured: [] };
  throw new Error(noProjectMessage(root));
}

/**
 * One line per discovered workspace whose own `package.json` would not read.
 *
 * The workspace is still discovered -- the file exists, which is the only test
 * the walk makes -- but `packageName` answers `undefined`, so it is nameless
 * and `--filter` by name cannot reach it. The failure the reader sees is
 * `--filter "@scope/thing" matched no workspace`, listing a bare `./pkg/thing`
 * where every sibling has a name, and the cause is a file in their own tree
 * that nothing mentions.
 *
 * Run over DISCOVERED rather than selected, and before selection, because the
 * case it explains is the one where selection throws.
 *
 * Reusing `manifestProblems` rather than reporting "this has no name": a
 * package.json may legitimately omit `name` (a private root-adjacent package),
 * and that is not a problem to report -- `./dir` still addresses it. The
 * symptom gates the check, so the read costs nothing on the common path; the
 * diagnostic itself stays the one definition of "a manifest that exists and
 * declares nothing usable".
 */
function warnNamelessWorkspaces(
  root: string,
  discovered: readonly Workspace[],
  warn: (message: string) => void,
): void {
  const lines: string[] = [];
  for (const ws of discovered) {
    if (ws.name !== undefined) continue;
    for (const problem of manifestProblems(join(root, ws.dir))) {
      lines.push(`${problem.path} ${problem.reason}; ./${ws.dir} has no name to filter by`);
    }
  }
  // Sorted by the line as printed. The walk orders workspaces by directory,
  // which is not the order the reader sees when the line leads with a name.
  for (const line of lines.sort(compareStrings)) warn(line);
}

/**
 * One line per selected workspace holding TypeScript that no chosen config
 * reached.
 *
 * Both halves of that are load-bearing. "Has no tsconfig of its own" alone is
 * not a problem worth a line: a workspace may hold no TypeScript at all -- a
 * pure-JS package, or one that exists to publish shared compiler settings --
 * and saying its source went unanalyzed is false in the sense the reader cares
 * about and unactionable in every sense. On a mixed monorepo that is one
 * useless line per JS package on every run, which trains people to stop
 * reading the channel that also carries the warnings that matter. Nor does a
 * missing config prove a gap: another workspace's build config, or the root's,
 * may reach into it.
 *
 * So it is asked after the load, against the files actually analyzed, and the
 * count is of files that are on disk and not in the program.
 *
 * Costs one extra tree walk, and only when some selected workspace had no
 * config of its own -- on a monorepo where every workspace has one, which is
 * the common shape, `unconfigured` is empty and nothing is scanned.
 */
function warnUnreachedWorkspaces(opts: {
  unconfigured: readonly Workspace[];
  /** Root the workspace directories are relative to. */
  dir: string;
  /** Root the analyzed paths are relative to; differs only when a pin was declined. */
  root: string;
  analyzed: ReadonlySet<string>;
  scan: ScanOptions;
  warn: (message: string) => void;
}): void {
  if (opts.unconfigured.length === 0) return;
  const onDisk = scanSourceFiles(opts.root, opts.scan);
  // Workspace directories are relative to the directory discovery ran in,
  // which is the analysis root unless the pin was declined -- in which case
  // the real root is ABOVE it and every workspace needs that much more prefix.
  const prefix = toPosix(relative(opts.root, opts.dir));
  const lines: string[] = [];
  for (const ws of opts.unconfigured) {
    const dir = prefix === "" ? ws.dir : `${prefix}/${ws.dir}`;
    const missed = onDisk.filter((p) => p.startsWith(`${dir}/`) && !opts.analyzed.has(p));
    if (missed.length === 0) continue;
    lines.push(
      `${ws.name ?? `./${ws.dir}`} has no tsconfig of its own, so ${missed.length} ` +
        `TypeScript ${missed.length === 1 ? "file" : "files"} under it went unanalyzed`,
    );
  }
  for (const line of lines.sort(compareStrings)) opts.warn(line);
}

/** True when `config` is a tsconfig in `dir` itself, rather than below it. */
function ownConfigOf(dir: string, config: string): boolean {
  return config.startsWith(`${dir}/`) && !config.slice(dir.length + 1).includes("/");
}

function noProjectMessage(root: string): string {
  const ancestor = nearestProject(root);
  return (
    `${root} holds no tsconfig.json and no manifest declaring workspaces` +
    (ancestor === undefined
      ? ` — name one with --config`
      : ` — the nearest directory above it that does is ${ancestor}`)
  );
}

/** The closest ancestor of `from` that is a project root, or `undefined`. */
function nearestProject(from: string): string | undefined {
  let dir = dirname(from);
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json")) || workspaceGlobs(dir) !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

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
  const bannerScan = opts.bannerScan ?? true;
  const types: TypesMode = opts.types ?? "include";
  // Sorted so that two runs passing the same patterns in a different order
  // share a cache rather than silently invalidating each other (AGENTS.md §1).
  const exclude = [...(opts.exclude ?? [])].sort(compareStrings);
  // Every knob that can change the finding set belongs in the hash: two
  // reports with the same configHash must have been produced the same way.
  const configHash = hash(
    JSON.stringify({
      version: VERSION,
      minNodes,
      minLines,
      granularity: String(granularity),
      includeGenerated,
      bannerScan,
      exclude,
      types,
    }),
  ).slice(0, 8);

  const warn = opts.warn ?? (() => {});
  const scan = { includeGenerated, bannerScan, exclude };
  // `dir` is resolved once: it is compared against `project.root`, which is
  // absolute and POSIX, and a relative one would never match.
  const dir = opts.dir === undefined ? undefined : toPosix(resolve(opts.dir));
  const discovery: Discovery =
    opts.config === undefined
      ? await discoverConfigs(dir ?? toPosix(resolve(".")), {
          filter: opts.filter ?? [],
          workspaces: opts.workspaces !== false,
          scan,
          warn,
        })
      : {
          configs: Array.isArray(opts.config) ? opts.config : [opts.config],
          rejected: [],
          unconfigured: [],
        };

  const project = await openProject(discovery.configs, {
    ...scan,
    ...(dir === undefined ? {} : { root: dir }),
  });
  if (dir !== undefined && project.root !== dir) {
    // The pin was declined: a config reaches above the directory named, so
    // rooting there would put `../` on paths that cannot carry it. Say which
    // root won, because it is also where the cache now lives.
    warn(
      `${dir} is not the root of what was analyzed — a tsconfig reaches above it, ` +
        `so paths and .thicket/ are measured from ${project.root}`,
    );
  }
  // Opened against the project root rather than the cwd, so the cache belongs
  // to the codebase being analyzed and not to wherever the tool was invoked.
  // `openCache` answers null rather than throwing on anything it cannot use.
  const cache: Cache | null =
    opts.cache === false ? null : openCache(cachePathFor(project.root), configHash);
  try {
    const files = project.files();
    if (files.length === 0) throw new EmptyProjectError(discovery.configs);
    let lineCount = 0;
    let totalBytes = 0;
    for (const file of files) {
      lineCount += file.sourceFile.text.split("\n").length;
      // The denominator of the coverage metric. Measured in the same UTF-16
      // code units as the occurrence offsets it will be divided into.
      totalBytes += file.sourceFile.text.length;
    }

    // The same rules on both sides. A denominator that counts what analysis
    // deliberately skipped invents a gap no --config can close.
    const scope = analysisScope(
      project.root,
      files.map((f) => f.path),
      {
        includeGenerated,
        bannerScan,
        exclude,
        // Repo-relative, because that is what the gaps speak. Measured from
        // `project.root` rather than from `dir`: a config reaching above the
        // directory named moves the root, and a path measured from the other
        // one matches no gap and quietly reinstates the advice this removes.
        analyzedConfigs: discovery.configs.map((c) => toPosix(relative(project.root, c))),
        rejectedConfigs: discovery.rejected,
      },
    );
    // Here rather than in discovery: "this workspace has no tsconfig" is only
    // worth saying once it is known that nothing else covered its files, and
    // that answer is the program.
    warnUnreachedWorkspaces({
      unconfigured: discovery.unconfigured,
      dir: dir ?? project.root,
      root: project.root,
      analyzed: new Set(files.map((f) => f.path)),
      scan,
      warn,
    });

    const graph = buildModuleGraph(project, { granularity, types });
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
      // Whether anything here is circular at the file level, which is the
      // difference between a defect and an artifact of how files were grouped,
      // and which decides whether a cut is worth proposing at all.
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
      const { dissolves, cuts, residual, bestRejectedResidual } = suggestFixes(
        modules,
        inner,
        cycles.crossing.count,
        graph.moduleOf,
      );
      return {
        id: findingId("CYC", [...modules].sort(compareStrings).join(",")),
        modules,
        // The same Tarjan run on the graph that ships. Cheap -- the edges are
        // already in hand and already labelled -- and it is not derivable from
        // what the chart prints.
        runtimeModules: largestScc(
          modules,
          inner.filter((e) => !e.typeOnly),
        ),
        edges: inner,
        dissolves,
        cuts,
        residual,
        bestRejectedResidual,
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

    /** L0 token streams of a cluster's copies, or undefined if any is missing. */
    const streamsOf = (r: Ranked): string[][] | undefined => {
      const out = r.cluster.occurrences
        .slice(0, MAX_COPIES_COMPARED)
        .map((o) => fragmentAt(o)?.tokensL0);
      return out.some((s) => s === undefined) ? undefined : (out as string[][]);
    };

    // Test-majority is checked first, so `## Duplication in tests` keeps
    // exactly the meaning it had: everything whose work is in the test suite,
    // whether it is a type or not.
    const testDuplication = ranked.filter((r) => isTestMajority(r.cluster));
    const rest = ranked.filter((r) => !isTestMajority(r.cluster));
    const typeDuplication =
      types === "exclude" ? [] : rest.filter((r) => isTypeKind(r.cluster.kind));
    const production =
      types === "only" ? [] : rest.filter((r) => !isTypeKind(r.cluster.kind));

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
    const emitted = reweight(production, maxFindings, streamsOf).map(decorate);
    const emittedTypes = reweight(typeDuplication, typeFindings(maxFindings), streamsOf).map(
      decorate,
    );
    const emittedTests = reweight(testDuplication, testFindings(maxFindings), streamsOf).map(
      decorate,
    );

    // What varies between the copies -- the parameter list of the abstraction
    // the finding is asking for. Only emitted findings pay for it.
    const varies = new Map<string, ReturnType<typeof variations>>();
    for (const r of [...emitted, ...emittedTypes, ...emittedTests]) {
      const streams = r.cluster.occurrences
        .slice(0, MAX_COPIES_COMPARED)
        .map((o) => fragmentAt(o)?.tokensL0);
      if (streams.some((s) => s === undefined)) continue;
      const found = variations(streams as string[][]);
      // `saturated` is a property of the SAMPLE: every compared copy differed.
      // That only makes the count a floor when copies were actually left out
      // -- comparing all four copies of a four-copy cluster and finding four
      // values is an exact answer, and printing it as `≥4` would understate
      // what we know.
      const truncated = r.cluster.occurrences.length > MAX_COPIES_COMPARED;
      varies.set(
        r.cluster.id,
        truncated ? found : found.map((v) => ({ ...v, saturated: false })),
      );
    }

    // Near-variants, across both sections, for the findings actually printed.
    const variants = findVariants(
      [...emitted, ...emittedTypes, ...emittedTests].flatMap((r) => {
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
      excluded: project.excluded,
      ...(types === "include" ? {} : { types }),
      duplication: emitted.map(withVariants),
      typeDuplication: emittedTypes.map(withVariants),
      testDuplication: emittedTests.map(withVariants),
      cycles: cycles.slice(0, maxFindings),
      totalFindings,
      census: census(ranked, cycles.length),
      ...(opts.budgetTokens === undefined ? {} : { budgetTokens: opts.budgetTokens }),
      ...(opts.maxLocations === undefined ? {} : { maxFilesPerFinding: opts.maxLocations }),
    };

    const { markdown, shown } = renderReport(input);

    const asJson = (r: (typeof emitted)[number]): ReportJson["duplication"][number] => ({
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
    });

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
        excluded: project.excluded,
        // Split exactly as the Markdown is, so a consumer of the sidecar sees
        // the same three sections rather than having to re-derive them.
        duplication: [...emitted, ...emittedTests].map(asJson),
        typeDuplication: emittedTypes.map(asJson),
        cycles: input.cycles,
        totalFindings,
        census: input.census,
        shownInMarkdown: shown,
      },
    };
  } finally {
    cache?.close();
    // Awaited: the API holds a live connection to the tsgo child, and an
    // unclosed one keeps the event loop alive -- the process runs to
    // completion, prints its report, and then never exits.
    await project.close();
  }
}

/**
 * Candidates re-scored per emitted slot before the slice is taken.
 *
 * The field-drift signal needs token streams, and those come from re-extracting
 * fragments -- affordable for a few dozen findings, not for the eighteen
 * thousand the ranker sees. So the base ranking picks a pool this many times
 * the section's size and the penalty reorders within it. Since the penalty only
 * ever LOWERS a score, a candidate outside the pool would have to beat the
 * pool's last survivor from below, which three times the slots makes remote.
 */
const RERANK_POOL = 3;

/**
 * Re-score a section's candidates by whether consolidating them would buy
 * anything, then take the top `slots`.
 *
 * Copy count measures how much is duplicated. It does not measure whether
 * merging the copies leaves the code better, and on a real application the
 * second-ranked finding was 193 three-field projections spanning 89 distinct
 * key-sets -- `{ labOrderId: p.labOrderId, … }` beside `{ average: s.average,
 * … }` -- where the only available abstraction is a generic `pick` that no
 * future change can benefit from. Two agents asked to act on it declined and
 * said so. See `fieldNameDrift`.
 */
function reweight<T extends Ranked>(
  candidates: readonly T[],
  slots: number,
  streamsOf: (r: Ranked) => string[][] | undefined,
): T[] {
  return candidates
    .slice(0, slots * RERANK_POOL)
    .map((r) => {
      const streams = streamsOf(r);
      if (streams === undefined) return r;
      const drift = fieldNameDrift(streams);
      return { ...r, fieldDrift: drift, score: r.score * driftWeight(drift) };
    })
    .sort((a, b) => b.score - a.score || compareStrings(a.cluster.id, b.cluster.id))
    .slice(0, slots);
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
/**
 * Share of an edge that must be re-exported from outside the target before the
 * edge counts as routing rather than dependency.
 *
 * Below 1.0 because a real re-export file is rarely pure: the one that carried
 * four inbound edges of a 12-module tangle forwarded seven classes and defined
 * an eighth. An edge that is 90% forwarded still collapses to a specifier
 * rewrite plus one genuine move, which is a different order of work from a cut.
 */
const DISSOLVE_SHARE = 0.8;

/**
 * What to do about a tangle, cheapest first.
 *
 * Dissolves come before cuts because they are not the same kind of act. A cut
 * is a design decision -- invert a dependency, move code, agree a layering. A
 * dissolve is a find-and-replace: the imports crossing the edge are re-exported
 * from somewhere else, so repointing the specifier at the origin removes the
 * edge and changes nothing, a re-export being the same binding by definition.
 * On a real 12-module tangle four inbound edges to one module were entirely
 * this, and the agent that found it by hand called it the whole story of the
 * SCC. A cut is then suggested only for what survives dissolution.
 */
function suggestFixes(
  component: readonly string[],
  inner: readonly ModuleEdge[],
  crossingFileCycles: number,
  moduleOf: Record<string, string>,
): { dissolves: ModuleEdge[]; cuts: ModuleEdge[]; residual: number; bestRejectedResidual?: number } {
  // Routing edges: nearly everything on them is forwarded, and forwarded from
  // outside the module being depended on -- a barrel re-exporting its own
  // package's internals is not routing, it is that package's API surface.
  const dissolves = inner
    .filter((e) => {
      if (e.weight === 0 || e.passThrough / e.weight < DISSOLVE_SHARE) return false;
      const origin = e.origin === undefined ? undefined : moduleOf[e.origin];
      return origin !== undefined && origin !== e.to;
    })
    .sort(
      (a, b) =>
        b.weight - a.weight || compareStrings(a.from, b.from) || compareStrings(a.to, b.to),
    );

  const dissolved = new Set(dissolves.map((e) => `${e.from} -> ${e.to}`));
  const surviving = inner.filter((e) => !dissolved.has(`${e.from} -> ${e.to}`));
  const afterDissolve = largestScc(component, surviving);

  const { cuts, residual, bestRejectedResidual } = suggestCuts(
    component,
    surviving,
    crossingFileCycles,
    afterDissolve,
  );
  return { dissolves, cuts, residual, bestRejectedResidual };
}

function suggestCuts(
  component: readonly string[],
  inner: readonly ModuleEdge[],
  crossingFileCycles: number,
  startingFrom: number,
): { cuts: ModuleEdge[]; residual: number; bestRejectedResidual?: number } {
  const unchanged = { cuts: [], residual: startingFrom };
  if (component.length > MAX_CUT_SEARCH_MODULES) return unchanged;
  // Nothing to cut when nothing is circular. An SCC with no file-level cycle
  // crossing its modules is a product of the grouping, so severing an edge
  // removes no cycle that exists -- and a "suggested cut" printed two lines
  // under "nothing here is circular at runtime" invites work that changes
  // nothing. Verified on a real 7-module tangle: zero crossing cycles, and the
  // proposed cut removed zero of them.
  if (crossingFileCycles === 0) return unchanged;

  const candidates = [...inner]
    // Type-only edges are DEMOTED, not excluded. They were once preferred, on
    // the reasoning that moving a types file is the cheapest fix, and that
    // produced a 2-symbol cut an agent executed in ten minutes and correctly
    // called a no-op -- so they were banned outright. That over-corrected: the
    // defect in that recommendation was that it shaved one module off a tangle
    // and left the rest, which `MAX_RESIDUAL_SHARE` now catches on its own for
    // runtime and type cuts alike. A cycle in the type system is real
    // complexity -- a reader cannot understand either module without the other
    // -- and breaking one completely is worth proposing, labelled for what it
    // is. The demotion stays because only a runtime cycle can fail at
    // module-init time, so a runtime edge wins any tie.
    .sort(
      (a, b) =>
        Number(a.typeOnly) - Number(b.typeOnly) ||
        a.files.length - b.files.length ||
        a.weight - b.weight ||
        compareStrings(a.from, b.from) ||
        compareStrings(a.to, b.to),
    );

  let best: { edge: ModuleEdge; residual: number } | undefined;
  let bestRejected: number | undefined;
  for (const candidate of candidates) {
    const residual = largestSccWithout(component, inner, candidate);
    // Measured against what dissolution already achieved, so a cut is only
    // suggested when it buys something the free fix did not.
    if (residual >= startingFrom) continue;
    // And it has to buy enough to be worth the reader's time. `residual <= 1`
    // means no cycle is left at all, which is worth printing at any size.
    if (residual > 1 && residual > startingFrom * MAX_RESIDUAL_SHARE) {
      // Not suggested, but worth remembering: "the best you can do removes one
      // module of nine" is a different answer from "nothing helps".
      bestRejected = Math.min(bestRejected ?? Infinity, residual);
      continue;
    }
    // Strictly better only, so among equally dissolving cuts the cheapest
    // wins -- `candidates` is already in ascending cost order.
    if (best === undefined || residual < best.residual) best = { edge: candidate, residual };
    // Nothing can beat every module standing alone.
    if (residual <= 1) break;
  }

  if (best === undefined) return { ...unchanged, bestRejectedResidual: bestRejected };
  return { cuts: [best.edge], residual: best.residual };
}

/** Size of the largest SCC of `component` once `omit` is removed. */
function largestSccWithout(
  component: readonly string[],
  inner: readonly ModuleEdge[],
  omit: ModuleEdge,
): number {
  return largestScc(
    component,
    inner.filter((e) => e !== omit),
  );
}

/** Size of the largest SCC `component` still has over `edges`. */
function largestScc(component: readonly string[], edges: readonly ModuleEdge[]): number {
  const adjacency = new Map<string, string[]>(component.map((m) => [m, []]));
  for (const e of edges) adjacency.get(e.from)!.push(e.to);
  return stronglyConnected(component, adjacency).reduce((max, c) => Math.max(max, c.length), 0);
}
