#!/usr/bin/env node
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runReport } from "./run.js";
import { VERSION } from "./version.js";

/**
 * Depth presets. Deliberately a short explicit table rather than a formula:
 * these are the knob a human turns, and a reader should be able to see what
 * each setting does without evaluating arithmetic. `--budget-tokens` is the
 * knob a harness turns, because it knows its context window and not its
 * desired depth (PRD §9.3).
 */
const DEPTH_PRESETS: Record<number, { minNodes: number; maxFindings: number }> = {
  1: { minNodes: 40, maxFindings: 10 },
  2: { minNodes: 25, maxFindings: 20 },
  3: { minNodes: 15, maxFindings: 40 },
  4: { minNodes: 10, maxFindings: 80 },
  5: { minNodes: 6, maxFindings: 200 },
};
const DEFAULT_DEPTH = 3;

const USAGE = `thicket ${VERSION}

Usage: thicket [options]

  --config <path>        tsconfig to analyze; repeatable (default ./tsconfig.json)
  --depth <1..5>         preset: min fragment size and findings per section (default ${DEFAULT_DEPTH})
  --min-nodes <n>        override the depth preset's minimum fragment size
  --budget-tokens <n>    hard ceiling on report size; truncation is always stated
  --granularity <g>      auto | file | <directory depth> (default auto)
  --json <path>          also write the JSON sidecar here
  --help                 show this message
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
        "budget-tokens": { type: "string" },
        granularity: { type: "string" },
        json: { type: "string" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`thicket: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const raw = values.config ?? ["./tsconfig.json"];
  // `resolve("")` is the cwd, which exists, so an empty --config would slip
  // past the existence check and analyze a directory as if it were a config.
  if (raw.some((c) => c.trim() === "")) {
    process.stderr.write(`thicket: --config must name a tsconfig, got an empty string\n`);
    return 1;
  }
  const configs = raw.map((c) => resolve(c));
  const missing = configs.filter((c) => !existsSync(c));
  if (missing.length > 0) {
    process.stderr.write(`thicket: no such tsconfig: ${missing.join(", ")}\n`);
    return 1;
  }

  let depth: number;
  let budgetTokens: number | undefined;
  let minNodesOverride: number | undefined;
  try {
    depth = parseNumber(values.depth, "--depth") ?? DEFAULT_DEPTH;
    budgetTokens = parseNumber(values["budget-tokens"], "--budget-tokens");
    minNodesOverride = parseNumber(values["min-nodes"], "--min-nodes");
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

  let markdown: string;
  let json: unknown;
  try {
    ({ markdown, json } = await runReport({
      config: configs,
      minNodes,
      maxFindings: preset.maxFindings,
      granularity,
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
