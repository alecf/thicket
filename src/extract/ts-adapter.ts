import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { hash, initHash } from "../hash.js";
import { compareStrings } from "../order.js";
import { hasGeneratedBanner, isExcludedByPattern, isGeneratedPath } from "./exclude.js";
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
  /**
   * How many of those bindings are erased at compile time -- `import type`,
   * `export type`, or per-specifier `{ type A }`.
   *
   * A count rather than the `erasable` boolean it replaced, because
   * all-or-nothing hides the cheapest fixes. On a real 7-module tangle an edge
   * carrying five bindings was four `import type`s plus exactly one runtime
   * import in one file: relocate that file and the whole edge erases. The
   * boolean says only "not type-only" and leaves the reader to grep five files
   * to find that out.
   *
   * NOT the whole story on its own -- see `erasable`.
   */
  erased: number;
  /**
   * True when every import of `target` in this file is erased at compile time.
   *
   * Deliberately not derived from `erased === symbols`, because that is
   * vacuously true for the one import form that exists purely for its runtime
   * effect: `import "./x.js"` binds no names, so it contributes 0 to both
   * counts and vanishes from the comparison. A file doing that beside an
   * `import type` would report a live module-init dependency as erasable, and
   * a reader would be told a types file move breaks the cycle.
   */
  erasable: boolean;
  /**
   * How many of `symbols` the target does not define, but forwards from
   * somewhere else.
   *
   * These are not a dependency on `target` at all — they are a dependency on
   * whatever it re-exports, routed through it. Which means the edge they make
   * can be DISSOLVED rather than cut: repoint the specifier at the origin and
   * it disappears, with no semantic change, because a re-export is the same
   * binding by definition. On a real 12-module tangle four inbound edges to
   * one module were 100% this, and the fix was a find-and-replace.
   */
  passThrough: number;
  /** Where most of those forwarded bindings actually come from, if any do. */
  origin?: string;
}

export interface Project {
  /** Absolute, POSIX-separated. Every `FileHandle.path` is relative to this. */
  root: string;
  /**
   * How many files each exclusion rule dropped. Reported, never silent: a run
   * that analyzed too little has to be visible in its own output.
   */
  excluded: ExcludedCounts;
  files(): FileHandle[];
  getSourceFile(relPath: string): SourceFileNode | undefined;
  resolveImport(from: FileHandle, specifier: unknown): string | undefined;
  importsOf(file: FileHandle): string[];
  importDetailsOf(file: FileHandle): ImportDetail[];
  /**
   * What this file forwards with `export … from`, if it forwards and does
   * nothing else. Empty for every other file, including one that re-exports
   * beside code of its own.
   *
   * The exclusivity matters: a report field whose job is to name the shared
   * abstraction pointed at a nine-line `export * from` shim and stopped there,
   * leaving the 1012-line base class the refactor turned on to be found by
   * hand. Following the hop is only sound when the file really is a stand-in.
   */
  reexportsOf(file: FileHandle): string[];
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
function bindingCount(decl: Node): { count: number; erased: number; names: string[] } {
  let count = 0;
  let erased = 0;
  // Names as the IMPORTING file sees them for a plain import, and as the
  // exporting file publishes them for a re-export -- which is what has to be
  // looked up in the target's export table.
  const names: string[] = [];
  let named = false;
  // `import type { A }` / `export type { A }` puts the marker on the clause or
  // the declaration, where it is a flag rather than a child node, and it
  // applies to every binding underneath.
  const wholeDeclErased = isTypeOnly(decl);
  forEachChildSafe(decl, (child) => {
    if (child.kind === SyntaxKind.ImportClause) {
      named = true;
      const clauseErased = wholeDeclErased || isTypeOnly(child);
      // `import d, * as ns from` / `import d, { a, b } from`.
      forEachChildSafe(child, (binding) => {
        if (binding.kind === SyntaxKind.Identifier) {
          count += 1; // default import
          names.push("default");
          if (clauseErased) erased += 1;
        } else if (binding.kind === SyntaxKind.NamespaceImport) {
          count += 1; // * as ns
          names.push("*");
          if (clauseErased) erased += 1;
        } else if (binding.kind === SyntaxKind.NamedImports) {
          forEachChildSafe(binding, (spec) => {
            if (spec.kind !== SyntaxKind.ImportSpecifier) return;
            count += 1;
            names.push(importedNameOf(spec));
            // `import { type A, B }` marks the specifier, not the clause.
            if (clauseErased || isTypeOnly(spec)) erased += 1;
          });
        }
      });
    } else if (child.kind === SyntaxKind.NamedExports) {
      // `export { a, b } from "./x.js"` — a re-export is an import too.
      named = true;
      forEachChildSafe(child, (spec) => {
        if (spec.kind !== SyntaxKind.ExportSpecifier) return;
        count += 1;
        names.push(importedNameOf(spec));
        if (wholeDeclErased || isTypeOnly(spec)) erased += 1;
      });
    } else if (child.kind === SyntaxKind.NamespaceExport) {
      named = true;
      count += 1; // `export * as ns from "./x.js"`
      names.push("*");
      if (wholeDeclErased) erased += 1;
    }
  });
  // `export * from "./x.js"` names nothing, yet pulls in the whole module
  // surface; count it like a namespace import. A side-effect `import "./x.js"`
  // is the other clause-less form and correctly stays at 0.
  if (!named && decl.kind === SyntaxKind.ExportDeclaration) {
    count = 1;
    names.push("*");
    if (wholeDeclErased) erased = 1;
  }
  // Both numbers, not the "is it all erased" verdict: a partly erased edge is
  // where the cheap fixes hide, and the verdict throws that away. A clause-less
  // `import "./x.js"` comes back {0, 0} -- a real runtime dependency that must
  // not read as erasable for having nothing to erase, which is why every
  // consumer tests `symbols > 0` before comparing the two.
  return { count, erased, names };
}

/** The most frequent entry, ties broken by name so the answer is stable. */
function commonest(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [value, count] of [...counts].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The name a specifier publishes locally: `B` in `{ A as B }`, `A` in `{ A }`.
 * The LAST identifier, since only the aliased form has two.
 */
function localNameOf(spec: Node): string {
  const identifiers: string[] = [];
  forEachChildSafe(spec, (child) => {
    if (child.kind === SyntaxKind.Identifier) identifiers.push(nodeText(child));
  });
  return identifiers[identifiers.length - 1] ?? "";
}

/**
 * The name an import/export specifier reads out of the module it names.
 *
 * For `{ A as B }` that is `A`, not `B`: the local alias is this file's
 * business, while the lookup happens in the exporting file's table. The AST
 * gives `propertyName` then `name`, and only the two-identifier form is
 * aliased -- so the FIRST identifier is always the exported name.
 */
function importedNameOf(spec: Node): string {
  const identifiers: string[] = [];
  forEachChildSafe(spec, (child) => {
    if (child.kind === SyntaxKind.Identifier) identifiers.push(nodeText(child));
  });
  return identifiers[0] ?? "";
}

/**
 * `getText()` behind a guard. It reads back through the source file, which
 * throws for a synthesized node -- and a throw here would abort the whole
 * import walk for one unreadable identifier.
 */
function nodeText(node: Node): string {
  try {
    return node.getText();
  } catch {
    return "";
  }
}

/**
 * The `isTypeOnly` flag, read defensively.
 *
 * It is a lazy getter on the unstable AST rather than an own property, and it
 * is absent on the node kinds that cannot carry it. Reading it through a cast
 * keeps every other access in this file on the typed surface.
 */
function isTypeOnly(node: Node): boolean {
  return (node as { isTypeOnly?: boolean }).isTypeOnly === true;
}

/**
 * Targets of the file's `export … from` declarations, or none when the file
 * also imports something it does not forward.
 *
 * A pure forwarder is a file the reader can see through. One that imports on
 * its own account is not: what a cluster shares with it may be the part it
 * declares rather than the part it passes along.
 */
function reexportSpecifiers(sourceFile: SourceFileNode): { nodes: Node[]; exclusive: boolean } {
  const nodes: Node[] = [];
  let plainImports = 0;
  walk(sourceFile, (node) => {
    if (node.kind === SyntaxKind.ImportDeclaration) {
      // `import "./x.js"` and every other import form: this file consumes as
      // well as forwards.
      plainImports += 1;
      return;
    }
    if (node.kind !== SyntaxKind.ExportDeclaration) return;
    forEachChildSafe(node, (child) => {
      if (child.kind === SyntaxKind.StringLiteral) nodes.push(child);
    });
  });
  return { nodes, exclusive: plainImports === 0 };
}

/**
 * Module specifier node -> binding count, for every import/export declaration
 * in the file. Keyed by node identity: the specifier nodes reachable by
 * traversal are the same objects `sourceFile.imports` holds, so the map can be
 * consulted while iterating that array — which stays the single source of
 * truth for which specifiers exist.
 */
function bindingCountsBySpecifier(
  sourceFile: SourceFileNode,
): Map<Node, { count: number; erased: number; names: string[] }> {
  const out = new Map<Node, { count: number; erased: number; names: string[] }>();
  walk(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.ImportDeclaration && node.kind !== SyntaxKind.ExportDeclaration) {
      return;
    }
    const detail = bindingCount(node);
    forEachChildSafe(node, (child) => {
      if (child.kind === SyntaxKind.StringLiteral) out.set(child, detail);
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

/**
 * How many rounds of reference expansion to attempt. A solution config that
 * points at solution configs is already unusual; ten levels is far past any
 * real layout and bounds the loop even if the visited set is somehow defeated.
 */
const MAX_REFERENCE_DEPTH = 10;

/**
 * Add the `references` of every opened project that owns no source files, and
 * re-snapshot, until nothing new appears.
 *
 * `{"files": [], "references": [...]}` — the stock Vite/React template — is a
 * *solution* config: it legitimately contains no files and exists only to
 * delegate. Loading it and stopping yields zero files, which downstream reads
 * as "this codebase is clean" rather than "nothing was loaded".
 *
 * Only zero-file projects are expanded. A config that already contributes
 * files is the unit the caller asked for; pulling in its references too would
 * silently widen the analysis beyond what was requested.
 *
 * Returns the full open list. Reference cycles are real (a leaf that points
 * back at its solution root) and are cut by the visited set, keyed on the
 * case-folded path because tsconfig paths reach us with host casing.
 */
function expandReferences(
  api: InstanceType<typeof API>,
  initial: readonly string[],
): { snapshot: ReturnType<InstanceType<typeof API>["updateSnapshot"]>; configs: string[] } {
  const open = [...initial];
  const visited = new Set(open.map((c) => c.toLowerCase()));
  let snapshot = api.updateSnapshot({ openProjects: open });

  for (let depth = 0; depth < MAX_REFERENCE_DEPTH; depth++) {
    const added: string[] = [];
    for (const project of snapshot.getProjects()) {
      if (project.program.getSourceFileNames().length > 0) continue;
      for (const ref of project.parsedCommandLine.projectReferences ?? []) {
        const path = referencedConfigPath(ref.path);
        if (path === undefined || visited.has(path.toLowerCase())) continue;
        visited.add(path.toLowerCase());
        added.push(path);
      }
    }
    if (added.length === 0) break;
    added.sort(compareStrings); // deterministic open order
    open.push(...added);
    snapshot = api.updateSnapshot({ openProjects: open });
  }
  return { snapshot, configs: open };
}

/**
 * A `references` entry may name either a tsconfig file or the directory that
 * holds one. Returns undefined for an entry that resolves to neither, because
 * a dangling reference is a real configuration state and must not abort the
 * expansion of its siblings.
 */
function referencedConfigPath(raw: string): string | undefined {
  if (existsSync(raw)) {
    return statSync(raw).isDirectory() ? referencedConfigPath(join(raw, "tsconfig.json")) : raw;
  }
  return undefined;
}

export interface OpenProjectOptions {
  /**
   * Analyze generated/vendored code too. Off by default: emitted code is
   * duplication by construction and crowds out real findings. Turns off both
   * heuristics — `GENERATED_DIR_SEGMENTS` and the banner sniff — but never
   * `exclude`, which is an instruction rather than a guess.
   */
  includeGenerated?: boolean;
  /**
   * Globs, matched against repo-relative paths, whose files are not analyzed.
   * The escape hatch for generated code that declares nothing.
   */
  exclude?: readonly string[];
}

/** What `openProject` dropped, by the rule that dropped it. */
export interface ExcludedCounts {
  directory: number;
  banner: number;
  pattern: number;
}

export async function openProject(
  configs: string | string[],
  opts: OpenProjectOptions = {},
): Promise<Project> {
  await initHash();
  const list = (Array.isArray(configs) ? configs : [configs]).map((c) =>
    isAbsolute(c) ? c : resolve(c),
  );

  const api = new API({ cwd: commonRootDir(list) });
  const { snapshot, configs: opened } = expandReferences(api, list);
  // Rooted at the ancestor of everything actually opened: a reference may sit
  // outside the requested config's directory, and a file above the root would
  // get a `../`-prefixed path, breaking the repo-relative-path contract.
  const root = commonRootDir(opened);

  // A file present in several tsconfig projects is returned once per project.
  // Dedupe on absolute path; the unit of analysis is the FILE, not (project,file).
  const seen = new Set<string>();
  const excludePatterns = opts.exclude ?? [];
  const excluded: ExcludedCounts = { directory: 0, banner: 0, pattern: 0 };
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
      // `.json` is excluded because `resolveJsonModule` puts every imported
      // data file into the program and the API parses it into a real
      // Array/ObjectLiteral AST. On one application a 126,000-line LOINC code
      // table produced six of the top findings -- clusters of identical array
      // literals inside a single data file, which is duplication only in the
      // sense that a phone book repeats itself -- and contributed those 126k
      // lines to the reported LOC. Resolution is unaffected: this drops the
      // file from ANALYSIS, not from the program.
      if (
        name.includes("node_modules") ||
        name.endsWith(".d.ts") ||
        name.endsWith(".json")
      ) {
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      // Segment-matched against the REPO-RELATIVE path: a checkout that lives
      // under a directory called `build` would otherwise exclude itself.
      const relPath = toPosix(relative(root, name));
      // Cheapest first, and path-only rules before any that need the text.
      if (!opts.includeGenerated && isGeneratedPath(relPath)) {
        excluded.directory += 1;
        continue;
      }
      if (excludePatterns.length > 0 && isExcludedByPattern(relPath, excludePatterns)) {
        excluded.pattern += 1;
        continue;
      }
      const sf = project.program.getSourceFile(name) as unknown as SourceFileNode | undefined;
      if (!sf) continue;
      // Costs nothing extra: the text is already in hand for the content hash.
      if (!opts.includeGenerated && hasGeneratedBanner(sf.text)) {
        excluded.banner += 1;
        continue;
      }
      const handle: FileHandle = {
        path: relPath,
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

  /**
   * Exported name -> the file it is forwarded from, for names this file
   * publishes without defining.
   *
   * Covers the two forms that occur in practice:
   * `export { A } from "./x"` and `import { A } from "./x"; export { A }`.
   * A bare `export * from "./x"` names nothing, so it is recorded as a
   * fallback origin used for any name the table does not otherwise explain.
   *
   * Memoized: a barrel is consulted once per importer, and there can be
   * hundreds.
   */
  const originCache = new Map<string, { named: Map<string, string>; wildcard: string[] }>();
  function exportOrigins(file: FileHandle): { named: Map<string, string>; wildcard: string[] } {
    const cached = originCache.get(file.path);
    if (cached) return cached;

    const named = new Map<string, string>();
    const wildcard: string[] = [];
    // Local name -> file it was imported from, so `export { A }` further down
    // can be resolved. Built first because declaration order does not bind.
    const importedFrom = new Map<string, string>();

    walk(file.sourceFile, (node) => {
      if (node.kind !== SyntaxKind.ImportDeclaration) return;
      let target: string | undefined;
      forEachChildSafe(node, (child) => {
        if (child.kind === SyntaxKind.StringLiteral) target = resolveImport(file, child);
      });
      if (target === undefined) return;
      forEachChildSafe(node, (child) => {
        if (child.kind !== SyntaxKind.ImportClause) return;
        forEachChildSafe(child, (binding) => {
          if (binding.kind !== SyntaxKind.NamedImports) return;
          forEachChildSafe(binding, (spec) => {
            if (spec.kind !== SyntaxKind.ImportSpecifier) return;
            // The LOCAL name, which is what an `export { … }` clause refers to.
            importedFrom.set(localNameOf(spec), target!);
          });
        });
      });
    });

    walk(file.sourceFile, (node) => {
      if (node.kind !== SyntaxKind.ExportDeclaration) return;
      let target: string | undefined;
      let clause = false;
      forEachChildSafe(node, (child) => {
        if (child.kind === SyntaxKind.StringLiteral) target = resolveImport(file, child);
      });
      forEachChildSafe(node, (child) => {
        if (child.kind === SyntaxKind.NamedExports) {
          clause = true;
          forEachChildSafe(child, (spec) => {
            if (spec.kind !== SyntaxKind.ExportSpecifier) return;
            const published = localNameOf(spec);
            // `export { A } from "./x"` states the origin outright;
            // `export { A }` has to be traced back to how `A` got here.
            const from = target ?? importedFrom.get(importedNameOf(spec));
            if (from !== undefined && from !== file.path) named.set(published, from);
          });
        } else if (child.kind === SyntaxKind.NamespaceExport) {
          clause = true;
        }
      });
      // `export * from "./x"`: no names, so it explains anything unaccounted for.
      if (!clause && target !== undefined && target !== file.path) wildcard.push(target);
    });

    const out = { named, wildcard };
    originCache.set(file.path, out);
    return out;
  }

  function importDetailsOf(file: FileHandle): ImportDetail[] {
    const counts = bindingCountsBySpecifier(file.sourceFile);
    const byTarget = new Map<
      string,
      { symbols: number; erased: number; erasable: boolean; passThrough: number; origins: string[] }
    >();
    for (const specifier of file.sourceFile.imports ?? []) {
      const target = resolveImport(file, specifier);
      if (!target || target === file.path) continue;
      // A specifier with no entry is a dynamic `import()` or a `require()`:
      // a real dependency that binds no names statically, and never erasable.
      const detail = counts.get(specifier as Node) ?? { count: 0, erased: 0, names: [] };
      const prior = byTarget.get(target);
      // The counts sum; erasability is vetoed. They are different questions:
      // a side-effect import contributes nothing to either count and must
      // still make the whole target non-erasable.
      const erasable = detail.count > 0 && detail.erased === detail.count;
      // Summed, not vetoed. The same file imported three times as
      // erased/real/erased is 3 bindings of which 2 erase, and both numbers
      // survive -- deciding per declaration, or letting the last one win,
      // loses the middle import entirely.
      // How much of this import is not really a dependency on `target`, but on
      // what `target` forwards. Skipped for a namespace import, which takes the
      // module as a whole and cannot be repointed at any one origin.
      const handle = byRel.get(target);
      const origins: string[] = [];
      if (handle !== undefined) {
        const table = exportOrigins(handle);
        for (const name of detail.names) {
          if (name === "*") continue;
          const from = table.named.get(name) ?? (table.wildcard.length === 1 ? table.wildcard[0] : undefined);
          if (from !== undefined) origins.push(from);
        }
      }
      byTarget.set(target, {
        symbols: (prior?.symbols ?? 0) + detail.count,
        erased: (prior?.erased ?? 0) + detail.erased,
        erasable: (prior?.erasable ?? true) && erasable,
        passThrough: (prior?.passThrough ?? 0) + origins.length,
        origins: [...(prior?.origins ?? []), ...origins],
      });
    }
    return [...byTarget.entries()]
      .map(([target, d]) => ({
        target,
        symbols: d.symbols,
        erased: d.erased,
        erasable: d.erasable,
        passThrough: d.passThrough,
        ...(d.origins.length > 0 ? { origin: commonest(d.origins) } : {}),
      }))
      .sort((a, b) => compareStrings(a.target, b.target));
  }

  function reexportsOf(file: FileHandle): string[] {
    const { nodes, exclusive } = reexportSpecifiers(file.sourceFile);
    if (!exclusive || nodes.length === 0) return [];
    const targets = new Set<string>();
    for (const node of nodes) {
      const target = resolveImport(file, node);
      if (target && target !== file.path) targets.add(target);
    }
    return [...targets].sort(compareStrings);
  }

  return {
    root,
    excluded,
    files: () => files,
    getSourceFile: (relPath) => byRel.get(relPath)?.sourceFile,
    resolveImport,
    importDetailsOf,
    reexportsOf,
    /** Resolved import targets, deduped and sorted. Weights live in `importDetailsOf`. */
    importsOf: (file: FileHandle) => importDetailsOf(file).map((d) => d.target),
    close: () => api.close(),
  };
}
