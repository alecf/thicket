import type { FileSymbols, ImportBinding } from "../extract/types.js";
import { compareStrings } from "../order.js";
import { stronglyConnected } from "./metrics.js";
import type { Packages } from "./packages.js";

/**
 * Which declarations to move out of a file to break a file-level tangle, and
 * where they should go.
 *
 * The edge search scores one edge at a time and moves every symbol on it. A
 * move can do better in two ways. It can move one declaration that several
 * files import, which removes several edges at once. And it can move a small
 * declaration from an edge that also carries a large one. Blind judges
 * preferred the move to the edge cut 19 times to 8, on 30 tangles from four
 * public repositories. See docs/plans/2026-11-11-placement.md, round 5.
 *
 * Every move takes its helpers along. A helper left behind makes the new file
 * import the old one, and the edge the move removed comes back. Before helpers
 * moved, 52 of 111 judged moves freed nothing for that reason.
 */

export interface MoveInput {
  /** Undefined for a file outside the program. */
  symbolsOf(path: string): FileSymbols | undefined;
  importsOf(path: string): readonly string[];
  /** What `path` forwards with `export … from`, when it does nothing else. */
  reexportsOf(path: string): readonly string[];
  textOf(path: string): string | undefined;
}

export interface Move {
  /** The file the declarations leave. */
  owner: string;
  /** The declarations the search picked, sorted. */
  seeds: string[];
  /** Declarations that move too, because the seeds use them. Sorted. */
  helpers: string[];
  /** Lines the seeds and helpers span. */
  lines: number;
  /** Files still mutually dependent after the move. */
  residual: number;
  /** The same, once `import type` edges are erased. */
  runtimeResidual: number;
  /** Tangle edges into the owner that the move removes, sorted. */
  removes: { from: string; to: string }[];
}

/**
 * Files in a tangle before the move search stops trying. Each candidate costs
 * one Tarjan run over the tangle, and a tangle has a candidate per imported
 * declaration. Judged moves fixed tangles of up to 92 files.
 */
export const MAX_MOVE_SEARCH_FILES = 128;

/** A move must leave at most this share of the tangle, or break it. */
const MAX_RESIDUAL_SHARE = 2 / 3;

type Span = readonly [number, number];
/** from -> to -> whether the edge exists at runtime. */
type Graph = Map<string, Map<string, boolean>>;

const key = (from: string, to: string) => `${from}\u0000${to}`;
const within = (at: number, spans: readonly Span[]) => spans.some(([a, b]) => at >= a && at < b);

/** What the code in `spans` of `path` uses: imported bindings, and declarations beside it. */
function needs(s: FileSymbols, spans: readonly Span[]): { imports: ImportBinding[]; locals: string[] } {
  const inside = new Set(s.uses.filter(([, at]) => within(at, spans)).map(([n]) => n));
  const imports = s.bindings.filter((b) => inside.has(b.local));
  // A declaration whose own span holds the code is the code, not a helper.
  const locals = [...s.decls.entries()]
    .filter(
      ([name, own]) =>
        inside.has(name) &&
        !own.some(([a, b]) => spans.some(([c, d]) => (a >= c && b <= d) || (c >= a && d <= b))),
    )
    .map(([name]) => name);
  return { imports, locals };
}

/** The seeds and every helper they reach, sorted, with the helpers apart. */
export function closeOver(s: FileSymbols, seeds: readonly string[]): { names: string[]; helpers: string[] } {
  const names = new Set(seeds);
  const helpers: string[] = [];
  for (const name of names) {
    // A Set visits what is added during iteration, so this runs to a fixpoint.
    for (const local of needs(s, s.decls.get(name) ?? []).locals.sort(compareStrings)) {
      if (names.has(local)) continue;
      names.add(local);
      helpers.push(local);
    }
  }
  return { names: [...names].sort(compareStrings), helpers: helpers.sort(compareStrings) };
}

function spansOf(s: FileSymbols, names: readonly string[]): Span[] {
  return names.flatMap((n) => s.decls.get(n) ?? []);
}

function linesOf(text: string | undefined, spans: readonly Span[]): number {
  if (text === undefined) return 0;
  return spans.reduce((n, [a, b]) => n + text.slice(a, b).split("\n").length, 0);
}

/** An import of a type is erased, whether or not it says `import type`. */
function erased(b: ImportBinding, input: MoveInput): boolean {
  return b.typeOnly || (input.symbolsOf(b.target)?.typeNames.has(b.exported) ?? false);
}

function largest(nodes: readonly string[], g: Graph, runtimeOnly: boolean): number {
  const adjacency = new Map<string, string[]>();
  for (const [from, tos] of g) {
    adjacency.set(
      from,
      [...tos]
        .filter(([, runtime]) => runtime || !runtimeOnly)
        .map(([to]) => to)
        .sort(compareStrings),
    );
  }
  const sorted = [...nodes].sort(compareStrings);
  return stronglyConnected(sorted, adjacency).reduce((m, c) => Math.max(m, c.length), 0);
}

function tangleGraph(tangle: readonly string[], input: MoveInput, omit: ReadonlySet<string>): Graph {
  const members = new Set(tangle);
  const g: Graph = new Map();
  for (const x of tangle) {
    const tos = new Map<string, boolean>();
    const bindings = input.symbolsOf(x)?.bindings ?? [];
    for (const to of input.importsOf(x)) {
      if (!members.has(to) || to === x || omit.has(key(x, to))) continue;
      const bs = bindings.filter((b) => b.target === to);
      // No bindings: a re-export or a side-effect import, and both run.
      tos.set(to, bs.length === 0 || bs.some((b) => !erased(b, input)));
    }
    g.set(x, tos);
  }
  return g;
}

/** The tangle's graph after `names` leave `owner` for a new file. */
function afterMove(
  tangle: readonly string[],
  base: Graph,
  owner: string,
  names: ReadonlySet<string>,
  input: MoveInput,
): { g: Graph; nodes: string[]; removes: { from: string; to: string }[] } {
  const H = `${owner}\u0000moved`;
  const g: Graph = new Map([...base].map(([k, v]) => [k, new Map(v)]));
  const h = new Map<string, boolean>();
  g.set(H, h);
  const removes: { from: string; to: string }[] = [];
  for (const x of tangle) {
    if (x === owner || !g.get(x)!.has(owner)) continue;
    const bs = (input.symbolsOf(x)?.bindings ?? []).filter((b) => b.target === owner);
    const go = bs.filter((b) => names.has(b.exported));
    if (go.length === 0) continue;
    const stay = bs.filter((b) => !names.has(b.exported));
    g.get(x)!.set(H, go.some((b) => !erased(b, input)));
    // A re-export from the owner binds nothing, so `bs` cannot see it. The
    // edge stays unless every import from the owner left. A file with code of
    // its own counts too, or the move would claim to drop an edge it keeps.
    const reexports = input.symbolsOf(x)?.reexports.includes(owner) ?? false;
    if (stay.length === 0 && !reexports) {
      g.get(x)!.delete(owner);
      removes.push({ from: x, to: owner });
    } else {
      g.get(x)!.set(owner, stay.some((b) => !erased(b, input)) || reexports);
    }
  }
  const s = input.symbolsOf(owner)!;
  const spans = spansOf(s, [...names]);
  for (const bind of needs(s, spans).imports) {
    if (!g.has(bind.target)) continue;
    h.set(bind.target, (h.get(bind.target) ?? false) || !erased(bind, input));
  }
  // The owner imports the new file when code that stays uses what moved.
  const stays = s.uses.filter(([n, at]) => names.has(n) && !within(at, spans));
  if (stays.length > 0) g.get(owner)!.set(H, stays.some(([n]) => !s.typeNames.has(n)));
  return { g, nodes: [...tangle, H], removes };
}

/**
 * The move that leaves the smallest tangle, or undefined when no move leaves
 * at most two thirds of it.
 *
 * Candidates are each declaration that a tangle file imports from another,
 * alone, and every declaration on one edge together. The second kind is what
 * an edge cut moves, so the search does at least as well as the edge search
 * wherever the symbols are declared in the file imported. Ties go to the
 * smaller runtime tangle, then to fewer lines moved, then to the first owner
 * and names in path order.
 *
 * `omit` holds edges the report already dissolves, as `from\0to`.
 * `startingFrom` is the tangle's size after those.
 */
export function searchMoves(
  tangle: readonly string[],
  input: MoveInput,
  opts: { startingFrom?: number; omit?: ReadonlySet<string> } = {},
): Move | undefined {
  if (tangle.length > MAX_MOVE_SEARCH_FILES) return undefined;
  const members = new Set(tangle);
  const base = tangleGraph(tangle, input, opts.omit ?? new Set());
  const start = opts.startingFrom ?? tangle.length;

  const seeds = new Map<string, { owner: string; names: string[] }>();
  const addSeed = (owner: string, names: readonly string[]) => {
    const s = input.symbolsOf(owner);
    if (s === undefined || names.length === 0 || !names.every((n) => s.decls.has(n))) return;
    const sorted = [...new Set(names)].sort(compareStrings);
    seeds.set(`${owner}\u0000${sorted.join(",")}`, { owner, names: sorted });
  };
  for (const x of [...tangle].sort(compareStrings)) {
    const byTarget = new Map<string, string[]>();
    for (const b of input.symbolsOf(x)?.bindings ?? []) {
      if (!members.has(b.target) || b.target === x) continue;
      addSeed(b.target, [b.exported]);
      byTarget.set(b.target, [...(byTarget.get(b.target) ?? []), b.exported]);
    }
    for (const [t, names] of byTarget) addSeed(t, names);
  }

  const tried = new Set<string>();
  let best: Move | undefined;
  for (const [, { owner, names: seedNames }] of [...seeds].sort(([a], [b]) => compareStrings(a, b))) {
    const s = input.symbolsOf(owner)!;
    const { names, helpers } = closeOver(s, seedNames);
    const id = `${owner}\u0000${names.join(",")}`;
    if (tried.has(id)) continue;
    tried.add(id);
    const after = afterMove(tangle, base, owner, new Set(names), input);
    const residual = largest(after.nodes, after.g, false);
    if (residual >= start) continue;
    if (residual > 1 && residual > start * MAX_RESIDUAL_SHARE) continue;
    const move: Move = {
      owner,
      seeds: seedNames,
      helpers,
      lines: linesOf(input.textOf(owner), spansOf(s, names)),
      residual,
      runtimeResidual: largest(after.nodes, after.g, true),
      removes: after.removes.sort((a, b) => compareStrings(a.from, b.from)),
    };
    const order =
      best === undefined
        ? -1
        : move.residual - best.residual ||
          move.runtimeResidual - best.runtimeResidual ||
          move.lines - best.lines;
    if (order < 0) best = move;
  }
  return best;
}

// ------------------------------------------------------------------ homes --

export type HomeKind = "shared" | "dependency" | "user" | "new";
const KIND_ORDER: readonly HomeKind[] = ["shared", "dependency", "user", "new"];

export interface MoveHome {
  file: string;
  kind: HomeKind;
}

export interface HomeContext {
  files: ReadonlySet<string>;
  importsOf(path: string): readonly string[];
  importersOf(path: string): readonly string[];
  /** Size of the file cycle `path` is in, or 0 when it is in none. */
  cycleSize(path: string): number;
  packages: Packages;
}

/** Index the file graph once per report. */
export function homeContext(
  files: readonly string[],
  importsOf: (path: string) => readonly string[],
  packages: Packages,
): HomeContext {
  const sorted = [...files].sort(compareStrings);
  const adjacency = new Map(sorted.map((f) => [f, importsOf(f)]));
  const importers = new Map<string, string[]>();
  for (const f of sorted) {
    for (const t of adjacency.get(f)!) importers.set(t, [...(importers.get(t) ?? []), f]);
  }
  const size = new Map<string, number>();
  for (const scc of stronglyConnected(sorted, adjacency)) {
    if (scc.length > 1) for (const n of scc) size.set(n, scc.length);
  }
  return {
    files: new Set(sorted),
    importsOf: (p) => adjacency.get(p) ?? [],
    importersOf: (p) => importers.get(p) ?? [],
    cycleSize: (p) => size.get(p) ?? 0,
    packages,
  };
}

/** Homes scored per move, besides the new file. Each costs two walks of the graph. */
export const MAX_MOVE_HOMES = 12;

interface Verdict extends MoveHome {
  reachable: boolean;
  safe: boolean;
  misfit: boolean;
  frees: number;
  /** The largest cycle left among the tangle's files and the home. */
  left: number;
  edgesInCycle: number;
  newDeps: number;
  added: number;
}

/**
 * Where the moved code should go, and the largest cycle left with it there.
 *
 * The search measures a move against a new file. An existing home can leave
 * less, because it may already hold what the code needs. Round 6 judges
 * caught two `leaves:` lines that overstated the cycle this way.
 *
 * Every candidate is scored by what the move does to the file graph with the
 * code there: whether every user's package can import it, whether its
 * package can load the npm packages the code imports, whether it closes
 * or grows a cycle, and how many tangle files it frees. Among equally good
 * homes an existing file wins over a new one. Then the fewest new imports
 * between existing files, then a file that every user already imports, then
 * one the code depends on, then one that uses it.
 *
 * Judges rated the prototype's pick good 71% of the time on 114 moves,
 * against 16% for the importing file. The prototype scored a new file as part
 * of a neighbour's module, which made most new files look unsafe, so it mostly
 * picked existing files. Without that artifact, a new file won 40 of 45
 * judged moves, often in a directory high above the code. Preferring an
 * existing file keeps the judged pick on 34 of those 45. On the other 11, two
 * blind judges rated the new pick good 6 and 7 times, and the old pick good
 * 2 times and once.
 */
export function homeFor(
  tangle: readonly string[],
  move: Move,
  input: MoveInput,
  ctx: HomeContext,
  /** Edges the report already dissolves, as `from\0to`. They are gone too. */
  omit: ReadonlySet<string> = new Set(),
): { home: MoveHome; residual: number } {
  const { owner } = move;
  const s = input.symbolsOf(owner)!;
  const moved = new Set([...move.seeds, ...move.helpers]);
  const spans = spansOf(s, [...moved]);

  const users = new Set<string>();
  for (const x of ctx.importersOf(owner)) {
    const bs = input.symbolsOf(x)?.bindings ?? [];
    if (bs.some((b) => b.target === owner && moved.has(b.exported))) users.add(x);
  }
  if (s.uses.some(([n, at]) => moved.has(n) && !within(at, spans))) users.add(owner);
  const deps = new Set(needs(s, spans).imports.map((b) => b.target));
  const inside = new Set(s.uses.filter(([, at]) => within(at, spans)).map(([n]) => n));
  const npm = [...new Set(s.packageBindings.filter((b) => inside.has(b.local)).map((b) => b.pkg))].sort(
    compareStrings,
  );
  deps.delete(owner);
  const dropped = new Set<string>();
  for (const u of users) {
    if (u === owner) continue;
    const bs = (input.symbolsOf(u)?.bindings ?? []).filter((b) => b.target === owner);
    const reexports = input.symbolsOf(u)?.reexports.includes(owner) ?? false;
    if (bs.every((b) => moved.has(b.exported)) && !reexports) dropped.add(u);
  }
  const userList = [...users].sort(compareStrings);
  const depList = [...deps].sort(compareStrings);
  const isType = [...moved].every((n) => s.typeNames.has(n));

  const candidates: MoveHome[] = [];
  for (const d of depList) {
    const shared = userList.every((u) => u === d || ctx.importsOf(u).includes(d));
    if (!users.has(d)) candidates.push({ file: d, kind: shared ? "shared" : "dependency" });
  }
  for (const u of userList) if (u !== owner) candidates.push({ file: u, kind: "user" });
  candidates.sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compareStrings(a.file, b.file),
  );
  // A file that only forwards is a barrel, not a home. Judges rejected both
  // barrels the ranking picked in round 6.
  const homes = candidates.filter((c) => input.reexportsOf(c.file).length === 0).slice(0, MAX_MOVE_HOMES);
  const fresh = newFile(owner, move.seeds[0]!, userList, ctx);
  if (!ctx.files.has(fresh)) homes.push({ file: fresh, kind: "new" });

  const verdicts = homes.map((home) =>
    judge(home, home.kind === "new", { tangle, owner, users: userList, deps: depList, npm, dropped, isType, omit }, input, ctx),
  );
  verdicts.sort(
    (a, b) =>
      Number(b.reachable) - Number(a.reachable) ||
      Number(b.safe) - Number(a.safe) ||
      Number(a.misfit) - Number(b.misfit) ||
      b.frees - a.frees ||
      a.edgesInCycle - b.edgesInCycle ||
      Number(a.kind === "new") - Number(b.kind === "new") ||
      a.newDeps - b.newDeps ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.added - b.added ||
      compareStrings(a.file, b.file),
  );
  const best = verdicts[0];
  if (best === undefined) return { home: { file: fresh, kind: "new" }, residual: move.residual };
  return { home: { file: best.file, kind: best.kind }, residual: best.left };
}

/**
 * A new file named after the first seed. It goes in the deepest directory
 * holding every user when they share a package, and beside the owner
 * otherwise. Every user already imports the owner's package, so a file
 * there is always reachable.
 */
function newFile(owner: string, name: string, users: readonly string[], ctx: HomeContext): string {
  const ext = /\.[cm]?tsx?$/.exec(owner)?.[0] ?? ".ts";
  const dirOf = (p: string) => p.split("/").slice(0, -1);
  const packages = new Set(users.map((u) => ctx.packages.of(u)));
  let dir = dirOf(owner);
  if (packages.size === 1 && users.length > 0) {
    let common = dirOf(users[0]!);
    for (const u of users.slice(1)) {
      const d = dirOf(u);
      let i = 0;
      while (i < common.length && i < d.length && common[i] === d[i]) i++;
      common = common.slice(0, i);
    }
    if (common.length > 0) dir = common;
  }
  return [...dir, `${name}${ext}`].join("/");
}

function judge(
  home: MoveHome,
  isNew: boolean,
  m: {
    tangle: readonly string[];
    owner: string;
    users: readonly string[];
    deps: readonly string[];
    /** npm packages the moved code imports. */
    npm: readonly string[];
    dropped: ReadonlySet<string>;
    isType: boolean;
    omit: ReadonlySet<string>;
  },
  input: MoveInput,
  ctx: HomeContext,
): Verdict {
  const H = home.file;
  const users = m.users.filter((u) => u !== H);
  const deps = m.deps.filter((d) => d !== H);
  const userSet = new Set(users);
  const depSet = new Set(deps);

  // The file graph after the move, as two neighbour functions. Only edges
  // into the owner go away, and every new edge touches the home.
  const next = (x: string): string[] => {
    const out = new Set(x === H && isNew ? [] : ctx.importsOf(x));
    if (m.dropped.has(x)) out.delete(m.owner);
    for (const y of [...out]) if (m.omit.has(key(x, y))) out.delete(y);
    if (userSet.has(x)) out.add(H);
    if (x === H) for (const d of deps) out.add(d);
    out.delete(x);
    return [...out];
  };
  const prev = (x: string): string[] => {
    const out = new Set(x === H && isNew ? [] : ctx.importersOf(x));
    if (x === m.owner) for (const u of m.dropped) out.delete(u);
    for (const u of [...out]) if (m.omit.has(key(u, x))) out.delete(u);
    if (x === H) for (const u of users) out.add(u);
    if (depSet.has(x)) out.add(H);
    out.delete(x);
    return [...out];
  };
  const reach = (from: string, step: (x: string) => string[]) => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      for (const y of step(queue.pop()!)) {
        if (seen.has(y)) continue;
        seen.add(y);
        queue.push(y);
      }
    }
    return seen;
  };
  // Every new cycle runs through the home, because every new edge touches it.
  const forward = reach(H, next);
  const cycle = [...reach(H, prev)].filter((x) => forward.has(x));
  const inCycle = new Set(cycle.length > 1 ? cycle : []);
  // A new file is in no cycle yet, so any cycle through it is a new one.
  const safe = [...inCycle].every((x) => ctx.cycleSize(x) >= inCycle.size);

  // The rest of the tangle can only lose edges, and no cycle of it leaves it.
  const rest = m.tangle.filter((x) => !inCycle.has(x)).sort(compareStrings);
  const restSet = new Set(rest);
  const adjacency = new Map(rest.map((x) => [x, next(x).filter((y) => restSet.has(y)).sort(compareStrings)]));
  const stillCyclic = new Set(inCycle);
  // Only the tangle's files and the home count. The home can already sit in
  // a cycle of its own, which the move leaves as it was.
  const members = new Set([...m.tangle, H]);
  let left = Math.max(1, [...inCycle].filter((x) => members.has(x)).length);
  for (const scc of stronglyConnected(rest, adjacency)) {
    if (scc.length > 1) for (const x of scc) stillCyclic.add(x);
    left = Math.max(left, scc.length);
  }
  const frees = m.tangle.filter((x) => !stillCyclic.has(x)).length;

  const edgesInCycle =
    users.filter((u) => inCycle.has(u)).length + deps.filter((d) => inCycle.has(d)).length;
  const existing = isNew ? [] : ctx.importsOf(H);
  const added =
    users.filter((u) => !ctx.importsOf(u).includes(H)).length + deps.filter((d) => !existing.includes(d)).length;
  const p = ctx.packages;
  const homePkg = p.of(H);
  return {
    ...home,
    reachable:
      users.every((u) => p.canImport(p.of(u), homePkg)) &&
      deps.every((d) => p.canImport(homePkg, p.of(d))) &&
      m.npm.every((n) => p.canUse(homePkg, n)),
    safe,
    misfit: !m.isType && !isNew && (input.symbolsOf(H)?.typesOnly ?? false),
    frees,
    left,
    edgesInCycle,
    newDeps: isNew ? 0 : added,
    added,
  };
}
