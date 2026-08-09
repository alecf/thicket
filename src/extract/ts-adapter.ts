import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { API } from "typescript/unstable/sync";
import { hash, initHash } from "../hash.js";
import type { FileHandle, SourceFileNode } from "./types.js";

const toPosix = (p: string) => (sep === "\\" ? p.split(sep).join("/") : p);

/** The subset of the checker we depend on. Kept structural on purpose. */
interface Checker {
  getSymbolAtLocation(node: unknown): { declarations?: readonly { path?: string }[] } | undefined;
}

export interface Project {
  /** Absolute, POSIX-separated. Every `FileHandle.path` is relative to this. */
  root: string;
  files(): FileHandle[];
  getSourceFile(relPath: string): SourceFileNode | undefined;
  resolveImport(from: FileHandle, specifier: unknown): string | undefined;
  importsOf(file: FileHandle): string[];
  close(): void;
}

/**
 * Longest common *directory* prefix of the given tsconfig paths.
 *
 * Not `dirname(configs[0])`: with configs in sibling directories
 * (`packages/a/tsconfig.json`, `packages/b/tsconfig.json`) the first config's
 * directory makes every path in the other packages `../`-prefixed, which
 * breaks the repo-relative-path contract and every grouping built on it.
 *
 * Compares whole path segments, never string prefixes, so `/repo/pack` and
 * `/repo/package` share `/repo` rather than `/repo/pack`.
 */
export function commonRootDir(configs: readonly string[]): string {
  if (configs.length === 0) throw new Error("openProject requires at least one tsconfig path");
  const dirs = configs.map((c) => toPosix(dirname(isAbsolute(c) ? c : resolve(c))).split("/"));
  let common = dirs[0]!;
  for (const segs of dirs.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  // A single leading "" means the only shared ancestor is the filesystem root.
  return common.join("/") || "/";
}

export async function openProject(configs: string | string[]): Promise<Project> {
  await initHash();
  const list = (Array.isArray(configs) ? configs : [configs]).map((c) =>
    isAbsolute(c) ? c : resolve(c),
  );
  const root = commonRootDir(list);

  const api = new API({ cwd: root });
  const snapshot = api.updateSnapshot({ openProjects: list });

  // A file present in several tsconfig projects is returned once per project.
  // Dedupe on absolute path; the unit of analysis is the FILE, not (project,file).
  const seen = new Set<string>();
  const files: FileHandle[] = [];
  const byRel = new Map<string, FileHandle>();
  // `Path` values from the checker are CASE-CANONICALIZED (lowercased) while
  // getSourceFileNames() preserves original casing. Index by lowercase so the
  // two can be reconciled. See PRD §2.4.
  const byCanon = new Map<string, FileHandle>();
  // Each file must be queried through the checker of the project that OWNS it.
  // A foreign project's checker does not merely miss the answer — it throws on
  // the unknown node handle, which a swallowing catch would turn into "this
  // repo has no imports". Kept internal so FileHandle stays plain data.
  const checkerOf = new Map<string, Checker>();

  for (const project of snapshot.getProjects()) {
    const checker = project.checker as unknown as Checker;
    for (const name of project.program.getSourceFileNames()) {
      if (name.includes("node_modules") || name.endsWith(".d.ts")) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const sf = project.program.getSourceFile(name) as unknown as SourceFileNode | undefined;
      if (!sf) continue;
      const handle: FileHandle = {
        path: toPosix(relative(root, name)),
        absPath: name,
        contentHash: hash(sf.text),
        sourceFile: sf,
      };
      files.push(handle);
      byRel.set(handle.path, handle);
      byCanon.set(name.toLowerCase(), handle);
      checkerOf.set(name, checker);
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  function resolveImport(from: FileHandle, specifier: unknown): string | undefined {
    const checker = checkerOf.get(from.absPath);
    if (!checker) {
      // Never silently return undefined here: an unowned file would look like
      // a file with no imports rather than a bug.
      throw new Error(`no checker for ${from.path}; it belongs to no opened project`);
    }
    let path: string | undefined;
    try {
      path = checker.getSymbolAtLocation(specifier)?.declarations?.[0]?.path;
    } catch {
      return undefined; // unresolvable specifier (missing module, bad path)
    }
    if (!path) return undefined;
    return byCanon.get(path.toLowerCase())?.path;
  }

  return {
    root,
    files: () => files,
    getSourceFile: (relPath) => byRel.get(relPath)?.sourceFile,
    resolveImport,
    importsOf(file: FileHandle): string[] {
      const out = new Set<string>();
      for (const specifier of file.sourceFile.imports ?? []) {
        const target = resolveImport(file, specifier);
        if (target && target !== file.path) out.add(target);
      }
      return [...out].sort();
    },
    close: () => api.close(),
  };
}
