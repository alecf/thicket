/**
 * Fails when code outside the adapter and the TypeScript profile imports the
 * `typescript` package (AGENTS.md §2).
 *
 * Two scanners, because neither sees every import alone:
 *
 *  - The compiler, through `tsc --explainFiles`. It resolves every import the
 *    program has, including `import type`, `export type … from` and
 *    `import("typescript").Node` in a type position. Those are erased at
 *    runtime, but they still tie the file to the unstable API.
 *  - Bun's transpiler. It sees a `require()` call, which the compiler does not
 *    treat as an import in an ESM `.ts` file.
 *
 * Both parse the source, so comments and line breaks inside an import cannot
 * hide it. A regex over the text lost that contest three times in review.
 *
 * Fails closed. Any scanner error exits non-zero. So does a compiler run that
 * reports no import of `typescript` at all, because `ts-adapter.ts` always has
 * one: silence there means the scanner broke, not that the code is clean.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = ["src/extract/", "src/lang/typescript/"];
/** A file the compiler must report, or its output was not read correctly. */
const KNOWN_IMPORTER = "src/extract/ts-adapter.ts";

const isTypescript = (specifier: string) =>
  specifier === "typescript" || specifier.startsWith("typescript/");

function compilerImporters(): Set<string> {
  const run = Bun.spawnSync(
    [process.execPath, "x", "tsc", "-p", "tsconfig.json", "--noEmit", "--explainFiles"],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  const out = run.stdout.toString();
  if (run.exitCode !== 0) {
    throw new Error(`tsc exited ${run.exitCode}:\n${out}${run.stderr.toString()}`);
  }
  const importers = new Set<string>();
  for (const m of out.matchAll(/Imported via "([^"]+)" from file '([^']+)'/g)) {
    if (isTypescript(m[1]!)) importers.add(m[2]!);
  }
  if (!importers.has(KNOWN_IMPORTER)) {
    throw new Error(`tsc --explainFiles reported no typescript import from ${KNOWN_IMPORTER}`);
  }
  return importers;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => relative(repoRoot, join(e.parentPath, e.name)).split("\\").join("/"));
}

function transpilerImporters(): Set<string> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const importers = new Set<string>();
  for (const file of sourceFiles("src")) {
    // `scanImports` rejects a shebang, and `src/cli.ts` has one.
    const text = readFileSync(join(repoRoot, file), "utf8").replace(/^#!.*/, "");
    const imports = transpiler.scanImports(text);
    if (imports.some((i) => isTypescript(i.path))) importers.add(file);
  }
  return importers;
}

const importers = new Set([...compilerImporters(), ...transpilerImporters()]);
const hits = [...importers]
  .filter((f) => !ALLOWED.some((dir) => f.startsWith(dir)))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

if (hits.length > 0) {
  for (const f of hits) console.log(f);
  console.log(
    "::error::TypeScript API imported outside src/extract/ and src/lang/typescript/ (AGENTS.md §2)",
  );
  process.exit(1);
}
console.log(`ok: ${importers.size} files import typescript, all inside ${ALLOWED.join(" and ")}`);
