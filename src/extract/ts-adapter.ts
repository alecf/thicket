import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { hash, initHash } from "../hash.js";
import { compareStrings, mostFrequent } from "../order.js";
import { hasGeneratedBanner, isExcludedByPattern, isGeneratedPath } from "./exclude.js";
import { TSGO_ENV_VAR, resolveTsgo } from "./tsgo-path.js";
import { forEachChildSafe, safeText, walk } from "./traverse.js";
import type { FileHandle, Node, SourceFileNode } from "./types.js";

const toPosix = (p: string) => (sep === "\\" ? p.split(sep).join("/") : p);

/** One symbol, as much of it as we read. */
interface Sym {
  declarations?: readonly { path?: string }[];
}

/** The subset of the checker we depend on. Kept structural on purpose. */
interface Checker {
  // The array overload is declared FIRST on purpose: `unknown` accepts an
  // array, so with the single-node signature ahead of it every batch call
  // resolves to the scalar overload and the result type is a lie.
  getSymbolAtLocation(nodes: readonly unknown[]): Promise<(Sym | undefined)[]>;
  getSymbolAtLocation(node: unknown): Promise<Sym | undefined>;
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
  close(): Promise<void>;
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

/**
 * The name a specifier publishes locally: `B` in `{ A as B }`, `A` in `{ A }`.
 * The LAST identifier, since only the aliased form has two.
 */
function localNameOf(spec: Node): string {
  const identifiers: string[] = [];
  forEachChildSafe(spec, (child) => {
    if (child.kind === SyntaxKind.Identifier) identifiers.push(safeText(child));
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
    if (child.kind === SyntaxKind.Identifier) identifiers.push(safeText(child));
  });
  return identifiers[0] ?? "";
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
  if (configs.length === 0) throw new Error("analysis requires at least one tsconfig path");
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
 * `pin` when it contains `derived`, and `derived` otherwise.
 *
 * Containment is tested on whole segments -- `${pin}/` -- because `/repo/pack`
 * is not an ancestor of `/repo/package`, the same trap `commonRootDir` compares
 * segments to avoid.
 */
function pinnedRoot(pin: string | undefined, derived: string): string {
  if (pin === undefined) return derived;
  const abs = toPosix(resolve(pin));
  return derived === abs || derived.startsWith(`${abs}/`) ? abs : derived;
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
async function expandReferences(
  api: InstanceType<typeof API>,
  initial: readonly string[],
): Promise<{
  snapshot: Awaited<ReturnType<InstanceType<typeof API>["updateSnapshot"]>>;
  configs: string[];
}> {
  const open = [...initial];
  const visited = new Set(open.map((c) => c.toLowerCase()));
  let snapshot = await api.updateSnapshot({ openProjects: open });

  for (let depth = 0; depth < MAX_REFERENCE_DEPTH; depth++) {
    const added: string[] = [];
    for (const project of snapshot.getProjects()) {
      if ((await project.program.getSourceFileNames()).length > 0) continue;
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
    snapshot = await api.updateSnapshot({ openProjects: open });
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
   * Read each file's leading comment for a generator's banner. On by default.
   *
   * Its own switch because it is the most opinionated rule here -- it decides
   * from prose that a machine wrote the file -- and every opinion this tool
   * holds has to be turnable off without dragging the others with it.
   */
  bannerScan?: boolean;
  /**
   * Globs, matched against repo-relative paths, whose files are not analyzed.
   * The escape hatch for generated code that declares nothing.
   */
  exclude?: readonly string[];
  /**
   * The directory every repo-relative path is measured from, when the caller
   * knows it. Defaults to `commonRootDir` of the configs actually opened.
   *
   * That default is DERIVED from the config set, which makes it move when the
   * config set does: narrow a monorepo run to one workspace and the root
   * collapses into that workspace, so the same file is `src/a.ts` in one run
   * and `tools/alpha/src/a.ts` in the next. Those paths are the cache keys,
   * the module names finding ids derive from, and what the report prints, so
   * a caller that knows the root of the tree it was pointed at should say so
   * and get the same answers at every scope.
   *
   * Honoured only when it CONTAINS the derived root. A pin below it would put
   * `../` on the paths of everything above, which repo-relative paths cannot
   * express (see `commonRootDir`); the derived root wins instead, and the
   * caller can see that it did by comparing `Project.root` with what it
   * passed.
   */
  root?: string;
}

/** What `openProject` dropped, by the rule that dropped it. */
export interface ExcludedCounts {
  directory: number;
  banner: number;
  pattern: number;
}

/**
 * True for a program file that is not analyzable source.
 *
 * One predicate, used by `openProject` and by `sourceFileNames`, because the
 * probe's whole job is to predict what the real load will contribute: two
 * copies of these rules that drift apart make it propose a sibling config
 * whose every file `openProject` then discards.
 *
 * `.json` is excluded because `resolveJsonModule` puts every imported data
 * file into the program and the API parses it into a real Array/ObjectLiteral
 * AST. On one application a 126,000-line LOINC code table produced six of the
 * top findings -- clusters of identical array literals inside a single data
 * file, which is duplication only in the sense that a phone book repeats
 * itself -- and contributed those 126k lines to the reported LOC. Resolution
 * is unaffected: this drops the file from ANALYSIS, not from the program.
 *
 * `.d.ts` is doing more work than "skip hand-written declarations": every
 * program lists the ~63 default lib files, so a two-file project comes back
 * with 65 names. Where those libs live is not a constant -- installed into the
 * project they carry a `node_modules` segment, resolved from a global install
 * cache (bun's, pnpm's store) they carry none -- so neither rule can be said
 * to be the one that catches them, and both have to stay.
 */
function isSkippedSourceName(name: string): boolean {
  return name.includes("node_modules") || name.endsWith(".d.ts") || name.endsWith(".json");
}

/**
 * `new API`, with the tsgo executable located the way a packaged underbrush needs.
 *
 * Without this the compiled binary fails with `ENOENT: no such file or
 * directory, open '/$bunfs/package.json'` -- the `typescript` package finds
 * tsgo by reading its own package.json relative to `import.meta.url`, which
 * inside a bundle is a virtual path. The message names a file the user does
 * not have and a directory that does not exist, so it is rewritten here into
 * one that says where underbrush actually looked.
 */
function createAPI(cwd: string): API {
  const tsgo = resolveTsgo();
  try {
    return new API(tsgo.path ? { cwd, tsserverPath: tsgo.path } : { cwd });
  } catch (e) {
    // Only one location is ever tried. Naming the other sends a reader to
    // debug a path this run never looked at.
    const where = tsgo.path
      ? `Used ${tsgo.path}, from ${tsgo.source === "env" ? TSGO_ENV_VAR : "the packaged tsgo/ directory"}.`
      : `Looked for a packaged tsgo at ${tsgo.searched.join(", ")}, then in the installed \`typescript\` package.`;
    throw new Error(
      `could not start the tsgo executable underbrush analyzes with. ${where} ` +
        `Set ${TSGO_ENV_VAR} to point at one. (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

export async function openProject(
  configs: string | string[],
  opts: OpenProjectOptions = {},
): Promise<Project> {
  await initHash();
  const list = (Array.isArray(configs) ? configs : [configs]).map((c) =>
    isAbsolute(c) ? c : resolve(c),
  );

  const api = createAPI(commonRootDir(list));
  const { snapshot, configs: opened } = await expandReferences(api, list);
  // Rooted at the ancestor of everything actually opened: a reference may sit
  // outside the requested config's directory, and a file above the root would
  // get a `../`-prefixed path, breaking the repo-relative-path contract. A
  // caller may pin it higher -- to the directory it was pointed at -- but
  // never lower, for the same reason.
  const root = pinnedRoot(opts.root, commonRootDir(opened));

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
    for (const name of await project.program.getSourceFileNames()) {
      if (isSkippedSourceName(name)) continue;
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
      const sf = (await project.program.getSourceFile(name)) as unknown as
        | SourceFileNode
        | undefined;
      if (!sf) continue;
      // Costs nothing extra: the text is already in hand for the content hash.
      if (!opts.includeGenerated && opts.bannerScan !== false && hasGeneratedBanner(sf.text)) {
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

  /**
   * Module specifier node -> the file its symbol declares, resolved up front.
   *
   * The checker is asynchronous, and `resolveImport` is called from inside
   * synchronous AST walks -- so every specifier is resolved here, once, before
   * anything can ask. `sourceFile.imports` is the whole set the API itself
   * identified as module specifiers, which is a superset of what the four call
   * sites pass; a node missing from this map is therefore a bug rather than an
   * unresolvable import, and is treated as one below.
   *
   * Batched per file, which is also why this is not merely a workaround: one
   * round trip per file replaces one per specifier.
   */
  const declPathOf = new Map<unknown, string | undefined>();
  for (const file of files) {
    const checker = checkerOf.get(file.absPath);
    if (!checker) continue; // impossible; resolveImport reports it loudly
    const specifiers = [...(file.sourceFile.imports ?? [])];
    if (specifiers.length === 0) continue;
    let symbols: (Sym | undefined)[];
    try {
      symbols = await checker.getSymbolAtLocation(specifiers);
    } catch {
      // One unresolvable specifier (missing module, bad path) must not cost
      // the file every other edge, so the batch degrades to one call each.
      symbols = [];
      for (const specifier of specifiers) {
        try {
          symbols.push(await checker.getSymbolAtLocation(specifier));
        } catch {
          symbols.push(undefined);
        }
      }
    }
    specifiers.forEach((specifier, i) => {
      declPathOf.set(specifier, symbols[i]?.declarations?.[0]?.path);
    });
  }

  function resolveImport(from: FileHandle, specifier: unknown): string | undefined {
    if (!checkerOf.has(from.absPath)) {
      // Never silently return undefined here: an unowned file would look like
      // a file with no imports rather than a bug.
      throw new Error(`no checker for ${from.path}; it belongs to no opened project`);
    }
    if (!declPathOf.has(specifier)) {
      // Same reasoning one level down: a specifier nobody pre-resolved reads
      // as an unresolvable import, which is how "this repo has no imports"
      // gets reported as a fact about the repo.
      throw new Error(`unresolved specifier in ${from.path}; it is not among its imports`);
    }
    const path = declPathOf.get(specifier);
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
        ...(d.origins.length > 0 ? { origin: mostFrequent(d.origins) } : {}),
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

/** What a probe found: the file list, and the root those paths are measured from. */
export interface ProbeResult {
  /** Absolute, POSIX-separated, exactly what `openProject` would report. */
  root: string;
  /** Paths relative to `root`, POSIX, deduped, sorted with `compareStrings`. */
  names: string[];
  /**
   * The same names again, split by the config that contributed them: key is
   * the config's absolute path LOWER-CASED, value is that config's own list,
   * sorted the same way.
   *
   * Look values up; never iterate this. Map order is insertion order, which
   * here is whatever order the API handed its projects back in, and nothing
   * downstream may depend on it (AGENTS.md §1).
   *
   * `names` cannot answer "which of these configs added that file", and the
   * question matters: a workspace with two sibling configs needs to keep the
   * one that closes its gap and drop the one that adds nothing. Asking by
   * probing each config alone costs ~35ms of `tsgo` spawn apiece, which is
   * the cost batching exists to avoid, so the breakdown rides along with the
   * union instead.
   *
   * Lower-cased because tsconfig paths reach us with host casing and the same
   * config can arrive spelled two ways; `expandReferences` folds case for its
   * visited set for the same reason.
   *
   * Keys are every config actually OPENED, `expandReferences`'s additions
   * included, so a config the caller never named can appear here. The inverse
   * is the one to keep in mind: a solution config owning no files of its own
   * maps to an EMPTY list, and what it delegates to is listed under the
   * config that owns it. A caller asking "did the config I named contribute
   * anything" therefore gets `no` for every solution config -- safe where the
   * cost of a `no` is analyzing less, which is `configsFor`'s case, and wrong
   * anywhere the cost runs the other way. Closing it means rolling an added
   * config's files up into the entry for the config that pulled it in, which
   * is `expandReferences`'s knowledge and nobody else's.
   */
  byConfig: Map<string, string[]>;
}

/**
 * Paths of a project's source files, without materializing any of them.
 *
 * `openProject` awaits `getSourceFile` per name, which builds the AST; this
 * stops at `getSourceFileNames`. It answers which files a tsconfig would
 * contribute, which is the question "is this sibling config worth loading?"
 * and not a question about what is in them.
 *
 * Two grounds, in order of which one actually decides it.
 *
 * The first is API shape, and it holds at every size. `openProject` returns a
 * `Project` that owns an open `tsgo` connection, a content hash and a
 * `FileHandle` per file, and a checker per file, and it obliges the caller to
 * `close()` it. A caller that wants a file LIST would acquire all of that,
 * read one field, and be responsible for disposing the rest. This returns
 * plain data and disposes itself.
 *
 * The second is cost, and it is honestly size-dependent. Measured, probe
 * against `openProject` on the same configs: 1000 files, 70ms against 340ms
 * (4.9x); 32 files, 45ms against 78ms (1.7x); 2 and 4 files, indistinguishable
 * -- 0.7x to 1.1x, the probe sometimes SLOWER. Both entry points pay the same
 * ~35ms to spawn `tsgo` and load the default lib, and only `openProject` pays
 * per file, so at the size of a small workspace this is free rather than
 * cheaper, and N probes is N x 35ms of fixed cost with nothing bought back.
 * The saving is real where workspaces are large -- a sample monorepo has a
 * single workspace holding 6048 source files -- which is the case this exists
 * for. Probe once over many configs, not once per config.
 *
 * NOT REGRESSION-TESTED: that this materializes nothing. Replace the body with
 * `(await openProject(configs)).files().map((f) => f.path)` and every test
 * still passes -- the agreement test below becomes true by definition, and the
 * measurements above rule out a timing assertion, because there is no
 * threshold between 0.7x and 4.9x that is not either flaky or vacuous. The
 * property is carried by review of this function, not by the suite.
 *
 * The root comes back WITH the names because the caller cannot work it out:
 * it is the common ancestor of every config actually OPENED, and
 * `expandReferences` may open configs the caller never named, so a reference
 * reaching outside the requested config's directory moves the root upwards
 * without the call site ever seeing it. Returning a bare `string[]` would make
 * the list's meaning depend on a value invisible at the call site -- and two
 * lists measured from different roots have no paths in common at all, which
 * reads as "this config covers no files" rather than "these were measured from
 * different places".
 *
 * Root it at the REQUESTED configs instead and a probe of a solution config
 * answers in `../`-prefixed paths, which match nothing the caller holds.
 *
 * Applies the same skip rules as `openProject` so the two agree about what a
 * "source file" is -- a probe that counted `.d.ts` would propose a sibling
 * that adds nothing analyzable, and would count the default lib besides.
 *
 * Deliberately does NOT apply the generated-directory, banner or `--exclude`
 * rules, and only ONE of those three has cost as its reason: the banner sniff
 * reads file text, which is the thing this avoids. `isGeneratedPath` and
 * `isExcludedByPattern` are path-only and free; they are left out because the
 * question here is which files a config CONTRIBUTES, and a config does not
 * stop contributing a file because the analysis later declines to read it.
 *
 * So the answer is a strict SUPERSET of what `openProject` analyzes, and the
 * direction matters to the coverage figure AGENTS.md requires to match on both
 * sides. `scanSourceFiles` -- the denominator -- applies all three rules, so
 * every file this returns beyond what gets analyzed is a file the scan already
 * dropped: it cannot appear in `scan minus covered`, so a wider `covered`
 * neither invents a gap nor hides one. Keep the asymmetry pointing this way.
 * A probe that excluded MORE than the scan is the dangerous direction -- that
 * one reports a gap no flag can close, which is the failure `packageDirs` was
 * written to avoid.
 */
export async function sourceFileNames(configs: readonly string[]): Promise<ProbeResult> {
  const list = configs.map((c) => (isAbsolute(c) ? c : resolve(c)));
  const api = createAPI(commonRootDir(list));
  try {
    const { snapshot, configs: opened } = await expandReferences(api, list);
    const root = commonRootDir(opened);
    const seen = new Set<string>();
    const byConfig = new Map<string, string[]>();
    for (const project of snapshot.getProjects()) {
      const own = new Set<string>();
      for (const name of await project.program.getSourceFileNames()) {
        if (isSkippedSourceName(name)) continue;
        const rel = toPosix(relative(root, name));
        seen.add(rel);
        own.add(rel);
      }
      byConfig.set(project.configFileName.toLowerCase(), [...own].sort(compareStrings));
    }
    // `compareStrings`, never `localeCompare`: under `en-US` collation folds
    // case, so `src/Util.ts` sorts AFTER `src/alpha.ts` and two machines emit
    // differently ordered lists from identical source. See `src/order.ts`.
    return { root, names: [...seen].sort(compareStrings), byConfig };
  } finally {
    // The API holds an open connection to the `tsgo` child it spawned, and
    // that connection keeps the event loop alive. Leak it and nothing is
    // visible in the answer -- the caller's process simply never exits.
    await api.close();
  }
}
