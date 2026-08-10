#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
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

Usage: thicket [options]

  --config <path>        tsconfig to analyze; repeatable (default ./tsconfig.json)
  --depth <1..5>         preset: min fragment size and findings per section (default ${DEFAULT_DEPTH})
  --min-nodes <n>        override the depth preset's minimum fragment size, in AST nodes
  --min-lines <n>        override the depth preset's minimum fragment size, in lines
  --budget-tokens <n>    hard ceiling on report size; truncation is always stated
  --granularity <g>      auto | file | <directory depth> (default auto)
  --include-generated    also analyze dist/, build/, .next/ and friends
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
        depth: { type: "string" },
        "min-nodes": { type: "string" },
        "min-lines": { type: "string" },
        "budget-tokens": { type: "string" },
        granularity: { type: "string" },
        "include-generated": { type: "boolean" },
        json: { type: "string" },
        cache: { type: "boolean", default: true },
        help: { type: "boolean" },
      },
      // `cache clear` is the only positional form. Anything else is rejected
      // below rather than silently ignored.
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

  const configs = resolveConfigs(values.config);
  if (typeof configs === "string") {
    process.stderr.write(configs);
    return 1;
  }

  if (positionals.length > 0) {
    if (positionals[0] !== "cache" || positionals[1] !== "clear" || positionals.length !== 2) {
      process.stderr.write(`thicket: unknown command: ${positionals.join(" ")}\n\n${USAGE}`);
      return 1;
    }
    // The root `runReport` caches under, computed the same way from the same
    // configs. It can differ if a project reference reaches outside them, in
    // which case the message names the directory actually cleared rather than
    // claiming success over one nobody asked about.
    const root = commonRootDir(configs);
    const removed = clearCache(root);
    process.stderr.write(
      removed ? `thicket: cleared the cache in ${root}\n` : `thicket: no cache in ${root}\n`,
    );
    return 0;
  }

  let depth: number;
  let budgetTokens: number | undefined;
  let minNodesOverride: number | undefined;
  let minLinesOverride: number | undefined;
  try {
    depth = parseNumber(values.depth, "--depth") ?? DEFAULT_DEPTH;
    budgetTokens = parseNumber(values["budget-tokens"], "--budget-tokens");
    minNodesOverride = parseNumber(values["min-nodes"], "--min-nodes");
    minLinesOverride = parseNumber(values["min-lines"], "--min-lines");
  } catch (err) {
    process.stderr.write(`thicket: ${(err as Error).message}\n`);
    return 1;
  }

  const preset = DEPTH_PRESETS[depth];
  if (!preset) {
    process.stderr.write(`thicket: --depth must be 1..5, got ${depth}\n`);
    return 1;
  }

  const granularity = parseGranularity(values.granularity);
  if (granularity === undefined) {
    process.stderr.write(
      `thicket: --granularity must be auto, file, or a directory depth; got ${values.granularity}\n`,
    );
    return 1;
  }

  const minNodes = minNodesOverride ?? preset.minNodes;
  const minLines = minLinesOverride ?? preset.minLines;

  let markdown: string;
  let json: unknown;
  try {
    ({ markdown, json } = await runReport({
      config: configs,
      minNodes,
      minLines,
      maxFindings: preset.maxFindings,
      granularity,
      includeGenerated: values["include-generated"] ?? false,
      cache: values.cache ?? true,
      ...(budgetTokens === undefined ? {} : { budgetTokens }),
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

/** The resolved config paths, or the error message to print. */
function resolveConfigs(raw: readonly string[] | undefined): string[] | string {
  const given = raw ?? ["./tsconfig.json"];
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

function parseGranularity(raw: string | undefined): "auto" | "file" | number | undefined {
  if (raw === undefined || raw === "auto") return "auto";
  if (raw === "file") return "file";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Only run when invoked as the program. Without the guard, importing this
// module -- which a test of `main` must do -- executes a full analysis of the
// cwd as a side effect of the import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
