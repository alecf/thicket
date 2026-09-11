import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { compareStrings } from "../order.js";
import { readJson, workspaceGlobs } from "./manifest.js";
import { configPathsIn, type ScanOptions, scanSourceFiles } from "./scope.js";
import { sourceFileNames } from "./ts-adapter.js";

const toPosix = (p: string) => (sep === "\\" ? p.split(sep).join("/") : p);

export interface Workspace {
  /** Repo-relative POSIX directory. */
  dir: string;
  /** `name` from its package.json, when it has one. */
  name?: string;
}

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
 * This is a full walk of the tree, minus `node_modules` and dot-directories.
 * There is deliberately no depth bound. One was here and it was wrong: a
 * workspace nine segments down was never discovered, its files were never
 * analyzed, and they came back as an unexplained gap in the coverage
 * denominator that no flag could close -- `scanSourceFiles` has no depth limit,
 * so it counted every one of them. A cap that protects nothing still has to
 * match on both sides of the coverage figure, and this one could not.
 *
 * Nothing needs bounding here. The walk is not glob-driven -- it enumerates the
 * filesystem and matches afterwards -- so a `**` glob cannot deepen it. And a
 * symlink, even one pointing at its own parent, reports `isDirectory() === false`
 * from `readdirSync` (measured on node 24 and bun 1.4; symlinks answer
 * `isSymbolicLink`), so the walk cannot enter a cycle. What is left is bounded
 * by the filesystem's own path limit.
 *
 * The skips must stay a subset of `scanSourceFiles`'s, which drops
 * `node_modules`, dot-directories AND generated directory names. Skipping more
 * than the scan does is what creates a gap nothing explains; skipping less, as
 * here, at worst proposes a workspace whose files the scan never counted. Keep
 * the asymmetry pointing this way.
 *
 * It does not stop descending at a match,
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
  const walk = (abs: string, rel: string): void => {
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
      walk(join(abs, name), childRel);
    }
  };
  walk(root, "");
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

/** One directory's tsconfigs: the one that is loaded, and the ones that must earn it. */
interface DirConfigs {
  /** Repo-relative POSIX path of the config loaded unconditionally. */
  primary: string;
  /** The rest, repo-relative POSIX, sorted. Loaded only if they close a gap. */
  siblings: string[];
}

/**
 * The `tsconfig*.json` files in one directory, or `undefined` when it has
 * none.
 *
 * `undefined` is a real answer, not a failure: a workspace may exist to
 * publish shared compiler settings and own no source at all. Throwing, or
 * inventing `<dir>/tsconfig.json`, turns a legitimate layout into an error or
 * into a config path that does not exist.
 *
 * `tsconfig*.json`, never `*.json`. A `base.json` or a `package.json` sitting
 * beside the configs is not a project, and opening one as a project analyzes
 * a file set nobody asked for.
 *
 * KNOWN GAP, recorded so it is not mistaken for a guard that holds: the
 * `isFile()` test is unpinned. A DIRECTORY named `tsconfig.x.json` would be
 * offered as a config and fail at the loader instead of here. Pinning it
 * costs a fixture directory whose name is a lie, for a shape nobody has.
 *
 * `tsconfig.json` is the primary when it exists, and otherwise the first name
 * in `compareStrings` order -- a rule, rather than a preference, because a
 * directory holding only `tsconfig.app.json` and `tsconfig.node.json` has to
 * pick one and the answer may not depend on `readdirSync` order, which is a
 * property of the filesystem.
 */
function configsIn(root: string, dir: string): DirConfigs | undefined {
  // Which files count, and in what order, is `configPathsIn`'s to say -- the
  // coverage section offers exactly this set, and two copies of the rule are
  // two chances for what a run LOADS and what it SUGGESTS to disagree. An
  // unreadable directory arrives here as "no configs", which degrades to
  // analyzing less; throwing would let one unreadable workspace end the run.
  const paths = configPathsIn(root, dir);
  if (paths.length === 0) return undefined;
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const primary = paths.find((p) => base(p) === "tsconfig.json") ?? paths[0]!;
  return { primary, siblings: paths.filter((p) => p !== primary) };
}

/**
 * The deepest directory in `scopes` that contains `file`, or `"."`.
 *
 * Deepest, not first: `tools/**` yields both `tools/alpha` and
 * `tools/alpha/sub`, so a file under the nested workspace is contained by
 * both. Blaming the parent sends it looking for a sibling config of its own
 * to close a gap that is not the parent's -- and a parent's build config
 * reaching into its child's directory will happily close it.
 *
 * `scopes` here is EVERY workspace, not the selected ones: a workspace left
 * out of the run still owns its own files, and the answer for one of them has
 * to be a directory the run will then decline to act on. Pass only the
 * selected list and those files fall through to `"."`, which is how a
 * repo-spanning root config gets adopted to close a gap the filter created.
 *
 * Longest wins because every directory containing `file` is a prefix of every
 * deeper one, so string length orders them exactly.
 */
function deepestScope(scopes: readonly string[], file: string): string {
  let best = ".";
  for (const dir of scopes) {
    if (dir === "." || !file.startsWith(`${dir}/`)) continue;
    if (best === "." || dir.length > best.length) best = dir;
  }
  return best;
}

/**
 * Turns a probe's names into repo-relative ones.
 *
 * A probe measures its paths from `commonRootDir` of the configs it actually
 * opened, which is NOT the repo root whenever the selected workspaces share a
 * deeper ancestor -- one workspace under `--filter`, or a repo whose root has
 * no tsconfig of its own. Diff those against a repo-relative scan unrebased
 * and nothing overlaps at all: the entire tree reads as a gap, every workspace
 * looks uncovered, and every sibling config in the repo becomes a candidate.
 *
 * A probe root ABOVE the repo root throws instead. It means a config
 * `references` one outside the tree, and a repo-relative path cannot express
 * a file outside the repo -- there is no prefix to rebase by, so the honest
 * answer is to say so rather than to emit `../` paths that match nothing on
 * either side of the coverage figure.
 */
function rebaseOnto(root: string, probeRoot: string): (name: string) => string {
  const prefix = toPosix(relative(resolve(root), probeRoot));
  if (prefix === ".." || prefix.startsWith("../") || isAbsolute(prefix)) {
    throw new Error(
      `the tsconfigs under ${root} resolved to files outside it (common root ${probeRoot}); ` +
        `a project reference reaches above the analyzed root, which repo-relative paths cannot express`,
    );
  }
  return prefix === "" ? (name) => name : (name) => `${prefix}/${name}`;
}

/**
 * The two workspace lists `configsFor` needs, which are the same type and mean
 * different things.
 *
 * Named rather than positional, and both required, because every way of
 * confusing them was silent: two `Workspace[]` arguments let a caller omit
 * `discovered` (reproducing the bug it exists to fix, since the lists are then
 * equal by construction) or pass them the wrong way round (analyzing every
 * workspace the filter excluded). Both answers looked plausible and neither
 * threw. An optional `discovered` would re-open the first of those, and the
 * only caller knows both lists, so it is required.
 */
export interface WorkspaceSelection {
  /** The workspaces to analyze. What `--filter` narrowed the run to. */
  selected: readonly Workspace[];
  /**
   * Every workspace the repository has, `selected` included. Read for
   * ATTRIBUTION only -- never for selection, so a workspace named here and
   * not in `selected` contributes no config by any route.
   */
  discovered: readonly Workspace[];
}

/** What the probe decided about every config it considered. */
export interface ChosenConfigs {
  /** The tsconfigs to open, repo-relative POSIX, sorted. */
  configs: string[];
  /**
   * The candidate siblings that were opened and declined, repo-relative POSIX,
   * sorted. Declined means the probe found none of that workspace's missing
   * files in the config, so it cannot close the gap that survives into the
   * report -- the surviving gap is a subset of the one it was measured
   * against. That is the one thing the coverage section cannot work out for
   * itself, and without it the section offers configs already proven useless.
   */
  rejected: string[];
}

/**
 * The tsconfigs to analyze for `root` and `workspaces`, repo-relative, sorted.
 *
 * The root counts as a workspace. Its own tsconfig routinely covers files
 * that live in no workspace at all -- scripts, tooling, config -- and dropping
 * it trades one coverage hole for another.
 *
 * Every workspace's primary config is loaded. A SIBLING config is loaded only
 * when the workspace has source that no primary reaches and that sibling is
 * what reaches it. Both halves matter: `tools/alpha/tsconfig.test.json` adds
 * the test file its main config excludes, while `tools/alpha/tsconfig.build.json`
 * names a proper subset of the same main config and adds nothing. Taking
 * every sibling would load the second, which costs a whole extra program for
 * files already in the answer.
 *
 * The test is "does this config cover a file that is missing", not "is this
 * config the best way to cover it": two siblings that both reach the same
 * gapped file are BOTH kept. Nothing here can rank them -- each genuinely
 * closes the gap -- and loading one config too many costs a program load,
 * while picking the wrong one of the two would cost coverage.
 *
 * Decided by LOADING rather than by reading `include`/`exclude`.
 * Reimplementing tsconfig glob semantics, `extends` chains included, is a
 * silent-wrongness trap of the kind AGENTS.md §3 catalogues, and the sibling
 * shapes in the wild differ: one is disjoint from its main config, the other
 * a superset of it.
 *
 * TWO probes, never one per workspace. A probe is not the per-workspace
 * saving it looks like: `sourceFileNames` carries the measurements, and the
 * short version is that its cost is dominated by a fixed `tsgo` spawn that a
 * program load pays too, so at workspace size a probe is free rather than
 * cheap and N of them is N spawns bought for nothing. The primaries go in one
 * call and the candidate siblings in one more, and the second call is skipped
 * entirely when no workspace is missing anything -- the common case, where
 * every workspace has exactly one config.
 *
 * The gap is computed ONCE, globally, and each gapped file is attributed to
 * the deepest workspace that contains it. That is what keeps a directory from
 * being blamed for a file it does not own -- the root for a workspace's
 * source, or a parent workspace for its nested child's -- and it is why no
 * scope needs to be told which directories to skip.
 *
 * Probe names are a strict SUPERSET of what analysis will keep: the probe
 * skips the generated-directory, banner and `--exclude` rules, which
 * `scanSourceFiles` applies. The asymmetry is safe only in this direction, so
 * these names may answer "does this config contribute files" and nothing else
 * -- never the coverage numerator, never a prediction of the analyzed set.
 *
 * The two workspace lists arrive NAMED, in one object, and both are
 * required. They are the same type and they are not interchangeable:
 * `selected` decides what gets analyzed, `discovered` is read for attribution
 * and nothing else. As two positional arrays, each way of getting them wrong
 * was silent and produced a plausible answer -- omitting `discovered`
 * reproduced the exact bug it was added to fix, and swapping the two analyzed
 * every workspace the filter excluded. Neither is expressible now: there is
 * no order to get wrong, and leaving one out is a type error.
 *
 * What `discovered` buys, and it matters only when `selected` is a subset of
 * it -- that is, under `--filter`: without it, a file inside an unselected
 * workspace is contained by no scope, falls through to the root, and a root
 * sibling whose `include` spans the repo is then adopted to close it. The
 * filtered run analyzes the workspace it was told to leave out, and because
 * every number here is computed over the file set -- propagation cost,
 * duplicated coverage, cycles, clusters -- that does not merely add findings,
 * it changes the SELECTED workspace's own. One ordinary
 * `tsconfig.eslint.json` at the root is enough to trigger it.
 *
 * ONE GAP LEFT, deliberately: a sibling that is itself a solution config
 * (`{"files": [], "references": [...]}`) owns no files of its own, so the
 * probe reports its contribution as empty and it is never kept, even when the
 * config it delegates to is the only thing covering a gapped file. The
 * failure direction is UNDER-selection -- the file goes unanalyzed and
 * `analysisScope` reports it as a coverage gap, which is honest if
 * incomplete, rather than an analysis quietly widened past what was asked
 * for. The fix, if it ever matters, belongs in `expandReferences`: roll an
 * added config's files up into the entry for the config that pulled it in,
 * since the caller named that one and can act on it.
 */
export async function configsFor(
  root: string,
  workspaces: WorkspaceSelection,
  opts: ScanOptions = {},
): Promise<ChosenConfigs> {
  // The order of what follows, before any of the reasons for it: take each
  // directory's primary config; probe them all at once to learn what they
  // cover; subtract that from the files on disk to get the gap; attribute
  // each gapped file to the workspace that owns it; offer the siblings of
  // the workspaces left with a gap; probe those; keep the ones that closed
  // something.
  const { selected, discovered } = workspaces;
  // Sorted and deduped: a caller may pass the root itself, or the same
  // workspace twice (two globs matching one directory), and neither may
  // change the answer -- the second is the phantom-identical-clone hazard
  // from AGENTS.md §3 reached by a different road.
  const scopes = [...new Set([".", ...selected.map((w) => w.dir)])].sort(compareStrings);
  // Attribution runs over every workspace that EXISTS, selection over the ones
  // asked for. A workspace left out of the run still owns its files, and
  // saying so is what keeps them out of everyone else's gap. Nothing else
  // reads this list -- `owned`, and therefore both the primaries and the
  // candidates, is built from `scopes` alone, so an unselected workspace can
  // contribute no config by any route.
  const attribution = [...new Set([...scopes, ...discovered.map((w) => w.dir)])].sort(
    compareStrings,
  );

  const owned = new Map<string, DirConfigs>();
  for (const dir of scopes) {
    const configs = configsIn(root, dir);
    if (configs !== undefined) owned.set(dir, configs);
  }
  const primaries = scopes
    .map((dir) => owned.get(dir)?.primary)
    .filter((c): c is string => c !== undefined)
    .sort(compareStrings);
  // Nothing to load, so nothing to probe. `sourceFileNames([])` would throw on
  // an empty common root, and "this tree holds no tsconfig" is a caller's
  // problem to report, not an exception from config selection.
  if (primaries.length === 0) return { configs: [], rejected: [] };

  const primaryProbe = await sourceFileNames(primaries.map((c) => resolve(root, c)));
  const rebasePrimary = rebaseOnto(root, primaryProbe.root);
  const covered = new Set(primaryProbe.names.map(rebasePrimary));

  const gapOf = new Map<string, Set<string>>();
  for (const file of scanSourceFiles(root, opts)) {
    if (covered.has(file)) continue;
    // Keyed by attribution scope, so an unselected workspace gets an entry
    // that nothing ever reads -- which is the point: the file is accounted
    // for, and it is in nobody's gap.
    const dir = deepestScope(attribution, file);
    const gap = gapOf.get(dir);
    if (gap === undefined) gapOf.set(dir, new Set([file]));
    else gap.add(file);
  }

  const candidates: { config: string; scope: string }[] = [];
  for (const dir of scopes) {
    const configs = owned.get(dir);
    if (configs === undefined || (gapOf.get(dir)?.size ?? 0) === 0) continue;
    for (const config of configs.siblings) candidates.push({ config, scope: dir });
  }
  if (candidates.length === 0) return { configs: primaries, rejected: [] };

  // The primaries go in again. Not for the keep-check below -- `byConfig` is
  // per-project and does not change with what else is open -- but so that both
  // probes measure from the same root: a candidate-only probe roots at the
  // candidates' common ancestor, while the gap sets it is compared against
  // were measured from the first probe's. Both are rebased, so this is belt
  // and braces, and it keeps one prefix in play rather than two.
  const candidateProbe = await sourceFileNames(
    [...primaries, ...candidates.map((c) => c.config)].map((c) => resolve(root, c)),
  );
  const rebaseCandidate = rebaseOnto(root, candidateProbe.root);
  const kept = candidates.filter(({ config, scope }) => {
    const gap = gapOf.get(scope);
    // `byConfig`, not the union: with two siblings beside one workspace the
    // union says only that SOMETHING closed the gap, and keeping both is
    // exactly the "adds nothing" config this check exists to refuse.
    //
    // A candidate that is itself a solution config answers EMPTY here -- its
    // files belong to the configs it references, which the probe lists
    // separately -- so it is declined even when it covers the gap. That errs
    // toward an honest coverage gap rather than toward a widened analysis,
    // which is the safe direction. Fixing it means rolling a referenced
    // config's files up into the entry for the config that pulled it in,
    // inside `expandReferences`; do it there, not by unioning here.
    const own = candidateProbe.byConfig.get(resolve(root, config).toLowerCase()) ?? [];
    return gap !== undefined && own.some((name) => gap.has(rebaseCandidate(name)));
  });

  const chosen = [...new Set([...primaries, ...kept.map((k) => k.config)])].sort(compareStrings);
  return {
    configs: chosen,
    // Subtracted rather than assumed disjoint: a config kept for one workspace
    // must not also be reported as declined because another scope declined it.
    rejected: [...new Set(candidates.map((c) => c.config))]
      .filter((c) => !chosen.includes(c))
      .sort(compareStrings),
  };
}
