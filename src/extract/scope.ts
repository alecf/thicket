import { closeSync, openSync, readSync, readdirSync } from "node:fs";
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
  /** See `OpenProjectOptions.bannerScan`. Must match what analysis used. */
  bannerScan?: boolean;
  exclude?: readonly string[];
  /**
   * Tsconfigs this run has already put to the question, repo-relative POSIX. A
   * gap suggests none of them. Two provenances, one behaviour:
   *
   *  - The configs the program was BUILT FROM. The run loaded one already, and
   *    it is that config's own `include`/`exclude` leaving the files out.
   *  - The candidate siblings `configsFor` OPENED AND DECLINED. The probe
   *    found none of that workspace's missing files in them.
   *
   * One field rather than two, because nothing downstream reads the
   * provenance: the difference would only be worth keeping if the report
   * worded the two cases differently, and it prints neither.
   */
  triedConfigs?: readonly string[];
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

/** One directory of source the program never saw, and what is left to try. */
export interface ScopeGap {
  /** Repo-relative POSIX directory. */
  dir: string;
  fileCount: number;
  /**
   * The `tsconfig*.json` files in `dir` that this run has not already tried,
   * sorted. Empty is the common answer once workspace discovery has run, and
   * it means "nothing here is worth suggesting" -- which covers three cases
   * the reader need not tell apart: the directory holds no config, every
   * config in it was loaded, or a probe opened one and it covered nothing.
   *
   * Untried candidates, deliberately unranked. Knowing which one COVERS the
   * gap needs a program load, and this function is synchronous by design, so
   * ranking here would be a guess printed as an instruction.
   */
  configs: string[];
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
        if (
          !opts.includeGenerated &&
          opts.bannerScan !== false &&
          hasGeneratedBanner(readHead(join(dir, name)))
        ) {
          continue;
        }
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
  // One listing per directory, not one per unanalyzed file: a run that missed
  // most of a large tree asks about the same ancestors thousands of times.
  // Memoized per call rather than per process, so a directory that gains a
  // config between two runs in one process is still read fresh.
  const listings = new Map<string, string[]>();
  const listConfigs = (dir: string): string[] => {
    const hit = listings.get(dir);
    if (hit !== undefined) return hit;
    const found = configPathsIn(root, dir);
    listings.set(dir, found);
    return found;
  };

  const byDir = new Map<string, number>();
  for (const path of missing) {
    const dir = owningDir(root, path, listConfigs);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }

  const tried = new Set((opts.triedConfigs ?? []).map(toPosix));
  const gaps: ScopeGap[] = [...byDir.entries()]
    .map(([dir, fileCount]) => ({
      dir,
      fileCount,
      configs: listConfigs(dir).filter((c) => !tried.has(c)),
    }))
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
 * a `tsconfig*.json`, else its top-level directory.
 *
 * Nearest-ancestor-with-a-config is what makes the report actionable — it
 * names the project the file should have belonged to, rather than a directory
 * the reader then has to go hunting through, and it is the directory whose
 * untried configs `ScopeGap.configs` are read from.
 */
function owningDir(
  root: string,
  relPath: string,
  listConfigs: (dir: string) => string[],
): string {
  const segments = relPath.split("/");
  for (let i = segments.length - 1; i > 0; i--) {
    const dir = segments.slice(0, i).join("/");
    if (listConfigs(dir).length > 0) return dir;
  }
  return segments.length > 1 ? segments[0]! : ".";
}

/**
 * The `tsconfig*.json` files directly in `dir`, repo-relative POSIX, sorted.
 *
 * `tsconfig*.json` rather than the `tsconfig.json` basename, in BOTH of the
 * places that used to hardcode it: a directory holding `tsconfig.app.json` and
 * `tsconfig.node.json` and no `tsconfig.json` is an ordinary Vite layout, and
 * hardcoding the name charged its files to the top-level directory above it
 * The one definition of "the configs in this directory": `configsIn` in
 * `workspaces.ts` picks the one it LOADS out of this list, so what a run opens
 * and what the coverage section offers cannot drift apart.
 *
 * `*.json` would be wrong: a `base.json` or `package.json` beside the configs
 * is not a project, and suggesting one is advice that cannot work.
 */
export function configPathsIn(root: string, dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir === "." ? root : join(root, dir), { withFileTypes: true });
  } catch {
    // An unreadable directory holds no config anyone can be told to pass.
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.startsWith("tsconfig") && e.name.endsWith(".json"))
    .map((e) => (dir === "." ? e.name : `${dir}/${e.name}`))
    .sort(compareStrings);
}
