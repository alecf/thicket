#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { clearCache } from "./cache/db.js";
import { commonRootDir } from "./extract/ts-adapter.js";
import { diffReports, formatDiff, parseReport } from "./report/diff.js";
import { runReport } from "./run.js";
import { VERSION } from "./version.js";

/**
 * Depth presets. Deliberately a short explicit table rather than a formula:
 * these are the knob a human turns, and a reader should be able to see what
 * each setting does without evaluating arithmetic. `--budget-tokens` is the
 * knob a harness turns, because it knows its context window and not its
 * desired depth (PRD §9.3).
 */
const DEPTH_PRESETS: Record<
  number,
  { minNodes: number; minLines: number; maxFindings: number }
> = {
  1: { minNodes: 40, minLines: 10, maxFindings: 10 },
  2: { minNodes: 25, minLines: 6, maxFindings: 20 },
  3: { minNodes: 15, minLines: 4, maxFindings: 40 },
  4: { minNodes: 10, minLines: 3, maxFindings: 80 },
  5: { minNodes: 6, minLines: 2, maxFindings: 200 },
};
const DEFAULT_DEPTH = 3;

const USAGE = `thicket ${VERSION}

Usage: thicket [dir] [options]

  [dir]                  directory to analyze (default "."); its workspaces are
                         discovered from package.json / pnpm-workspace.yaml
  --filter <pattern>     analyze only these workspaces, by name or ./path;
                         repeatable, applied in order, "!" negates
  --no-workspaces        ignore workspace manifests; analyze <dir>/tsconfig.json
  --config <path>        tsconfig to analyze; repeatable. Suppresses discovery
  --depth <1..5>         preset: min fragment size and findings per section (default ${DEFAULT_DEPTH})
  --min-nodes <n>        override the depth preset's minimum fragment size, in AST nodes
  --min-lines <n>        override the depth preset's minimum fragment size, in lines
  --budget-tokens <n>    hard ceiling on report size; truncation is always stated
  --max-locations <n>    cap the files each finding names (default: name them all)
  --granularity <g>      auto | dir | file | <depth> (default auto)
                         dir = every directory is a module, at its own depth
  --include-generated    also analyze generated dirs and banner-marked files
  --exclude <glob>       skip files matching this glob; repeatable
  --no-banner-scan       do not treat an "auto-generated" banner as generated
  --types <mode>         include | exclude | only (default include) — whether
                         type declarations and type-only imports are analyzed
  --json <path>          also write the JSON sidecar here
  --no-cache             re-analyze every file, ignoring .thicket/cache.db
  --help                 show this message

Commands:
  cache clear            delete .thicket/cache.db for the analyzed project
  diff <a.json> <b.json> compare two --json sidecars: what was resolved, added,
                         and how the metrics moved
`;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        config: { type: "string", multiple: true },
        filter: { type: "string", multiple: true },
        workspaces: { type: "boolean", default: true },
        depth: { type: "string" },
        "min-nodes": { type: "string" },
        "min-lines": { type: "string" },
        "budget-tokens": { type: "string" },
        "max-locations": { type: "string" },
        granularity: { type: "string" },
        "include-generated": { type: "boolean" },
        exclude: { type: "string", multiple: true },
        "banner-scan": { type: "boolean", default: true },
        types: { type: "string" },
        json: { type: "string" },
        cache: { type: "boolean", default: true },
        help: { type: "boolean" },
      },
      // `cache clear`, `diff a b`, and one directory to analyze. Anything else
      // is rejected below rather than silently ignored.
      allowPositionals: true,
      allowNegative: true,
    });
  } catch (err) {
    process.stderr.write(`thicket: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // `diff` reads two sidecars and analyzes nothing, so it is answered before
  // any tsconfig is resolved. Resolving one first would make `thicket diff`
  // fail with "no such tsconfig: ./tsconfig.json" whenever it is run from a
  // directory that has no TypeScript project in it — which is most of them.
  if (positionals[0] === "diff") {
    return diffCommand(positionals.slice(1));
  }

  // Explicit configs are resolved up front so a bad path fails before anything
  // is loaded; absent, they are discovered under `dir` (see `runReport`).
  const configs = values.config === undefined ? undefined : resolveConfigs(values.config);
  if (typeof configs === "string") {
    process.stderr.write(configs);
    return 1;
  }

  if (positionals[0] === "cache") {
    if (positionals[1] !== "clear" || positionals.length !== 2) {
      process.stderr.write(`thicket: unknown command: ${positionals.join(" ")}\n\n${USAGE}`);
      return 1;
    }
    // Where `runReport` would have put it: the analyzed directory, or -- when
    // configs were named instead -- the root derived from them. Derived can
    // differ from any of them if a project reference reaches outside, so the
    // message names the directory actually cleared rather than claiming
    // success over one nobody asked about.
    const root = configs === undefined ? resolve(".") : commonRootDir(configs);
    const removed = clearCache(root);
    process.stderr.write(
      removed ? `thicket: cleared the cache in ${root}\n` : `thicket: no cache in ${root}\n`,
    );
    return 0;
  }

  if (positionals.length > 1) {
    process.stderr.write(`thicket: unknown command: ${positionals.join(" ")}\n\n${USAGE}`);
    return 1;
  }
  // `cache` and `diff` are answered above, so a lone positional is the
  // directory to analyze -- and a directory genuinely named either of those is
  // still reachable as `./cache`. Passed on even when --config is given, since
  // it is also the root paths and the cache are measured from.
  const dir = positionals[0];
  if (dir !== undefined && !isDirectory(dir)) {
    process.stderr.write(`thicket: not a directory: ${resolve(dir)}\n`);
    return 1;
  }
  // `--config` alone keeps its own root -- the ancestor of the configs opened
  // -- rather than being pinned to the working directory. Someone who names a
  // tsconfig in another tree means that tree, and pinning here would move its
  // cache to wherever the command was typed and rename every path in the
  // report. A directory named explicitly is a pin either way.
  const analyzedDir =
    dir !== undefined ? resolve(dir) : configs === undefined ? resolve(".") : undefined;

  const filter = values.filter ?? [];
  // Only `--filter` is refused beside `--config`. `--no-workspaces` is equally
  // inert there and is accepted on purpose: it asks for LESS -- "do not go
  // looking for workspaces" -- which naming configs has already done, so the
  // run the reader gets is the run they described. `--filter` asks for
  // something the run will not do, and a narrowed report that quietly covers
  // everything is the failure this tool exists to prevent. The asymmetry is
  // the difference between belt-and-braces and a request that goes unanswered.
  if (filter.length > 0 && configs !== undefined) {
    process.stderr.write(
      `thicket: --filter selects workspaces and --config names configs; pass one or the other\n`,
    );
    return 1;
  }
  if (filter.length > 0 && values.workspaces === false) {
    process.stderr.write(`thicket: --filter selects workspaces, which --no-workspaces turns off\n`);
    return 1;
  }

  let depth: number;
  let budgetTokens: number | undefined;
  let minNodesOverride: number | undefined;
  let minLinesOverride: number | undefined;
  let maxLocations: number | undefined;
  try {
    depth = parseNumber(values.depth, "--depth") ?? DEFAULT_DEPTH;
    budgetTokens = parseNumber(values["budget-tokens"], "--budget-tokens");
    minNodesOverride = parseNumber(values["min-nodes"], "--min-nodes");
    minLinesOverride = parseNumber(values["min-lines"], "--min-lines");
    maxLocations = parseNumber(values["max-locations"], "--max-locations");
  } catch (err) {
    process.stderr.write(`thicket: ${(err as Error).message}\n`);
    return 1;
  }

  const preset = DEPTH_PRESETS[depth];
  if (!preset) {
    process.stderr.write(`thicket: --depth must be 1..5, got ${depth}\n`);
    return 1;
  }

  // Rejected rather than silently defaulted: a typo'd mode that quietly
  // analyzed everything would be indistinguishable from asking for everything.
  const types = values.types ?? "include";
  if (types !== "include" && types !== "exclude" && types !== "only") {
    process.stderr.write(`thicket: --types must be include, exclude, or only; got ${types}\n`);
    return 1;
  }

  const granularity = parseGranularity(values.granularity);
  if (granularity === undefined) {
    process.stderr.write(
      `thicket: --granularity must be auto, dir, file, or a directory depth; ` +
        `got ${values.granularity}\n`,
    );
    return 1;
  }

  const minNodes = minNodesOverride ?? preset.minNodes;
  const minLines = minLinesOverride ?? preset.minLines;

  let markdown: string;
  let json: unknown;
  try {
    ({ markdown, json } = await runReport({
      ...(configs === undefined ? {} : { config: configs }),
      ...(analyzedDir === undefined ? {} : { dir: analyzedDir }),
      filter,
      workspaces: values.workspaces ?? true,
      warn: (message) => process.stderr.write(`thicket: ${message}\n`),
      minNodes,
      minLines,
      maxFindings: preset.maxFindings,
      granularity,
      includeGenerated: values["include-generated"] ?? false,
      bannerScan: values["banner-scan"] ?? true,
      types,
      exclude: values.exclude ?? [],
      cache: values.cache ?? true,
      ...(budgetTokens === undefined ? {} : { budgetTokens }),
      ...(maxLocations === undefined ? {} : { maxLocations }),
    }));
  } catch (err) {
    // A stack trace on stderr is a worse answer than a sentence: the caller is
    // usually a harness, and an unhandled rejection exits 1 with no message.
    process.stderr.write(`thicket: analysis failed: ${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(markdown);
  if (values.json !== undefined) {
    await writeFile(resolve(values.json), JSON.stringify(json, null, 2) + "\n");
  }
  return 0;
}

/** True for a path that exists and is a directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(resolve(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The resolved config paths, or the error message to print. */
function resolveConfigs(given: readonly string[]): string[] | string {
  // `resolve("")` is the cwd, which exists, so an empty --config would slip
  // past the existence check and analyze a directory as if it were a config.
  if (given.some((c) => c.trim() === "")) {
    return `thicket: --config must name a tsconfig, got an empty string\n`;
  }
  const configs = given.map((c) => resolve(c));
  const missing = configs.filter((c) => !existsSync(c));
  if (missing.length > 0) return `thicket: no such tsconfig: ${missing.join(", ")}\n`;
  return configs;
}

/**
 * `thicket diff before.json after.json` (PRD §9.1).
 *
 * The summary goes to stdout because it is the answer; anything that went
 * wrong goes to stderr with the offending path in it. The exit code is 0 for
 * "the comparison ran", not "nothing regressed" — deciding whether a delta is
 * acceptable is the harness's job, and an exit code that editorialized would
 * make the tool a judge (PRD §1).
 */
function diffCommand(args: readonly string[]): number {
  if (args.length !== 2) {
    process.stderr.write(
      `thicket: diff takes exactly two report paths, got ${args.length}\n\n${USAGE}`,
    );
    return 1;
  }
  let diff;
  try {
    const [before, after] = args.map((path) => readReport(path));
    diff = diffReports(before!, after!);
  } catch (err) {
    process.stderr.write(`thicket: ${(err as Error).message}\n`);
    return 1;
  }

  const lines = [formatDiff(diff)];
  for (const [label, ids] of [
    ["resolved", diff.resolved],
    ["new", diff.added],
  ] as const) {
    // Ids, not just counts: "3 resolved" tells a harness it made progress,
    // but only the ids tell it which finding to stop trying to fix.
    for (const id of ids) lines.push(`  ${label === "resolved" ? "-" : "+"} ${id}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function readReport(path: string) {
  const resolved = resolve(path);
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseReport(parsed, path);
}

function parseNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function parseGranularity(
  raw: string | undefined,
): "auto" | "file" | "dir" | number | undefined {
  if (raw === undefined || raw === "auto") return "auto";
  if (raw === "file") return "file";
  if (raw === "dir") return "dir";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Only run when invoked as the program. Without the guard, importing this
// module -- which a test of `main` must do -- executes a full analysis of the
// cwd as a side effect of the import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
