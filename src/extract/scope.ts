import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { compareStrings } from "../order.js";
import { GENERATED_DIR_SEGMENTS, hasGeneratedBanner, isExcludedByPattern } from "./exclude.js";

const GENERATED = new Set(GENERATED_DIR_SEGMENTS);
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;

const toPosix = (p: string) => (sep === "\\" ? p.split(sep).join("/") : p);

/**
 * The exclusion rules, which the scan must apply exactly as analysis does.
 * Passing them separately is what keeps the two sides from disagreeing.
 */
export interface ScanOptions {
  includeGenerated?: boolean;
  exclude?: readonly string[];
}

/** How much of a file to read when looking for a generator's banner. */
const HEAD_BYTES = 4096;

/**
 * The first `HEAD_BYTES` of a file, as text.
 *
 * A bounded read rather than `readFileSync`: this runs once per source file on
 * disk, and the banner is always at the top. Slurping whole files here would
 * make the coverage figure cost as much as the analysis it describes.
 */
function readHead(absPath: string): string {
  let fd;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    // Unreadable is a permissions problem, not a generated file. Treating it
    // as source errs toward counting it, matching the walk above.
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One directory of source the program never saw, and the config that owns it. */
export interface ScopeGap {
  /** Repo-relative POSIX directory. */
  dir: string;
  fileCount: number;
  /** Repo-relative tsconfig that would bring `dir` in, when one exists. */
  config?: string;
}

export interface Scope {
  /** Files the program actually analyzed. */
  analyzed: number;
  /** Hand-written TypeScript files found on disk under the project root. */
  onDisk: number;
  /** True when the program covers the tree. */
  complete: boolean;
  /** Largest gaps first; empty when `complete`. */
  gaps: ScopeGap[];
}

/**
 * Hand-written TypeScript under `root`, repo-relative and sorted.
 *
 * This is the denominator of the coverage figure, so every rule here exists to
 * keep it from inflating — an inflated denominator invents a gap that no
 * `--config` can close, which is worse than reporting no gap at all:
 *
 *  - **Generated directories** are already excluded from analysis, so counting
 *    them would report a permanent shortfall.
 *  - **`.d.ts`** declares rather than implements; there is nothing to refactor.
 *  - **Dot-directories** hold caches, VCS data, and — the case that motivated
 *    this — agent worktrees, which are whole extra checkouts of the same tree.
 *    One worktree doubles every file in the repo.
 *  - **`node_modules`** is not first-party source.
 */
export function scanSourceFiles(root: string, opts: ScanOptions = {}): string[] {
  const out: string[] = [];
  const exclude = opts.exclude ?? [];

  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is a permissions problem, not a coverage gap.
      // Counting nothing here understates the denominator, which errs toward
      // silence rather than toward a false alarm.
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name === "node_modules" || name.startsWith(".") || GENERATED.has(name)) continue;
        walk(join(dir, name), prefix === "" ? name : `${prefix}/${name}`);
      } else if (entry.isFile() && SOURCE_EXT.test(name) && !name.endsWith(".d.ts")) {
        const rel = prefix === "" ? name : `${prefix}/${name}`;
        if (exclude.length > 0 && isExcludedByPattern(rel, exclude)) continue;
        if (!opts.includeGenerated && hasGeneratedBanner(readHead(join(dir, name)))) continue;
        out.push(rel);
      }
    }
  };

  walk(root, "");
  return out.sort(compareStrings);
}

/**
 * How much of the tree under `root` the program actually saw.
 *
 * The motivating failure: a monorepo's root `tsconfig.json` excluded `apps`
 * and `packages`, so the default run built a program from 176 of 6,286 files —
 * 2.8% — and the report's header (`176 files / 44182 LOC`) read exactly like
 * success. Every downstream number inherited it: zero cycles, propagation cost
 * 0.05, a duplication ranking drawn from 3% of the candidates. A report over a
 * sliver of the codebase is not wrong so much as unfalsifiable, and the reader
 * has no way to tell it apart from a genuinely small repository.
 *
 * Rooted at the project root rather than at the enclosing VCS checkout on
 * purpose. `--config apps/web/tsconfig.json` then measures coverage of
 * `apps/web` and stays quiet, which is the correct answer for someone who
 * deliberately scoped the run — and it avoids reporting on a parent repository
 * that merely happens to contain the project.
 */
export function analysisScope(
  root: string,
  analyzedPaths: readonly string[],
  opts: ScanOptions = {},
): Scope {
  const onDiskPaths = scanSourceFiles(root, opts);
  const analyzed = new Set(analyzedPaths.map(toPosix));

  const missing = onDiskPaths.filter((p) => !analyzed.has(p));
  const byDir = new Map<string, number>();
  for (const path of missing) {
    const dir = owningDir(root, path);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }

  const gaps: ScopeGap[] = [...byDir.entries()]
    .map(([dir, fileCount]) => {
      const config = `${dir}/tsconfig.json`;
      return existsSync(join(root, config))
        ? { dir, fileCount, config }
        : { dir, fileCount };
    })
    .sort((a, b) => b.fileCount - a.fileCount || compareStrings(a.dir, b.dir));

  return {
    analyzed: analyzedPaths.length,
    onDisk: onDiskPaths.length,
    // A program may legitimately reach files the scan skips — a `.d.ts` it was
    // pointed at, generated code under `--include-generated`. Completeness is
    // therefore "nothing on disk was missed", never a ratio, which would
    // exceed 1 and report a negative gap in exactly those cases.
    complete: missing.length === 0,
    gaps,
  };
}

/**
 * The directory to blame for an unanalyzed file: its nearest ancestor holding
 * a `tsconfig.json`, else its top-level directory.
 *
 * Nearest-ancestor-with-a-config is what makes the report actionable — the
 * answer is the exact `--config` argument to add, rather than a directory the
 * reader then has to go hunting through.
 */
function owningDir(root: string, relPath: string): string {
  const segments = relPath.split("/");
  for (let i = segments.length - 1; i > 0; i--) {
    const dir = segments.slice(0, i).join("/");
    if (existsSync(join(root, dir, "tsconfig.json"))) return dir;
  }
  return segments.length > 1 ? segments[0]! : ".";
}
