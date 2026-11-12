/**
 * Where shared code should live: a home for an extracted finding, and a
 * destination for the symbols on a suggested cut.
 *
 * Both ask one question. Given the files that will use some code (`users`)
 * and the files that code needs (`deps`), which file can hold it without
 * creating an import cycle? See docs/plans/2026-11-11-placement.md.
 *
 *   bun prototypes/placement.ts <repo-dir> [out-dir]
 *
 * Prints a readable summary. With `out-dir`, also writes `placements.jsonl`:
 * one line per finding or cut, with the suggestion, the naive controls and
 * the code, for blind judging.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { SyntaxKind } from "typescript/ast";
import { scanSourceFiles } from "../src/extract/scope.js";
import { openProject } from "../src/extract/ts-adapter.js";
import { forEachChildSafe, safeText, walk } from "../src/extract/traverse.js";
import type { FileHandle, Node } from "../src/extract/types.js";
import { buildModuleGraph } from "../src/graph/build.js";
import { stronglyConnected } from "../src/graph/metrics.js";
import { buildImportIndex, findingContext } from "../src/report/context.js";
import { compareStrings } from "../src/order.js";
import { discoverConfigs, runReport } from "../src/run.js";

const toPosix = (p: string) => (sep === "\\" ? p.split(sep).join("/") : p);
const dir = toPosix(resolve(process.argv[2] ?? "."));
const outDir = process.argv[3];
// THICKET_GRANULARITY=file places the cuts of file-level tangles. The default
// module report proposes few cuts on large repositories.
const granArg = process.env.THICKET_GRANULARITY ?? "auto";
const granularity: "auto" | "file" | "dir" | number = /^\d+$/.test(granArg) ? Number(granArg) : (granArg as "auto" | "file" | "dir");

// ---------------------------------------------------------------- inputs --

const { json } = await runReport({ dir, cache: false, granularity });
const scan = { includeGenerated: false, bannerScan: true, exclude: [] as string[] };
const discovery = await discoverConfigs(dir, { filter: [], workspaces: true, scan, warn: () => {} });
const project = await openProject(discovery.configs, { ...scan, root: dir });

try {
  const files = project.files();
  const byPath = new Map(files.map((f) => [f.path, f]));
  // Group modules exactly as the report does: per workspace, sized by the
  // files on disk. Without this, module-level cycle checks run on a different
  // grouping from the one the report prints.
  const wsDirs = discovery.workspaceDirs
    .map((abs) => toPosix(relative(project.root, abs)))
    .filter((d) => d !== ".." && !d.startsWith("../"));
  const moduleGraph = buildModuleGraph(project, {
    granularity,
    ...(wsDirs.length === 0
      ? {}
      : { workspaces: { dirs: wsDirs, repoFileCount: scanSourceFiles(project.root, scan).length } }),
  });
  if (moduleGraph.granularity !== json.granularity) {
    console.warn(`module granularity ${moduleGraph.granularity} differs from the report's ${json.granularity}`);
  }

  // ------------------------------------------------------- what a file binds --

  interface Binding {
    local: string;
    exported: string;
    target: string;
    typeOnly: boolean;
  }
  interface FileFacts {
    /** True when every top-level declaration is an interface or a type alias. */
    typesOnly: boolean;
    /** Names declared by an interface or a type alias. Importing one is erased. */
    typeNames: Set<string>;
    bindings: Binding[];
    /** Top-level declarations: name -> [start, end). */
    /**
     * Top-level declarations: name -> each [start, end) that declares it. A
     * name can have several, as with a `const` and an `interface` of one name.
     */
    decls: Map<string, [number, number][]>;
    /** Every identifier use outside import declarations: [name, position]. */
    uses: [string, number][];
  }

  const isTypeOnly = (n: Node) => (n as { isTypeOnly?: boolean }).isTypeOnly === true;
  const firstIdentifier = (n: Node): string | undefined => {
    let found: string | undefined;
    forEachChildSafe(n, (c) => {
      if (found === undefined && c.kind === SyntaxKind.Identifier) found = safeText(c);
    });
    return found;
  };

  const factsCache = new Map<string, FileFacts>();
  function facts(file: FileHandle): FileFacts {
    const hit = factsCache.get(file.path);
    if (hit) return hit;
    const bindings: Binding[] = [];
    const decls = new Map<string, [number, number][]>();
    const uses: [string, number][] = [];
    const typeNames = new Set<string>();
    let runtimeDecls = 0;
    let typeDecls = 0;
    const sf = file.sourceFile;
    forEachChildSafe(sf, (stmt) => {
      if (stmt.kind === SyntaxKind.ImportDeclaration) {
        let specifier: Node | undefined;
        let clause: Node | undefined;
        forEachChildSafe(stmt, (c) => {
          if (c.kind === SyntaxKind.StringLiteral) specifier = c;
          if (c.kind === SyntaxKind.ImportClause) clause = c;
        });
        const target = specifier ? project.resolveImport(file, specifier) : undefined;
        if (!target || !clause) return;
        const declType = isTypeOnly(clause);
        forEachChildSafe(clause, (c) => {
          if (c.kind === SyntaxKind.Identifier) {
            bindings.push({ local: safeText(c), exported: "default", target, typeOnly: declType });
          } else if (c.kind === SyntaxKind.NamespaceImport) {
            const local = firstIdentifier(c);
            if (local) bindings.push({ local, exported: "*", target, typeOnly: declType });
          } else if (c.kind === SyntaxKind.NamedImports) {
            forEachChildSafe(c, (spec) => {
              const ids: string[] = [];
              forEachChildSafe(spec, (x) => {
                if (x.kind === SyntaxKind.Identifier) ids.push(safeText(x));
              });
              if (ids.length === 0) return;
              bindings.push({
                local: ids[ids.length - 1]!,
                exported: ids[0]!,
                target,
                typeOnly: declType || isTypeOnly(spec),
              });
            });
          }
        });
        return;
      }
      for (const name of declaredNames(stmt)) decls.set(name, [...(decls.get(name) ?? []), [stmt.getStart(), stmt.getEnd()]]);
      if (stmt.kind === SyntaxKind.InterfaceDeclaration || stmt.kind === SyntaxKind.TypeAliasDeclaration) {
        typeDecls++;
        for (const name of declaredNames(stmt)) typeNames.add(name);
      }
      else if (stmt.kind !== SyntaxKind.ExportDeclaration && stmt.kind !== SyntaxKind.EndOfFile) runtimeDecls++;
      walk(stmt, (n) => {
        if (n.kind === SyntaxKind.Identifier) uses.push([safeText(n), n.getStart()]);
      });
    });
    const out = { typesOnly: typeDecls > 0 && runtimeDecls === 0, typeNames, bindings, decls, uses };
    factsCache.set(file.path, out);
    return out;
  }

  function declaredNames(stmt: Node): string[] {
    switch (stmt.kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration: {
        const name = firstIdentifier(stmt);
        return name ? [name] : [];
      }
      case SyntaxKind.VariableStatement: {
        // Only the statement's own declarators. A walk also finds the locals
        // inside a function body, and each one then looked like a top-level
        // helper that the moved code needs.
        const names: string[] = [];
        forEachChildSafe(stmt, (list) => {
          if (list.kind !== SyntaxKind.VariableDeclarationList) return;
          forEachChildSafe(list, (n) => {
            if (n.kind !== SyntaxKind.VariableDeclaration) return;
            const name = firstIdentifier(n);
            if (name) names.push(name);
          });
        });
        return names;
      }
      default:
        return [];
    }
  }

  /** What code in [start, end) of `file` needs from elsewhere. */
  function needs(file: FileHandle, start: number, end: number) {
    const f = facts(file);
    const inside = new Set(f.uses.filter(([, at]) => at >= start && at < end).map(([n]) => n));
    const imports = f.bindings.filter((b) => inside.has(b.local));
    const locals = [...f.decls.entries()]
      .filter(([name, spans]) => inside.has(name) && !spans.some(([s, e]) => (s >= start && e <= end) || (start >= s && end <= e)))
      .map(([name]) => name);
    return { imports, locals };
  }

  function inSpan(file: FileHandle, name: string, at: number): boolean {
    return (facts(file).decls.get(name) ?? []).some(([s, e]) => at >= s && at < e);
  }

  /** Bindings in `file` used only inside the given ranges. Moving that code drops them. */
  function onlyUsedIn(file: FileHandle, ranges: [number, number][]): Binding[] {
    const f = facts(file);
    const inRange = (at: number) => ranges.some(([s, e]) => at >= s && at < e);
    return f.bindings.filter((b) => {
      const sites = f.uses.filter(([n]) => n === b.local);
      return sites.length > 0 && sites.every(([, at]) => inRange(at));
    });
  }

  // ----------------------------------------------------------- the graphs --

  const fileEdges = new Map<string, Set<string>>();
  for (const file of files) fileEdges.set(file.path, new Set(project.importsOf(file)));
  const importIndex = buildImportIndex(
    files.map((f) => f.path),
    (p) => [...(fileEdges.get(p) ?? [])].sort(compareStrings),
    (p) => project.reexportsOf(byPath.get(p)!),
  );

  type Edges = Map<string, Set<string>>;
  const clone = (g: Edges): Edges => new Map([...g].map(([k, v]) => [k, new Set(v)]));

  type Components = Map<string, { id: string; size: number }>;
  function cyclic(g: Edges, group: (path: string) => string): Components {
    // Node -> its strongly connected component, for components over 1.
    const nodes = new Set<string>();
    const adj = new Map<string, Set<string>>();
    for (const [from, tos] of g) {
      const a = group(from);
      nodes.add(a);
      for (const to of tos) {
        const b = group(to);
        nodes.add(b);
        if (a === b) continue;
        if (!adj.has(a)) adj.set(a, new Set());
        adj.get(a)!.add(b);
      }
    }
    const sorted = [...nodes].sort(compareStrings);
    const adjacency = new Map([...adj].map(([k, v]) => [k, [...v].sort(compareStrings)]));
    const out: Components = new Map();
    for (const scc of stronglyConnected(sorted, adjacency)) {
      if (scc.length > 1) for (const n of scc) out.set(n, { id: scc[0]!, size: scc.length });
    }
    return out;
  }

  const moduleOf = (path: string): string => {
    const m = moduleGraph.moduleOf[path];
    if (m !== undefined) return m;
    // A new file joins the module of a file beside it, in the same directory.
    // With no such file it is a module of its own.
    const d = path.split("/").slice(0, -1).join("/");
    const sibling = files
      .map((f) => f.path)
      .filter((p) => p.split("/").slice(0, -1).join("/") === d)
      .sort(compareStrings)[0];
    return sibling === undefined ? path : (moduleGraph.moduleOf[sibling] ?? path);
  };
  const before = { file: cyclic(fileEdges, (p) => p), module: cyclic(fileEdges, moduleOf) };
  const moduleDeps = new Set<string>();
  const knownModules = new Set(Object.values(moduleGraph.moduleOf));
  for (const [from, tos] of fileEdges) for (const to of tos) moduleDeps.add(`${moduleOf(from)}\u0000${moduleOf(to)}`);

  // ------------------------------------------------------------- packages --

  // A package is the nearest directory above a file that holds a
  // package.json. Code in one package can import another only when its
  // package.json depends on it, or when its files already import it.
  const pkgCache = new Map<string, string>();
  const parentDir = (d: string) => d.split("/").slice(0, -1).join("/");
  function pkgOf(path: string): string {
    let d = parentDir(path);
    const seen: string[] = [];
    let found: string | undefined;
    for (;;) {
      found = pkgCache.get(d);
      if (found !== undefined) break;
      seen.push(d);
      if (existsSync(join(dir, d, "package.json"))) {
        found = d;
        break;
      }
      if (d === "") {
        found = "";
        break;
      }
      d = parentDir(d);
    }
    for (const s of seen) pkgCache.set(s, found);
    return found;
  }
  const pkgInfoCache = new Map<string, { name?: string; deps: Set<string> }>();
  function pkgInfo(p: string) {
    let info = pkgInfoCache.get(p);
    if (info) return info;
    try {
      const j = JSON.parse(readFileSync(join(dir, p, "package.json"), "utf8"));
      const deps = [j.dependencies, j.devDependencies, j.peerDependencies].flatMap((o) => Object.keys(o ?? {}));
      info = { name: typeof j.name === "string" ? j.name : undefined, deps: new Set(deps) };
    } catch {
      info = { deps: new Set() };
    }
    pkgInfoCache.set(p, info);
    return info;
  }
  const pkgImports = new Set<string>();
  for (const [from, tos] of fileEdges) for (const to of tos) pkgImports.add(`${pkgOf(from)}\u0000${pkgOf(to)}`);
  const allPkgs = [...new Set(files.map((f) => pkgOf(f.path)))].sort(compareStrings);
  const canImport = (from: string, to: string) => {
    if (from === to || pkgImports.has(`${from}\u0000${to}`)) return true;
    const name = pkgInfo(to).name;
    return name !== undefined && pkgInfo(from).deps.has(name);
  };

  // Never place code in generated output. The banner scan misses some
  // generators, so the name is checked too.
  const generated = (p: string) => /\.gen\.[cm]?tsx?$|\.generated\.|(^|\/)(__)?generated(__)?\//.test(p);

  // ------------------------------------------------------------- placement --

  type Kind = "base" | "shared" | "dependency" | "user" | "new";
  const KIND_ORDER: Kind[] = ["base", "shared", "dependency", "user", "new"];

  interface Verdict {
    home: string;
    kind: Kind;
    /** Every user's package can import the home, and the home can import every dependency. */
    reachable: boolean;
    /** Runtime code in a types-only file, or a type in a file of runtime code. */
    misfit: boolean;
    addedEdges: number;
    removedEdges: number;
    /**
     * Edges the moved code relies on that sit inside a cycle, new or already
     * there. Moving more code across a cyclic edge entrenches the cycle.
     */
    edgesInCycle: number;
    /** Added edges between two existing modules that did not depend on each other. */
    newModuleDeps: number;
    /** Files newly in a cycle, or whose cycle grew. Empty means safe. */
    worsens: { file: string[]; module: string[] };
    /** Files no longer in any cycle. */
    frees: { file: number; module: number };
  }

  /**
   * Score one home: add users -> home and home -> deps, remove the edges the
   * move frees, and compare cycles before and after.
   */
  function judge(
    home: string,
    kind: Kind,
    users: string[],
    deps: string[],
    dropped: [string, string][],
    isType: boolean,
  ): Verdict {
    const g = clone(fileEdges);
    let removedEdges = 0;
    for (const [from, to] of dropped) if (g.get(from)?.delete(to)) removedEdges++;
    let addedEdges = 0;
    const added: [string, string][] = [];
    const add = (from: string, to: string) => {
      if (from === to) return;
      if (!g.has(from)) g.set(from, new Set());
      if (!g.get(from)!.has(to)) {
        g.get(from)!.add(to);
        added.push([from, to]);
        addedEdges++;
      }
    };
    for (const u of users) add(u, home);
    for (const d of deps) add(home, d);
    const after = { file: cyclic(g, (p) => p), module: cyclic(g, moduleOf) };
    const worse = (b: Components, a: Components) =>
      [...a].filter(([n, c]) => c.size > (b.get(n)?.size ?? 0)).map(([n]) => n).sort(compareStrings);
    const freed = (b: Components, a: Components) => [...b.keys()].filter((n) => !a.has(n)).length;
    const relied: [string, string][] = [
      ...users.filter((u) => u !== home).map((u): [string, string] => [u, home]),
      ...deps.filter((d) => d !== home).map((d): [string, string] => [home, d]),
    ];
    const edgesInCycle = relied.filter(([x, y]) => {
      const cx = after.file.get(x);
      return cx !== undefined && cx.id === after.file.get(y)?.id;
    }).length;
    const homePkg = pkgOf(home);
    const reachable =
      users.every((u) => canImport(pkgOf(u), homePkg)) && deps.every((d) => canImport(homePkg, pkgOf(d)));
    const newModuleDeps = added.filter(([x, y]) => {
      const mx = moduleOf(x);
      const my = moduleOf(y);
      return mx !== my && knownModules.has(mx) && knownModules.has(my) && !moduleDeps.has(`${mx}\u0000${my}`);
    }).length;
    const existing = byPath.get(home);
    const misfit = existing === undefined ? false : isType ? !facts(existing).typesOnly : facts(existing).typesOnly;
    return {
      home,
      kind,
      reachable,
      misfit: isType ? false : misfit,
      addedEdges,
      removedEdges,
      edgesInCycle,
      newModuleDeps,
      worsens: { file: worse(before.file, after.file), module: worse(before.module, after.module) },
      frees: { file: freed(before.file, after.file), module: freed(before.module, after.module) },
    };
  }

  const safe = (v: Verdict) => v.worsens.file.length === 0 && v.worsens.module.length === 0;
  function rank(vs: Verdict[]): Verdict[] {
    return [...vs].sort(
      (a, b) =>
        Number(b.reachable) - Number(a.reachable) ||
        Number(safe(b)) - Number(safe(a)) ||
        Number(a.misfit) - Number(b.misfit) ||
        b.frees.module - a.frees.module ||
        b.frees.file - a.frees.file ||
        a.edgesInCycle - b.edgesInCycle ||
        a.newModuleDeps - b.newModuleDeps ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.addedEdges - b.addedEdges ||
        compareStrings(a.home, b.home),
    );
  }

  function commonDir(paths: string[]): string {
    const parts = paths.map((p) => p.split("/").slice(0, -1));
    let common = parts[0] ?? [];
    for (const p of parts.slice(1)) {
      let i = 0;
      while (i < common.length && i < p.length && common[i] === p[i]) i++;
      common = common.slice(0, i);
    }
    return common.join("/");
  }

  /** Where a new file would go in package `p`: its `src/` when it has one. */
  function newFileIn(p: string, newName: string): string {
    const prefix = p === "" ? "" : `${p}/`;
    const hasSrc = files.some((f) => f.path.startsWith(`${prefix}src/`));
    return `${prefix}${hasSrc ? "src/" : ""}${newName}.ts`;
  }

  /**
   * Every candidate home for code used by `users` and needing `deps`. `base`
   * is the file of a class every copy's class extends, when there is one.
   */
  function place(
    users: string[],
    deps: string[],
    dropped: [string, string][],
    newName: string,
    isType: boolean,
    base?: string,
  ) {
    // What the report already prints as "every copy imports": shared, and
    // distinctive to these files. A shim is followed to what it forwards.
    const shared = findingContext(users, importIndex, files.length).sharedImports.map((s) => s.forwardsTo ?? s.path);
    const candidates = new Map<string, Kind>();
    if (base !== undefined) candidates.set(base, "base");
    // A shared import is a home only when the code uses something from it.
    // The copies may import it for unrelated reasons.
    for (const s of shared) if (deps.includes(s) && !candidates.has(s)) candidates.set(s, "shared");
    for (const d of deps) if (!candidates.has(d) && !users.includes(d)) candidates.set(d, "dependency");
    for (const u of users) if (!candidates.has(u)) candidates.set(u, "user");
    const userPkgs = [...new Set(users.map(pkgOf))];
    if (userPkgs.length === 1) {
      candidates.set(`${commonDir(users) || "."}/${newName}.ts`.replace(/^\.\//, ""), "new");
    } else {
      // Copies in several packages: a new file goes in a package that every
      // one of them can import. The common directory is often a workspace
      // root, which belongs to no package and which nothing can import.
      // Prefer packages the users' packages already import over ones they
      // only list in package.json. Then the path, so the order is fixed.
      const imported = (p: string) => userPkgs.filter((u) => u === p || pkgImports.has(`${u}\u0000${p}`)).length;
      const hosts = allPkgs
        .filter((p) => userPkgs.every((u) => canImport(u, p)) && deps.every((d) => canImport(p, pkgOf(d))))
        .sort((a, b) => imported(b) - imported(a) || compareStrings(a, b));
      for (const p of hosts.slice(0, 3)) candidates.set(newFileIn(p, newName), "new");
    }
    for (const home of [...candidates.keys()]) if (generated(home)) candidates.delete(home);
    const verdicts = [...candidates].map(([home, kind]) => verdictFor(home, kind, users, deps, dropped, isType));
    return { shared: shared.sort(compareStrings), verdicts: rank(verdicts) };
  }

  function verdictFor(
    home: string,
    kind: Kind,
    users: string[],
    deps: string[],
    dropped: [string, string][],
    isType: boolean,
  ): Verdict {
    return judge(home, kind, users.filter((u) => u !== home), deps.filter((d) => d !== home), dropped, isType);
  }

  /**
   * The file and name of the class that the class around [start, end)
   * extends, as "path#Name". Undefined when the code is not in a class.
   */
  function baseOf(file: FileHandle, start: number, end: number): string | undefined {
    let cls: Node | undefined;
    walk(file.sourceFile, (n) => {
      if (n.kind === SyntaxKind.ClassDeclaration && n.getStart() <= start && n.getEnd() >= end) cls = n;
    });
    if (!cls) return undefined;
    let heritage: Node | undefined;
    forEachChildSafe(cls, (c) => {
      if (c.kind === SyntaxKind.HeritageClause && safeText(c).startsWith("extends")) heritage = c;
    });
    if (!heritage) return undefined;
    let name: string | undefined;
    walk(heritage, (n) => {
      if (name === undefined && n.kind === SyntaxKind.Identifier) name = safeText(n);
    });
    if (name === undefined) return undefined;
    const binding = facts(file).bindings.find((b) => b.local === name);
    if (binding) return `${binding.target}#${binding.exported}`;
    return facts(file).decls.has(name) ? `${file.path}#${name}` : undefined;
  }

  const describe = (v: Verdict) => {
    const bits = [`${v.home} (${v.kind}${v.misfit ? ", types-only file" : ""}, +${v.addedEdges}/-${v.removedEdges} edges)`];
    if (!v.reachable) bits.push("UNREACHABLE across packages");
    if (v.edgesInCycle) bits.push(`${v.edgesInCycle} edges inside a cycle`);
    if (v.newModuleDeps) bits.push(`${v.newModuleDeps} new module dependencies`);
    if (v.frees.module || v.frees.file) bits.push(`frees ${v.frees.module} modules, ${v.frees.file} files from cycles`);
    if (!safe(v)) {
      bits.push(
        `WORSENS ${[...v.worsens.module.map((m) => "module " + m), ...v.worsens.file.slice(0, 3)].slice(0, 4).join(", ")}`,
      );
    }
    return bits.join("; ");
  };

  /** True when directory `d` is `ancestor` or sits below it. "" is the root. */
  const within = (d: string, ancestor: string) => ancestor === "" || d === ancestor || d.startsWith(`${ancestor}/`);

  /**
   * Round 3 arms: the directory a new file would go in, and a control
   * directory that is just as safe but unrelated to the copies. The control
   * sits in any package every copy can import, outside every directory on
   * the path to a copy, and is picked by a hash of the finding id so the
   * choice is fixed.
   */
  function newDirArms(
    id: string,
    users: string[],
    deps: string[],
    dropped: [string, string][],
    isType: boolean,
    verdicts: Verdict[],
  ) {
    const fresh = verdicts.find((v) => v.kind === "new" && v.reachable && safe(v));
    if (!fresh) return {};
    const homeDir = parentDir(fresh.home);
    // Not above a copy, not above the computed directory, and not inside it.
    const onPath = (d: string) =>
      users.some((u) => within(parentDir(u), d)) || within(d, homeDir) || within(homeDir, d);
    const dirs = [...new Set(files.map((f) => f.path).filter((p) => !generated(p)).map(parentDir))]
      .filter((d) => d !== "" && !onPath(d))
      .sort((a, b) => compareStrings(sha(id + a), sha(id + b)));
    for (const d of dirs.slice(0, 40)) {
      const v = verdictFor(`${d}/shared.ts`, "new", users, deps, dropped, isType);
      if (v.reachable && safe(v)) return { newDir: { dir: homeDir, verdict: fresh }, wrongDir: { dir: d, verdict: v } };
    }
    return { newDir: { dir: homeDir, verdict: fresh } };
  }
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  const samples: unknown[] = [];
  const excerpt = (file: FileHandle, start: number, end: number) =>
    file.sourceFile.text.slice(start, end).split("\n").slice(0, 30).join("\n");

  // ------------------------------------------------------ extracted copies --

  let shownDup = 0;
  const tally = {
    findings: 0,
    generated: 0,
    noHome: 0,
    safeBest: 0,
    naiveUnsafe: 0,
    baseBest: 0,
    sharedBest: 0,
    newBest: 0,
    freesCycles: 0,
    drags: 0,
  };
  for (const finding of [...json.duplication, ...json.typeDuplication]) {
    if (finding.tag === "test") continue;
    const copies = finding.occurrences.filter((o) => byPath.has(o.filePath));
    const users = [...new Set(copies.map((o) => o.filePath))].sort(compareStrings);
    if (users.length < 2) continue; // all copies in one file: no import to place
    if (users.every(generated)) {
      // Generated output is regenerated, not refactored.
      tally.generated++;
      continue;
    }
    tally.findings++;
    const deps = new Set<string>();
    const locals = new Set<string>();
    for (const o of copies) {
      const n = needs(byPath.get(o.filePath)!, o.start, o.end);
      for (const b of n.imports) deps.add(b.target);
      for (const l of n.locals) locals.add(`${o.filePath}#${l}`);
    }
    const dropped: [string, string][] = [];
    for (const u of users) {
      const ranges = copies.filter((o) => o.filePath === u).map((o) => [o.start, o.end] as [number, number]);
      const gone = onlyUsedIn(byPath.get(u)!, ranges);
      for (const t of new Set(gone.map((b) => b.target))) {
        // Dropped only if EVERY binding from that target goes.
        const all = facts(byPath.get(u)!).bindings.filter((b) => b.target === t);
        if (all.every((b) => gone.includes(b))) dropped.push([u, t]);
      }
    }
    const isType = json.typeDuplication.includes(finding);
    // Copies that sit in classes sharing one base class can move onto it.
    const bases = new Set(copies.map((o) => baseOf(byPath.get(o.filePath)!, o.start, o.end)));
    const baseKey = bases.size === 1 ? [...bases][0] : undefined;
    const baseFile = baseKey?.split("#")[0];
    const base = baseFile !== undefined && byPath.has(baseFile) ? baseFile : undefined;
    const depList = [...deps].sort(compareStrings);
    const { shared, verdicts } = place(users, depList, dropped, "shared", isType, base);
    const best = verdicts[0];
    const naive = verdictFor(users[0]!, "user", users, depList, dropped, isType);
    if (!best || !best.reachable) {
      // No file every copy's package can import. The report would say a
      // shared package is needed, and name no file.
      tally.noHome++;
      if (!safe(naive)) tally.naiveUnsafe++;
      if (locals.size > 0) tally.drags++;
      if (shownDup < 25) {
        shownDup++;
        console.log(`\n${finding.id}  ${finding.kind}, ${copies.length} copies in ${users.length} files`);
        console.log(`  best:  none. The copies' packages share no package they can all import.`);
      }
      const first = copies[0]!;
      samples.push({
        type: "extract",
        id: finding.id,
        kind: finding.kind,
        copies: copies.map((o) => `${o.filePath}:${o.line}`),
        code: excerpt(byPath.get(first.filePath)!, first.start, first.end),
        needs: depList,
        localHelpers: [...locals].sort(compareStrings),
        suggestion: { home: null, kind: "none", packages: [...new Set(users.map(pkgOf))].sort(compareStrings) },
        controls: {
          firstCopy: naive,
          firstShared: shared[0] ? verdictFor(shared[0], "shared", users, depList, dropped, isType) : undefined,
        },
        alternatives: verdicts.slice(0, 5),
      });
      continue;
    }
    if (best.kind === "base") tally.baseBest++;
    if (safe(best)) tally.safeBest++;
    if (!safe(naive)) tally.naiveUnsafe++;
    if (best.kind === "shared") tally.sharedBest++;
    if (best.kind === "new") tally.newBest++;
    if (best.frees.file > 0) tally.freesCycles++;
    if (locals.size > 0) tally.drags++;
    if (shownDup < 25) {
      shownDup++;
      console.log(`\n${finding.id}  ${finding.kind}, ${copies.length} copies in ${users.length} files`);
      console.log(`  needs: ${[...deps].sort(compareStrings).join(", ") || "nothing imported"}`);
      if (locals.size) console.log(`  also uses, from beside a copy: ${[...locals].sort(compareStrings).join(", ")}`);
      console.log(`  best:  ${describe(best)}`);
      for (const v of verdicts.slice(1, 4)) console.log(`  then:  ${describe(v)}`);
      if (naive !== best) console.log(`  naive: ${describe(naive)}`);
    }
    const first = copies[0]!;
    samples.push({
      type: "extract",
      id: finding.id,
      kind: finding.kind,
      copies: copies.map((o) => `${o.filePath}:${o.line}`),
      code: excerpt(byPath.get(first.filePath)!, first.start, first.end),
      needs: depList,
      localHelpers: [...locals].sort(compareStrings),
      suggestion: best,
      controls: {
        firstCopy: naive,
        firstShared: shared[0] ? verdictFor(shared[0], "shared", users, depList, dropped, isType) : undefined,
      },
      alternatives: verdicts.slice(1, 6),
      ...newDirArms(finding.id, users, depList, dropped, isType, verdicts),
    });
  }

  // ------------------------------------------------------------ moving code --

  type Sym = { target: string; exported: string };

  /**
   * Add every helper the symbols use from beside them, until nothing changes.
   * A helper left behind makes the new home import the owner, and the edge
   * the move was meant to remove comes back. Returns the helpers added.
   */
  function closeOver(symbols: Sym[]): string[] {
    const helpers: string[] = [];
    for (let grew = true; grew; ) {
      grew = false;
      for (const { target, exported } of [...symbols]) {
        const owner = byPath.get(target)!;
        const locals = facts(owner).decls.get(exported)!.flatMap(([s0, e0]) => needs(owner, s0, e0).locals);
        for (const l of [...new Set(locals)].sort(compareStrings)) {
          if (symbols.some((m) => m.target === target && m.exported === l)) continue;
          symbols.push({ target, exported: l });
          helpers.push(`${target}#${l}`);
          grew = true;
        }
      }
    }
    symbols.sort((a, b) => compareStrings(a.target, b.target) || compareStrings(a.exported, b.exported));
    return helpers.sort(compareStrings);
  }

  /** Lines of code the symbols span. */
  function linesOf(symbols: Sym[]): number {
    let n = 0;
    for (const { target, exported } of symbols) {
      const file = byPath.get(target)!;
      for (const [a, b] of facts(file).decls.get(exported)!) n += file.sourceFile.text.slice(a, b).split("\n").length;
    }
    return n;
  }

  /** Close over the helpers, find a home, print it, and record a sample. */
  function placeMove(
    symbols: Sym[],
    meta: Record<string, unknown>,
    tallyCut: { safeBest: number; freesBest: number; withHelpers: number; withSharedHelpers: number; maxHelpers: number },
  ) {
    const seedNames = symbols.map((m) => m.exported);
    // When code that stays also uses a helper, the owner imports it from the
    // new home. That adds no cycle, because the new home no longer imports
    // the owner.
    const helpers = closeOver(symbols);
    const sharedHelpers: string[] = [];
    for (const h of helpers) {
      const [target, l] = h.split("#") as [string, string];
      const owner = byPath.get(target)!;
      const usedByStayer = facts(owner).uses.some(
        ([n, at]) =>
          n === l &&
          !inSpan(owner, l, at) &&
          !symbols.some((m) => m.target === target && inSpan(owner, m.exported, at)),
      );
      if (usedByStayer) sharedHelpers.push(h);
    }
    if (helpers.length) tallyCut.withHelpers++;
    if (sharedHelpers.length) tallyCut.withSharedHelpers++;
    sharedHelpers.sort(compareStrings);
    tallyCut.maxHelpers = Math.max(tallyCut.maxHelpers, helpers.length);
    if (helpers.length) console.log(`  helpers that move too: ${helpers.join(", ")}`);
    if (sharedHelpers.length) console.log(`  of which code that stays also uses: ${sharedHelpers.join(", ")}`);
    const isMoved = (target: string, exported: string) =>
      symbols.some((m) => m.target === target && m.exported === exported);
    const users = new Set<string>();
    const deps = new Set<string>();
    const besides: string[] = [];
    const code: string[] = [];
    for (const { target, exported } of symbols) {
      const owner = byPath.get(target)!;
      const spans = facts(owner).decls.get(exported)!;
      for (const f of files) {
        if (facts(f).bindings.some((b) => b.target === target && b.exported === exported)) users.add(f.path);
      }
      // The owner is a user too when it still calls the symbol after the move.
      const elsewhere = facts(owner).uses.some(
        ([n, at]) => n === exported && !symbols.some((m) => m.target === target && inSpan(owner, m.exported, at)),
      );
      if (elsewhere) users.add(target);
      for (const [a, b] of spans) {
        const n = needs(owner, a, b);
        for (const bind of n.imports) deps.add(bind.target);
        // A helper that stays beside the symbol means the new home imports the owner.
        const stays = n.locals.filter((l) => !isMoved(target, l));
        if (stays.length > 0) {
          deps.add(target);
          besides.push(...stays.map((l) => `${target}#${l}`));
        }
        code.push(excerpt(owner, a, b));
      }
    }
    const dropped: [string, string][] = [];
    for (const u of users) {
      for (const owner of new Set(symbols.map((m) => m.target))) {
        if (u === owner) continue;
        const all = facts(byPath.get(u)!).bindings.filter((b) => b.target === owner);
        if (all.length > 0 && all.every((b) => isMoved(owner, b.exported))) dropped.push([u, owner]);
      }
    }
    // Named after the first declaration the move was asked for.
    const name = seedNames[0]!;
    const isType = symbols.every((m) => facts(byPath.get(m.target)!).typesOnly);
    const userList = [...users].sort(compareStrings);
    const depList = [...deps].sort(compareStrings);
    const { verdicts } = place(userList, depList, dropped, name, isType);
    const best = verdicts[0]!;
    const importer = userList.find((u) => !symbols.some((m) => m.target === u));
    if (safe(best)) tallyCut.safeBest++;
    if (best.frees.module > 0 || best.frees.file > 0) tallyCut.freesBest++;
    console.log(`  used by: ${userList.join(", ")}`);
    if (besides.length) console.log(`  needs beside it: ${besides.join(", ")}`);
    console.log(`  best:  ${describe(best)}`);
    for (const v of verdicts.slice(1, 3)) console.log(`  then:  ${describe(v)}`);
    samples.push({
      ...meta,
      symbols: symbols.map((m) => `${m.target}#${m.exported}`),
      helpers,
      sharedHelpers,
      users: userList,
      code: code.join("\n\n"),
      suggestion: best,
      controls: {
        importer: importer ? verdictFor(importer, "user", userList, depList, dropped, isType) : undefined,
      },
      alternatives: verdicts.slice(1, 6),
    });
    return best;
  }


  // ----------------------------------------------------------- move search --

  // The cut search scores one edge at a time. A move can remove several
  // edges into one file at once, when they all import the same declaration.
  // So this search tries moves: a declaration that a file in the tangle
  // imports, with its helpers. Its cost is the code it moves.

  /** An import of a type is erased, whether or not it says `import type`. */
  const erased = (b: Binding) => b.typeOnly || facts(byPath.get(b.target)!).typeNames.has(b.exported);

  type Graph = Map<string, Map<string, boolean>>; // from -> to -> runtime
  function largest(nodes: string[], g: Graph, runtimeOnly: boolean): number {
    const adj = new Map<string, string[]>();
    for (const [from, tos] of g) {
      adj.set(from, [...tos].filter(([, rt]) => rt || !runtimeOnly).map(([t]) => t).sort(compareStrings));
    }
    return stronglyConnected([...nodes].sort(compareStrings), adj).reduce((m, c) => Math.max(m, c.length), 0);
  }

  function tangleGraph(tangle: string[]): Graph {
    const inT = new Set(tangle);
    const g: Graph = new Map();
    for (const x of tangle) {
      const tos = new Map<string, boolean>();
      for (const to of fileEdges.get(x) ?? []) {
        if (!inT.has(to) || to === x) continue;
        const bs = facts(byPath.get(x)!).bindings.filter((b) => b.target === to);
        // No bindings: a re-export or a side-effect import, which runs.
        tos.set(to, bs.length === 0 || bs.some((b) => !erased(b)));
      }
      g.set(x, tos);
    }
    return g;
  }

  /** The tangle's graph after `symbols` leave `owner` for a new file. */
  function afterMove(tangle: string[], base: Graph, owner: string, symbols: Sym[]): { g: Graph; nodes: string[] } {
    const H = `${owner}#moved`;
    const moved = new Set(symbols.map((m) => m.exported));
    const g: Graph = new Map([...base].map(([k, v]) => [k, new Map(v)]));
    const h = new Map<string, boolean>();
    g.set(H, h);
    for (const x of tangle) {
      if (x === owner || !g.get(x)!.has(owner)) continue;
      const bs = facts(byPath.get(x)!).bindings.filter((b) => b.target === owner);
      const go = bs.filter((b) => moved.has(b.exported));
      if (go.length === 0) continue;
      const stay = bs.filter((b) => !moved.has(b.exported));
      g.get(x)!.set(H, go.some((b) => !erased(b)));
      // A re-export from the owner has no binding, so `bs` cannot see it.
      // Keep the edge unless every import from the owner left.
      const reexports = project.reexportsOf(byPath.get(x)!).some((r) => r === owner);
      if (stay.length === 0 && !reexports) g.get(x)!.delete(owner);
      else g.get(x)!.set(owner, stay.some((b) => !erased(b)) || reexports);
    }
    const ownerFile = byPath.get(owner)!;
    const of = facts(ownerFile);
    const spans = symbols.flatMap((m) => of.decls.get(m.exported)!);
    const inMoved = (at: number) => spans.some(([a, b]) => at >= a && at < b);
    for (const [a, b] of spans) {
      for (const bind of needs(ownerFile, a, b).imports) {
        if (!g.has(bind.target) || bind.target === H) continue;
        const rt = !erased(bind);
        h.set(bind.target, (h.get(bind.target) ?? false) || rt);
      }
    }
    // The owner imports the new file when code that stays uses what moved.
    const stays = of.uses.filter(([n, at]) => moved.has(n) && !inMoved(at));
    if (stays.length > 0) g.get(owner)!.set(H, stays.some(([n]) => !of.typeNames.has(n)));
    return { g, nodes: [...tangle, H] };
  }

  interface MoveChoice {
    owner: string;
    seeds: string[];
    symbols: Sym[];
    lines: number;
    residual: number;
    runtimeResidual: number;
  }

  function searchMoves(tangle: string[]): { best?: MoveChoice; tried: number } {
    const inT = new Set(tangle);
    const base = tangleGraph(tangle);
    const start = tangle.length;
    // Seeds: each declaration a tangle file imports from another, alone, and
    // every declaration on one edge together. The second is what a cut moves,
    // so this search cannot do worse than the cut search.
    const seeds = new Map<string, { owner: string; names: string[] }>();
    const addSeed = (owner: string, names: string[]) => {
      const of = facts(byPath.get(owner)!);
      if (names.length === 0 || !names.every((n) => of.decls.has(n))) return;
      const sorted = [...new Set(names)].sort(compareStrings);
      seeds.set(`${owner}#${sorted.join(",")}`, { owner, names: sorted });
    };
    for (const x of [...tangle].sort(compareStrings)) {
      const byTarget = new Map<string, string[]>();
      for (const b of facts(byPath.get(x)!).bindings) {
        if (!inT.has(b.target) || b.target === x) continue;
        addSeed(b.target, [b.exported]);
        byTarget.set(b.target, [...(byTarget.get(b.target) ?? []), b.exported]);
      }
      for (const [t, names] of byTarget) addSeed(t, names);
    }
    const seen = new Set<string>();
    let best: MoveChoice | undefined;
    let tried = 0;
    for (const [, { owner, names }] of [...seeds].sort(([a], [b]) => compareStrings(a, b))) {
      const symbols: Sym[] = names.map((n) => ({ target: owner, exported: n }));
      closeOver(symbols);
      const key = `${owner}#${symbols.map((m) => m.exported).join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tried++;
      const { g, nodes } = afterMove(tangle, base, owner, symbols);
      const residual = largest(nodes, g, false);
      if (residual >= start) continue;
      if (residual > 1 && residual > start * (2 / 3)) continue;
      const choice: MoveChoice = {
        owner,
        seeds: names,
        symbols,
        lines: linesOf(symbols),
        residual,
        runtimeResidual: largest(nodes, g, true),
      };
      const better =
        best === undefined ||
        choice.residual - best.residual ||
        choice.runtimeResidual - best.runtimeResidual ||
        choice.lines - best.lines;
      if (best === undefined || (typeof better === "number" && better < 0)) best = choice;
    }
    return { best, tried };
  }

  // ------------------------------------------------------------ moved cuts --

  // Every symbol crossing a cut moves together. Moving one of three leaves the
  // edge in place, and the edge is what the cut removes.
  const tallyCut = { cuts: 0, safeBest: 0, freesBest: 0, unresolved: 0, withHelpers: 0, withSharedHelpers: 0, maxHelpers: 0 };
  console.log("\n--- cuts ---");
  for (const cycle of json.cycles) {
    for (const cut of cycle.cuts) {
      const fromFiles = cut.files.filter((p) => byPath.has(p));
      const moved = new Map<string, { target: string; exported: string }>();
      for (const p of fromFiles) {
        for (const b of facts(byPath.get(p)!).bindings) {
          if (moduleOf(b.target) !== cut.to) continue;
          moved.set(`${b.target}#${b.exported}`, { target: b.target, exported: b.exported });
        }
      }
      const symbols = [...moved].sort(([a], [b]) => compareStrings(a, b)).map(([, v]) => v);
      const missing = symbols.filter((m) => !byPath.get(m.target) || !facts(byPath.get(m.target)!).decls.has(m.exported));
      console.log(`\n${cycle.id} cut ${cut.from} -> ${cut.to}: move ${symbols.map((m) => m.exported).join(", ")}`);
      if (symbols.length === 0) {
        // A side-effect import binds nothing, so there is nothing to move.
        tallyCut.unresolved++;
        console.log("  cannot place: the cut edge binds no symbols");
        continue;
      }
      if (missing.length > 0) {
        // A namespace import or a re-export: no one declaration to move.
        tallyCut.unresolved++;
        console.log(`  cannot place: ${missing.map((m) => `${m.exported} from ${m.target}`).join(", ")}`);
        continue;
      }
      tallyCut.cuts++;
      placeMove(symbols, { type: "move", id: cycle.id, cut: { from: cut.from, to: cut.to } }, tallyCut);
    }
  }


  // Run the move search on every tangle, beside the cut search.
  const tallySearch = { tangles: 0, edgeCut: 0, moveFix: 0, onlyMove: 0, onlyEdge: 0, smallerResidual: 0, fewerLines: 0, safeBest: 0, freesBest: 0, withHelpers: 0, withSharedHelpers: 0, maxHelpers: 0 };
  const searchRows: string[] = [];
  console.log("\n--- move search ---");
  for (const cycle of json.cycles) {
    const tangle = cycle.modules.filter((p) => byPath.has(p));
    if (tangle.length !== cycle.modules.length) continue; // module granularity: not handled yet
    tallySearch.tangles++;
    const { best, tried } = searchMoves(tangle);
    const cut = cycle.cuts[0];
    let cutLines: number | undefined;
    if (cut) {
      tallySearch.edgeCut++;
      const syms: Sym[] = [];
      for (const p of cut.files) {
        for (const b of facts(byPath.get(p)!).bindings) {
          if (b.target !== cut.to) continue;
          if (!facts(byPath.get(b.target)!).decls.has(b.exported)) continue;
          if (!syms.some((m) => m.exported === b.exported)) syms.push({ target: b.target, exported: b.exported });
        }
      }
      if (syms.length) {
        closeOver(syms);
        cutLines = linesOf(syms);
      }
    }
    if (best) tallySearch.moveFix++;
    if (best && !cut) tallySearch.onlyMove++;
    if (!best && cut) tallySearch.onlyEdge++;
    if (best && cut && best.residual < cycle.residual) tallySearch.smallerResidual++;
    if (best && cut && cutLines !== undefined && best.lines < cutLines) tallySearch.fewerLines++;
    searchRows.push(
      `${cycle.id}\t${tangle.length}\tedge:${cut ? `${cycle.residual}/${cutLines ?? "?"}l` : "-"}\tmove:${best ? `${best.residual}/${best.runtimeResidual}rt/${best.lines}l` : "-"}\ttried:${tried}`,
    );
    if (!best) continue;
    console.log(
      `\n${cycle.id} (${tangle.length} files): move ${best.seeds.join(", ")} out of ${best.owner}` +
        ` -> leaves ${best.residual} (${best.runtimeResidual} at runtime), ${best.lines} lines` +
        (cut ? `; the edge cut leaves ${cycle.residual}, ${cutLines ?? "?"} lines` : "; the edge search found no cut"),
    );
    placeMove(
      best.seeds.map((n) => ({ target: best.owner, exported: n })),
      {
        type: "search",
        id: cycle.id,
        size: tangle.length,
        owner: best.owner,
        seeds: best.seeds,
        lines: best.lines,
        residual: best.residual,
        runtimeResidual: best.runtimeResidual,
        edgeCut: cut ? { from: cut.from, to: cut.to, residual: cycle.residual, lines: cutLines } : null,
      },
      tallySearch,
    );
  }
  console.log("\n--- search table ---\n" + searchRows.join("\n"));

  console.log("\n--- summary ---");
  console.log(JSON.stringify({ extract: tally, move: tallyCut, search: tallySearch }));
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "placements.jsonl"), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  }
} finally {
  await project.close();
}
