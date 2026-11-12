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
import { mkdirSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------- inputs --

const { json } = await runReport({ dir, cache: false });
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
    granularity: "auto",
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
    bindings: Binding[];
    /** Top-level declarations: name -> [start, end). */
    decls: Map<string, [number, number]>;
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
    const decls = new Map<string, [number, number]>();
    const uses: [string, number][] = [];
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
      for (const name of declaredNames(stmt)) decls.set(name, [stmt.getStart(), stmt.getEnd()]);
      if (stmt.kind === SyntaxKind.InterfaceDeclaration || stmt.kind === SyntaxKind.TypeAliasDeclaration) typeDecls++;
      else if (stmt.kind !== SyntaxKind.ExportDeclaration && stmt.kind !== SyntaxKind.EndOfFile) runtimeDecls++;
      walk(stmt, (n) => {
        if (n.kind === SyntaxKind.Identifier) uses.push([safeText(n), n.getStart()]);
      });
    });
    const out = { typesOnly: typeDecls > 0 && runtimeDecls === 0, bindings, decls, uses };
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
        const names: string[] = [];
        walk(stmt, (n) => {
          if (n.kind !== SyntaxKind.VariableDeclaration) return;
          const name = firstIdentifier(n);
          if (name) names.push(name);
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
      .filter(([name, [s, e]]) => inside.has(name) && !(s >= start && e <= end) && !(start >= s && end <= e))
      .map(([name]) => name);
    return { imports, locals };
  }

  function inSpan(file: FileHandle, name: string, at: number): boolean {
    const span = facts(file).decls.get(name);
    return span !== undefined && at >= span[0] && at < span[1];
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

  // ------------------------------------------------------------- placement --

  type Kind = "shared" | "dependency" | "user" | "new";
  const KIND_ORDER: Kind[] = ["shared", "dependency", "user", "new"];

  interface Verdict {
    home: string;
    kind: Kind;
    /** Runtime code in a types-only file, or a type in a file of runtime code. */
    misfit: boolean;
    addedEdges: number;
    removedEdges: number;
    /** Added edges that land inside a cycle: the tangle gets one more strand. */
    addedInCycle: number;
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
    const addedInCycle = added.filter(([x, y]) => {
      const cx = after.file.get(x);
      return cx !== undefined && cx.id === after.file.get(y)?.id;
    }).length;
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
      misfit: isType ? false : misfit,
      addedEdges,
      removedEdges,
      addedInCycle,
      newModuleDeps,
      worsens: { file: worse(before.file, after.file), module: worse(before.module, after.module) },
      frees: { file: freed(before.file, after.file), module: freed(before.module, after.module) },
    };
  }

  const safe = (v: Verdict) => v.worsens.file.length === 0 && v.worsens.module.length === 0;
  function rank(vs: Verdict[]): Verdict[] {
    return [...vs].sort(
      (a, b) =>
        Number(safe(b)) - Number(safe(a)) ||
        Number(a.misfit) - Number(b.misfit) ||
        b.frees.module - a.frees.module ||
        b.frees.file - a.frees.file ||
        a.addedInCycle - b.addedInCycle ||
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

  /** Every candidate home for code used by `users` and needing `deps`. */
  function place(users: string[], deps: string[], dropped: [string, string][], newName: string, isType: boolean) {
    // What the report already prints as "every copy imports": shared, and
    // distinctive to these files. A shim is followed to what it forwards.
    const shared = findingContext(users, importIndex, files.length).sharedImports.map((s) => s.forwardsTo ?? s.path);
    const candidates = new Map<string, Kind>();
    for (const s of shared) candidates.set(s, "shared");
    for (const d of deps) if (!candidates.has(d) && !users.includes(d)) candidates.set(d, "dependency");
    for (const u of users) if (!candidates.has(u)) candidates.set(u, "user");
    const fresh = `${commonDir(users) || "."}/${newName}.ts`.replace(/^\.\//, "");
    candidates.set(fresh, "new");
    const verdicts = [...candidates].map(([home, kind]) =>
      judge(home, kind, users.filter((u) => u !== home), deps.filter((d) => d !== home), dropped, isType),
    );
    return { shared: shared.sort(compareStrings), verdicts: rank(verdicts) };
  }

  const describe = (v: Verdict) => {
    const bits = [`${v.home} (${v.kind}${v.misfit ? ", types-only file" : ""}, +${v.addedEdges}/-${v.removedEdges} edges)`];
    if (v.addedInCycle) bits.push(`${v.addedInCycle} edges inside a cycle`);
    if (v.newModuleDeps) bits.push(`${v.newModuleDeps} new module dependencies`);
    if (v.frees.module || v.frees.file) bits.push(`frees ${v.frees.module} modules, ${v.frees.file} files from cycles`);
    if (!safe(v)) {
      bits.push(
        `WORSENS ${[...v.worsens.module.map((m) => "module " + m), ...v.worsens.file.slice(0, 3)].slice(0, 4).join(", ")}`,
      );
    }
    return bits.join("; ");
  };

  const samples: unknown[] = [];
  const excerpt = (file: FileHandle, start: number, end: number) =>
    file.sourceFile.text.slice(start, end).split("\n").slice(0, 30).join("\n");

  // ------------------------------------------------------ extracted copies --

  let shownDup = 0;
  const tally = { findings: 0, safeBest: 0, naiveUnsafe: 0, sharedBest: 0, newBest: 0, freesCycles: 0, drags: 0 };
  for (const finding of [...json.duplication, ...json.typeDuplication]) {
    if (finding.tag === "test") continue;
    const copies = finding.occurrences.filter((o) => byPath.has(o.filePath));
    const users = [...new Set(copies.map((o) => o.filePath))].sort(compareStrings);
    if (users.length < 2) continue; // all copies in one file: no import to place
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
    const { shared, verdicts } = place(users, [...deps].sort(compareStrings), dropped, "shared", isType);
    const best = verdicts[0]!;
    const naive = verdicts.find((v) => v.home === users[0])!;
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
      needs: [...deps].sort(compareStrings),
      localHelpers: [...locals].sort(compareStrings),
      suggestion: best,
      controls: {
        firstCopy: naive,
        firstShared: shared[0] ? verdicts.find((v) => v.home === shared[0]) : undefined,
      },
      alternatives: verdicts.slice(1, 6),
    });
  }

  // ------------------------------------------------------------ moved cuts --

  // Every symbol crossing a cut moves together. Moving one of three leaves the
  // edge in place, and the edge is what the cut removes.
  const tallyCut = { cuts: 0, safeBest: 0, freesBest: 0, unresolved: 0 };
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
      const isMoved = (target: string, exported: string) =>
        symbols.some((m) => m.target === target && m.exported === exported);
      const users = new Set<string>();
      const deps = new Set<string>();
      const besides: string[] = [];
      const code: string[] = [];
      for (const { target, exported } of symbols) {
        const owner = byPath.get(target)!;
        const span = facts(owner).decls.get(exported)!;
        for (const f of files) {
          if (facts(f).bindings.some((b) => b.target === target && b.exported === exported)) users.add(f.path);
        }
        // The owner is a user too when it still calls the symbol after the move.
        const elsewhere = facts(owner).uses.some(
          ([n, at]) => n === exported && (at < span[0] || at >= span[1]) && !symbols.some((m) => m.target === target && inSpan(owner, m.exported, at)),
        );
        if (elsewhere) users.add(target);
        const n = needs(owner, span[0], span[1]);
        for (const b of n.imports) deps.add(b.target);
        // A helper that stays beside the symbol means the new home imports the owner.
        const stays = n.locals.filter((l) => !isMoved(target, l));
        if (stays.length > 0) {
          deps.add(target);
          besides.push(...stays.map((l) => `${target}#${l}`));
        }
        code.push(excerpt(owner, span[0], span[1]));
      }
      const dropped: [string, string][] = [];
      for (const u of users) {
        for (const owner of new Set(symbols.map((m) => m.target))) {
          if (u === owner) continue;
          const all = facts(byPath.get(u)!).bindings.filter((b) => b.target === owner);
          if (all.length > 0 && all.every((b) => isMoved(owner, b.exported))) dropped.push([u, owner]);
        }
      }
      const name = symbols.length === 1 ? symbols[0]!.exported : "moved";
      const isType = symbols.every((m) => facts(byPath.get(m.target)!).typesOnly);
      const userList = [...users].sort(compareStrings);
      const { verdicts } = place(userList, [...deps].sort(compareStrings), dropped, name, isType);
      const best = verdicts[0]!;
      if (safe(best)) tallyCut.safeBest++;
      if (best.frees.module > 0 || best.frees.file > 0) tallyCut.freesBest++;
      console.log(`  used by: ${userList.join(", ")}`);
      if (besides.length) console.log(`  needs beside it: ${besides.join(", ")}`);
      console.log(`  best:  ${describe(best)}`);
      for (const v of verdicts.slice(1, 3)) console.log(`  then:  ${describe(v)}`);
      samples.push({
        type: "move",
        id: cycle.id,
        cut: { from: cut.from, to: cut.to },
        symbols: symbols.map((m) => `${m.target}#${m.exported}`),
        users: userList,
        code: code.join("\n\n"),
        suggestion: best,
        controls: { importer: verdicts.find((v) => v.home === userList.find((u) => !symbols.some((m) => m.target === u))) },
        alternatives: verdicts.slice(1, 6),
      });
    }
  }

  console.log("\n--- summary ---");
  console.log(JSON.stringify({ extract: tally, move: tallyCut }));
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "placements.jsonl"), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  }
} finally {
  await project.close();
}
