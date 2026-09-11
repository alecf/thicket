import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { compareStrings } from "../order.js";

/**
 * Workspace globs declared by the root manifest, or `undefined` when this
 * directory is not a workspace root.
 *
 * `undefined` and `[]` mean different things: the first says "no manifest
 * declares workspaces here, behave as before", the second says "a manifest
 * declares exactly none". Collapsing them makes discovery unable to tell a
 * plain project from an empty monorepo.
 *
 * Globs come back in declaration order, unmodified, because `--filter` is
 * applied against this list as written and is order-sensitive (Task 5).
 * Negation is NOT order-sensitive: `discoverWorkspaces` subtracts every `!`
 * glob from the whole match, so moving one to the front changes nothing. That
 * is what pnpm does and the less surprising of the two.
 *
 * Nothing about the layout is built in. `apps`, `packages` and `services` are
 * strings that appear in other people's manifests, never in this file.
 *
 * This is also where manifest formats meet: every one thicket understands is
 * tried here, in precedence order, and each knows only its own file. Inline the
 * delegation into whichever helper happens to be the only one left and the
 * public contract above -- `undefined` versus `[]`, declaration order, nothing
 * built in -- becomes one format's private business.
 */
export function workspaceGlobs(root: string): string[] | undefined {
  // `package.json` first: a repo that moved to pnpm and left the old key behind
  // holds two answers, and every package manager reads this one.
  return globsFromPackageJson(root) ?? globsFromPnpm(root);
}

function globsFromPackageJson(root: string): string[] | undefined {
  const parsed = readJson(join(root, "package.json"));
  const ws = (parsed as { workspaces?: unknown })?.workspaces;
  // npm/bun/yarn-berry take an array; yarn v1 takes { packages: [...] }.
  if (Array.isArray(ws)) return strings(ws);
  const packages = (ws as { packages?: unknown })?.packages;
  if (Array.isArray(packages)) return strings(packages);
  return undefined;
}

/**
 * The string entries of `xs`, in order.
 *
 * Anything else is dropped rather than passed along: a number or object that
 * survives into glob expansion fails there, where it reads as a bad glob
 * instead of as a manifest this tool could not understand.
 */
const strings = (xs: readonly unknown[]): string[] =>
  xs.filter((x): x is string => typeof x === "string");

/**
 * The one pnpm manifest shape that matters: a `packages:` key holding a block
 * list of scalars.
 *
 * Hand-parsed rather than pulling a YAML dependency into a two-dependency
 * project. Anything else -- a flow sequence, a nested mapping, no `packages:`
 * at all -- answers `undefined`, which degrades to today's behavior instead of
 * guessing. A wrong glob list would analyze the wrong tree silently; no glob
 * list just means no discovery.
 *
 * One known divergence from YAML, left alone deliberately: a quoted scalar
 * containing ` #` loses comment protection, so `- 'libs/a #1/*'` comes back as
 * `'libs/a`. YAML suspends comment rules inside quotes and this does not. The
 * result carries a stray quote, so it fails visibly at expansion rather than
 * quietly matching a different directory -- which is the trade this whole
 * function is built around.
 */
export function globsFromPnpmText(text: string): string[] | undefined {
  const out: string[] = [];
  let inPackages = false;
  // The BOM strip is the same failure as the one on `package.json` and it bites
  // harder here: a leading U+FEFF defeats `/^packages:\s*$/` on the first line,
  // the key is never seen, and the whole manifest is discarded -- so a pnpm
  // monorepo authored on Windows reads as a plain single project. YAML permits
  // a leading BOM and pnpm itself reads the file, so this is ours alone. It is
  // stripped here rather than at the read so this function is correct on its
  // own; with `readJson`, these are the only two places text enters this file.
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    // `trimEnd` FIRST, and it is load-bearing rather than tidy: `\r` is a
    // JavaScript line terminator, so `.` cannot match it and `$` does not
    // assert before it. Strip comments first and the regex simply never fires
    // on a CRLF checkout -- a trailing comment rides into the glob (`a/* # c`
    // is well-formed and matches nothing, so that workspace vanishes from
    // discovery while the rest are reported confidently) and a full-line
    // comment becomes an unparseable line that discards the whole manifest.
    //
    // The rest: YAML starts a comment at `#` only at line start or after
    // whitespace, so a `#` inside a glob survives. Stripping every `#` would
    // truncate `libs/c#1/*` to `libs/c`, still a valid glob naming a different
    // directory -- a wrong answer that looks like a right one. The space this
    // leaves behind is absorbed by the blank check below and by `.trim()` on
    // the captured item.
    const line = raw.trimEnd().replace(/(^|\s)#.*$/, "$1");
    if (line.trim() === "") continue;
    if (!inPackages) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      continue;
    }
    // Indentation is optional: YAML lets a block sequence sit at its key's own
    // column, and manifests in the wild are written both ways. Requiring the
    // indented form would answer `[]` for the flush form -- "a workspace root
    // with no members", stated confidently about a root declaring several.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      out.push(unquote(item[1]!.trim()));
      continue;
    }
    // A new top-level key ends the block. This runs AFTER the item test on
    // purpose: a flush `- x` starts at column 0 too, so testing for a
    // top-level key first would swallow every flush list.
    //
    // Anything else under `packages:` is a shape we do not understand, and
    // guessing is worse than not answering.
    if (/^\S/.test(line)) break;
    return undefined;
  }
  // The `break` above leaves `inPackages` true, so this ternary is only ever
  // distinguishing "there was no `packages:` key at all".
  return inPackages ? out : undefined;
}

function unquote(s: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(s);
  return quoted ? quoted[2]! : s;
}

function globsFromPnpm(root: string): string[] | undefined {
  // Both spellings are in the wild and pnpm accepts either. Here `existsSync`
  // is choosing between two candidate names rather than guarding a read: drop
  // it and the first name's ENOENT is indistinguishable from a real read
  // failure, so a `.yml` manifest is never reached.
  for (const name of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      return globsFromPnpmText(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface Workspace {
  /** Repo-relative POSIX directory. */
  dir: string;
  /** `name` from its package.json, when it has one. */
  name?: string;
}

/**
 * Depth bound for the package walk, in path segments below the root. Past any
 * real layout -- the deepest workspace in the fixtures sits at four -- and the
 * only thing bounding a `**` glob, which otherwise names every directory in
 * the tree.
 */
const MAX_WALK_DEPTH = 8;

/**
 * Every directory declared by the root manifest that actually holds a
 * `package.json`, sorted by directory.
 *
 * Candidates are collected by walking for `package.json` and then MATCHED
 * against the globs, rather than by expanding the globs into paths. Expansion
 * would need its own `**` semantics; this needs none, and it never proposes a
 * directory that is not a package -- `deep/**` matches `deep/a` and `deep/a/b`
 * as readily as the workspace two levels below them.
 *
 * Matching goes through `posix.matchesGlob` rather than the bare
 * `path.matchesGlob`, which is the win32 implementation on Windows. The two
 * disagree on exactly one thing: a `\` in the path, which win32 reads as a
 * separator (measured against node 24 and bun 1.4). No walk here can produce
 * such a name -- Windows forbids `\` in a filename, and on POSIX `path` IS
 * `path.posix` -- so this fixes no live bug. It pins the semantics: these
 * strings are POSIX by construction, so the posix matcher is the correct one,
 * and which implementation runs should not be a property of the host. The
 * premise is pinned by a test in `tests/workspaces.test.ts`, so it fails if
 * the two ever converge rather than quietly becoming a dead justification.
 *
 * These globs come from the REPOSITORY BEING ANALYZED rather than from whoever
 * ran thicket, which is what makes the cost of a hostile one worth writing
 * down. A glob alternating `*` with literals (`*a*a*...*ab`) backtracks
 * exponentially under node's JavaScript glob implementation and is
 * constant-time under bun's native one. Measured end to end on this function --
 * one 40-character package directory, a ten-star glob, the SAME `dist/`
 * JavaScript both times: 6.28s under node 24, 0.000s under bun 1.4. The
 * primitive alone measures 6.38s and 0.000s on that input, and `bun run
 * thicket`, which loads `src/` directly, answers in 0.010s -- so the immunity
 * is a property of the RUNTIME, not of how the module is loaded.
 *
 * The node curve grows 3.1-4.0x per further star (0.52s, 2.05s, 6.38s at eight,
 * nine and ten), so fourteen stars is a quarter of an hour and twenty is out of
 * reach. `matchesNameGlob` quotes ~2.7x for a curve that looks the same and is
 * not: that one is a compiled RegExp, a different implementation with a
 * different constant, measured separately. Do not reconcile the two numbers.
 *
 * There is no cap on glob complexity here, and that is a decision rather than
 * an oversight. One was designed and measured: a limit on `*` characters per
 * glob, refusing the individual entry so a single hostile glob could not
 * discard the rest of the manifest. It was dropped because a star count is a
 * poor proxy for cost. The conventional node_modules exclusion -- a `**` on
 * either side of a directory name, which cannot be written literally in a
 * block comment -- carries four stars and matches in 0.02ms, because what
 * actually explodes is a literal that occurs at many positions, and the cost
 * rises with the length of the directory NAME as well -- which the same
 * repository also controls. So a cap loose enough to admit
 * real four-star globs does not bound a hostile repo, and one tight enough to
 * bound it refuses plausible layouts. Every workspace glob in a survey of real
 * manifests carried one or two.
 *
 * What makes that trade acceptable is bun, where the exponential case does not
 * arise at all. But node is a supported install target TODAY -- `package.json`
 * declares `engines.node` and points `bin` at `dist/`, and AGENTS.md says the
 * built output runs under Node 24 for anyone who installs the bin -- so that
 * path is exposed right now, and calling it an edge case would be wrong. bun is
 * the intended runtime and is immune. If node support persists or returns, this
 * is the decision to revisit, and the cap above is the designed alternative
 * along with the reason it lost.
 */
export function discoverWorkspaces(root: string): Workspace[] {
  const globs = workspaceGlobs(root);
  // No manifest declared workspaces here, so there is nothing to walk for. A
  // root that declares an empty list falls through instead and comes out empty
  // at the include filter -- the same answer by a different route, which is
  // right: the difference between the two is `workspaceGlobs`'s to report and
  // a caller's to act on, not discovery's.
  if (globs === undefined) return [];
  const include = globs.filter((g) => !g.startsWith("!"));
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));

  const out: Workspace[] = [];
  for (const dir of packageDirs(root)) {
    if (!include.some((g) => posix.matchesGlob(dir, g))) continue;
    if (exclude.some((g) => posix.matchesGlob(dir, g))) continue;
    const name = packageName(join(root, dir));
    out.push(name === undefined ? { dir } : { dir, name });
  }
  // The only ordering guarantee in here, and it has to be this one:
  // `readdirSync` order is a property of the filesystem, and the walk's own
  // order is depth-first, which agrees with code-unit order on most trees but
  // not all -- `a` and `a/c` come out adjacent whatever the filesystem says,
  // and `a-b` sorts between them.
  return out.sort((a, b) => compareStrings(a.dir, b.dir));
}

/**
 * Repo-relative POSIX directories holding a `package.json`, excluding `root`
 * itself.
 *
 * This is a full walk of the tree, minus `node_modules`, dot-directories and
 * anything deeper than `MAX_WALK_DEPTH`. It does not stop descending at a match,
 * because real monorepos nest packages and the manifest is the only thing that
 * knows whether an inner one is a member: stopping would make `tools/**` mean
 * `tools/*` and leave no glob able to name the inner package.
 *
 * The cost is one `readdirSync` plus one `existsSync` per directory, paid once
 * per run before any file is parsed: measured at 44ms for a 1886-directory
 * monorepo-shaped tree, ~24us per directory. Two ways to shave that are known
 * and deliberately not taken. Reading `package.json` out of each directory's
 * own entries instead of `existsSync`-ing from the parent halves the syscalls
 * and buys ~17ms -- real, and not worth the complexity against a TypeScript
 * parse. Folding `packageName` into the walk would be a regression: it stays
 * after the glob filter so that only MATCHED packages are parsed, not every
 * package in the tree.
 */
function packageDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      // Same skips as `scanSourceFiles`: every dependency of the repo is a
      // package, and a checkout inside a dot-directory is a whole second copy
      // of every package in it.
      if (name === "node_modules" || name.startsWith(".")) continue;
      // Joined with `/`, never with `path.join`: a readdir entry is a single
      // name, so this is already POSIX on every platform, and the result is
      // matched against manifest globs written with `/`. It is not normalized
      // afterwards either -- `\` is a legal character in a POSIX directory
      // name, and folding it to `/` would split one directory into two
      // segments that its own glob no longer matches.
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (existsSync(join(abs, name, "package.json"))) out.push(childRel);
      walk(join(abs, name), childRel, depth + 1);
    }
  };
  walk(root, "", 1);
  return out;
}

function packageName(dir: string): string | undefined {
  const parsed = readJson(join(dir, "package.json"));
  const name = (parsed as { name?: unknown })?.name;
  // A nameless package is still a workspace, and a package whose manifest is
  // unreadable or malformed arrives here as one too -- `readJson` answers
  // `undefined` for all of it. That is the right trade: `name` is only what
  // `--filter` matches on, so the workspace is unreachable BY NAME while its
  // source is still analyzed, which beats dropping real code over a manifest
  // this tool could not parse.
  return typeof name === "string" ? name : undefined;
}

/**
 * `path` parsed as JSON, or `undefined` if it is absent, unreadable or not
 * JSON.
 *
 * Absent, unreadable and unparseable are deliberately one answer: at every
 * call site here they mean the same thing -- no declaration to read -- and
 * none of them may mean "the run fails", because discovery is a convenience,
 * never a dependency (AGENTS.md §5 applies to it too). An `existsSync` ahead
 * of the read would be a branch no caller can distinguish from this catch. It
 * does distinguish absent from unreadable, which a caller that owns stderr
 * will want; this has nothing to say about the difference.
 *
 * The BOM strip is load-bearing rather than tidy, and silent both ways:
 * `JSON.parse` throws on a leading U+FEFF, so a root manifest saved with one
 * makes a monorepo read as a plain single project, and a member manifest with
 * one makes that workspace nameless and unfilterable. Windows editors write
 * BOMs; every fixture in this repo is LF and BOM-free, which is the same blind
 * spot the CRLF bug in the pnpm parser came out of.
 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

/**
 * The workspaces `filters` selects, sorted by directory.
 *
 * A pattern is a PATH pattern when it starts with `./`, `../` or `/`, and a
 * NAME pattern otherwise. That is turbo's own rule, and it is what stops a
 * scoped package name -- which contains a slash -- being read as a directory.
 *
 * Filters apply in order and a `!` prefix removes. With no filters, or with a
 * negation first, selection starts from everything; otherwise it starts empty.
 *
 * A filter that matches nothing throws rather than removing nothing or
 * selecting nothing. Both silent outcomes produce a short, clean-looking report
 * over a tree that was never analyzed, which reads as good news.
 *
 * Selection is keyed on `dir` rather than on object identity. Identity would
 * make the answer depend on whether the caller assembled `all` from one source
 * or two, which nothing in the signature says it must -- and two entries for
 * one directory is the phantom-identical-clone hazard from AGENTS.md, reached
 * by a different road. When two entries do share a `dir`, last wins, so which
 * `name` survives follows the order of the caller's array: input order is the
 * caller's to define, not something this function imposes.
 */
export function selectWorkspaces(
  all: readonly Workspace[],
  filters: readonly string[],
): Workspace[] {
  const selected = new Map<string, Workspace>();
  const first = filters[0];
  if (first === undefined || first.startsWith("!")) for (const w of all) selected.set(w.dir, w);
  for (const filter of filters) {
    const negated = filter.startsWith("!");
    const pattern = negated ? filter.slice(1) : filter;
    const hits = all.filter((w) => matchesFilter(w, pattern));
    // Before the negated/positive split on purpose: a `!` that matches nothing
    // removes nothing, so a typo in an exclusion leaves the workspace it meant
    // to drop in the analyzed set and announces that nowhere.
    if (hits.length === 0) throw new Error(noMatch(filter, all));
    for (const hit of hits) {
      if (negated) selected.delete(hit.dir);
      else selected.set(hit.dir, hit);
    }
  }
  // Sorted here rather than relying on `all` arriving sorted and insertion
  // preserving it: `--filter '@scope/*' --filter beta` inserts two `tools/`
  // workspaces before one from `libs/`, so Map order is filter order and
  // filter order is the reader's. The no-filter path takes this sort too, so
  // no caller has to know which path produced its list.
  return [...selected.values()].sort((a, b) => compareStrings(a.dir, b.dir));
}

/**
 * The message for a filter that matched nothing.
 *
 * Every workspace's BOTH addresses, because the one the reader typed is
 * usually the other one: a directory `evals` publishing as `@scope/evals`
 * makes `--filter evals` match nothing, and `./evals` is right there.
 *
 * One per line and never truncated. Joined with commas, a 14-workspace list is
 * 465 characters of unbroken prose -- and 14 is small -- while truncation would
 * elide exactly the entry the reader is missing, since the one they cannot
 * find is the one they did not guess. The message exists to be read once, by
 * someone who is stuck; length is not what is expensive about that. The
 * pattern is quoted because the patterns most likely to match nothing are the
 * ones you cannot see: an empty string, or one that arrived from a shell with
 * whitespace attached.
 */
function noMatch(filter: string, all: readonly Workspace[]): string {
  const known = all
    .map((w) => (w.name === undefined ? `./${w.dir}` : `${w.name} (./${w.dir})`))
    .sort(compareStrings);
  return `--filter "${filter}" matched no workspace.\nAvailable workspaces:\n  ${known.join("\n  ")}`;
}

function matchesFilter(ws: Workspace, pattern: string): boolean {
  if (pattern.startsWith("./") || pattern.startsWith("../") || pattern.startsWith("/")) {
    // A PATH is matched as a path: `/` is a separator, so `./tools/*` does not
    // reach `tools/a/b`. `posix.matchesGlob`, never the bare export, which is
    // the win32 implementation on Windows -- see `discoverWorkspaces` for the
    // measurement and the premise test that pins it.
    //
    // This is the one matcher in this file that keeps node's exponential
    // backtracking case; `discoverWorkspaces` carries the figures. Kept on
    // purpose: thicket targets bun, where the same call is constant-time, the
    // pattern here is the user's own typing rather than the repository's, and a
    // path pattern needs real `**`-versus-`*` separator semantics that the name
    // matcher below does not implement.
    return posix.matchesGlob(ws.dir, pattern.replace(/^\.\//, ""));
  }
  // A NAME is matched as a string. `matchesGlob` would treat the `/` in a
  // scoped name as a separator, so `*` would silently skip every scoped
  // package -- selecting part of the repo and reporting it as if whole.
  return ws.name !== undefined && matchesNameGlob(ws.name, pattern);
}

/**
 * `name` against a pattern in which `*` matches any run of characters, `/`
 * included, and every other character is a literal.
 *
 * Matched by walking the literal segments rather than by compiling a RegExp,
 * which is what the obvious implementation does. Two reasons, and the second
 * is the load-bearing one:
 *
 * - A RegExp built from a CLI string has to escape twelve metacharacters, and
 *   the one that gets missed does not fail -- `--filter 'a.b'` quietly selects
 *   `axb` as well.
 * - `*` compiles to `.*`, and a pattern of alternating stars and literals is
 *   the textbook catastrophic backtrack. Measured on the compiled form against
 *   a 40-character name, `*a` repeated ten times plus a `b`: 8.1s under node 24
 *   and 1.2s under bun 1.4, each growing ~2.7x per further star (both runtimes
 *   measured at ten and eleven) -- so fourteen stars is about a minute on bun
 *   and several on node. `discoverWorkspaces` quotes 3.1-4.0x for the glob
 *   matcher, which is a different implementation, not a disagreement. The filter is
 *   typed by the person running the tool, so this is a foot-gun rather than an
 *   attack, but "thicket hung" is the worst available way to report a pattern
 *   that simply matches nothing. This walk is linear in the name per segment.
 *
 * `posix.matchesGlob` is not the alternative it looks like, and the reason is
 * worth keeping: it backtracks the same way under node -- 6.4s on that input --
 * and not at all under bun, whose glob is native. thicket targets bun, so THAT
 * hazard is bounded in practice and `discoverWorkspaces` documents the split in
 * full. The compiled RegExp is the one that survives the runtime choice: it is
 * slow on both, which is what decided this walk.
 *
 * Taking the EARLIEST occurrence of each interior segment is exact, not a
 * heuristic: with `*` the only wildcard, a later occurrence leaves strictly
 * less room for the segments after it.
 */
function matchesNameGlob(name: string, pattern: string): boolean {
  const parts = pattern.split("*");
  // No `*` at all: the pattern is one literal, and an exact comparison is the
  // whole of it.
  if (parts.length === 1) return name === pattern;
  const prefix = parts[0]!;
  const suffix = parts[parts.length - 1]!;
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  let at = prefix.length;
  const end = name.length - suffix.length;
  // The window between prefix and suffix, which is also what stops the two
  // overlapping: `a*a` must not match `a` by matching the same character
  // twice.
  if (at > end) return false;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}
