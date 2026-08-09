import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { hash, initHash } from "../hash.js";
import { compareStrings } from "../order.js";
import { forEachChildSafe, walk } from "./traverse.js";
import type { FileHandle, Node, SourceFileNode } from "./types.js";

const toPosix = (p: string) => (sep === "\\" ? p.split(sep).join("/") : p);

/** The subset of the checker we depend on. Kept structural on purpose. */
interface Checker {
  getSymbolAtLocation(node: unknown): { declarations?: readonly { path?: string }[] } | undefined;
}

/** One resolved import target and how many distinct names it binds. */
export interface ImportDetail {
  /** Repo-relative POSIX path of the imported file. */
  target: string;
  /**
   * Distinct bindings introduced from `target`, summed over every import of
   * it in the importing file. Zero for a side-effect (`import "./x.js"`) or
   * dynamic import, which bind no names but are still real dependencies.
   */
  symbols: number;
}

export interface Project {
  /** Absolute, POSIX-separated. Every `FileHandle.path` is relative to this. */
  root: string;
  files(): FileHandle[];
  getSourceFile(relPath: string): SourceFileNode | undefined;
  resolveImport(from: FileHandle, specifier: unknown): string | undefined;
  importsOf(file: FileHandle): string[];
  importDetailsOf(file: FileHandle): ImportDetail[];
  close(): void;
}

/**
 * Distinct names an import/export declaration binds from its module.
 *
 * This is the edge weight of the module graph (PRD §7.2): pulling one constant
 * out of a module is not the same dependency as pulling thirty, and counting
 * *declarations* instead would make almost every weight 1.
 *
 * Kinds are matched by enum VALUE. `SyntaxKind[k]` reverse-maps to range-marker
 * aliases for several kinds, so name matching silently misses cases.
 */
function bindingCount(decl: Node): number {
  let count = 0;
  let named = false;
  forEachChildSafe(decl, (child) => {
    if (child.kind === SyntaxKind.ImportClause) {
      named = true;
      // `import d, * as ns from` / `import d, { a, b } from`. The `type` of a
      // type-only clause is a flag, not a child, so type-only imports count
      // exactly like value imports — they are still coupling.
      forEachChildSafe(child, (binding) => {
        if (binding.kind === SyntaxKind.Identifier) count += 1; // default import
        else if (binding.kind === SyntaxKind.NamespaceImport) count += 1; // * as ns
        else if (binding.kind === SyntaxKind.NamedImports) {
          forEachChildSafe(binding, (spec) => {
            if (spec.kind === SyntaxKind.ImportSpecifier) count += 1;
          });
        }
      });
    } else if (child.kind === SyntaxKind.NamedExports) {
      // `export { a, b } from "./x.js"` — a re-export is an import too.
      named = true;
      forEachChildSafe(child, (spec) => {
        if (spec.kind === SyntaxKind.ExportSpecifier) count += 1;
      });
    } else if (child.kind === SyntaxKind.NamespaceExport) {
      named = true;
      count += 1; // `export * as ns from "./x.js"`
    }
  });
  // `export * from "./x.js"` names nothing, yet pulls in the whole module
  // surface; count it like a namespace import. A side-effect `import "./x.js"`
  // is the other clause-less form and correctly stays at 0.
  if (!named && decl.kind === SyntaxKind.ExportDeclaration) count = 1;
  return count;
}

/**
 * Module specifier node -> binding count, for every import/export declaration
 * in the file. Keyed by node identity: the specifier nodes reachable by
 * traversal are the same objects `sourceFile.imports` holds, so the map can be
 * consulted while iterating that array — which stays the single source of
 * truth for which specifiers exist.
 */
function bindingCountsBySpecifier(sourceFile: SourceFileNode): Map<Node, number> {
  const out = new Map<Node, number>();
  walk(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.ImportDeclaration && node.kind !== SyntaxKind.ExportDeclaration) {
      return;
    }
    const count = bindingCount(node);
    forEachChildSafe(node, (child) => {
      if (child.kind === SyntaxKind.StringLiteral) out.set(child, count);
    });
  });
  return out;
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

  files.sort((a, b) => compareStrings(a.path, b.path));

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

  function importDetailsOf(file: FileHandle): ImportDetail[] {
    const counts = bindingCountsBySpecifier(file.sourceFile);
    const symbolsByTarget = new Map<string, number>();
    for (const specifier of file.sourceFile.imports ?? []) {
      const target = resolveImport(file, specifier);
      if (!target || target === file.path) continue;
      // A specifier with no entry is a dynamic `import()` or a `require()`:
      // a real dependency that binds no names statically.
      const symbols = counts.get(specifier as Node) ?? 0;
      symbolsByTarget.set(target, (symbolsByTarget.get(target) ?? 0) + symbols);
    }
    return [...symbolsByTarget.entries()]
      .map(([target, symbols]) => ({ target, symbols }))
      .sort((a, b) => compareStrings(a.target, b.target));
  }

  return {
    root,
    files: () => files,
    getSourceFile: (relPath) => byRel.get(relPath)?.sourceFile,
    resolveImport,
    importDetailsOf,
    /** Resolved import targets, deduped and sorted. Weights live in `importDetailsOf`. */
    importsOf: (file: FileHandle) => importDetailsOf(file).map((d) => d.target),
    close: () => api.close(),
  };
}
