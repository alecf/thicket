import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
 * This is also where manifest formats meet: every one underbrush understands is
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
  const list = declaredList((parsed as { workspaces?: unknown })?.workspaces);
  return list === undefined ? undefined : strings(list);
}

/**
 * The `workspaces` value as a list, in either spelling, or `undefined`.
 *
 * npm/bun/yarn-berry take an array; yarn v1 takes `{ packages: [...] }`. Read
 * here rather than in each caller so `manifestProblems` cannot come to
 * disagree with the reader about which shapes are understood -- the whole
 * value of that diagnostic is that it describes THIS function's answer.
 */
function declaredList(ws: unknown): readonly unknown[] | undefined {
  if (Array.isArray(ws)) return ws;
  const packages = (ws as { packages?: unknown })?.packages;
  return Array.isArray(packages) ? packages : undefined;
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
 * Quoting is read, not approximated. A `#` inside a quoted scalar is content,
 * and treating it as a comment used to return `'libs/team` for
 * `- 'libs/team #1/*'` -- a confident wrong answer, which is the single shape
 * this design exists to avoid, and a silent one: the workspace just vanishes
 * from discovery and its files come back as an unexplained coverage gap. That
 * divergence was recorded as tolerable on the grounds that a stray quote fails
 * visibly. It does not fail at all, which is why it is gone.
 *
 * What is still refused, because reading it means being a YAML parser: an
 * unterminated quote (invalid YAML, and every guess at where the scalar ends
 * yields a glob), anything but a comment after a closing quote, and a
 * double-quoted scalar containing `\`, whose escape table this does not
 * implement. `''` inside a single-quoted scalar IS read, since it is that
 * form's only escape and ignoring it ends the scalar early.
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
    const line = raw.trimEnd();
    if (!inPackages) {
      const key = stripComment(line);
      if (key.trim() === "") continue;
      if (/^packages:\s*$/.test(key)) inPackages = true;
      continue;
    }
    // Indentation is optional: YAML lets a block sequence sit at its key's own
    // column, and manifests in the wild are written both ways. Requiring the
    // indented form would answer `[]` for the flush form -- "a workspace root
    // with no members", stated confidently about a root declaring several.
    //
    // The item is matched against the RAW line and its comment stripped
    // afterwards, by `readScalar`: whether a `#` starts a comment depends on
    // whether the value is quoted, which cannot be known before the value has
    // been found.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      const glob = readScalar(item[1]!.trim());
      // A scalar this cannot read confidently discards the manifest, exactly
      // as an unparseable line does. Pushing a best guess would be the wrong
      // answer in glob form.
      if (glob === undefined) return undefined;
      out.push(glob);
      continue;
    }
    // A new top-level key ends the block. This runs AFTER the item test on
    // purpose: a flush `- x` starts at column 0 too, so testing for a
    // top-level key first would swallow every flush list.
    //
    // Anything else under `packages:` is a shape we do not understand, and
    // guessing is worse than not answering.
    const rest = stripComment(line);
    if (rest.trim() === "") continue;
    if (/^\S/.test(rest)) break;
    return undefined;
  }
  // The `break` above leaves `inPackages` true, so this ternary is only ever
  // distinguishing "there was no `packages:` key at all".
  return inPackages ? out : undefined;
}

/**
 * A comment stripped from a line that cannot hold a quoted scalar -- keys, and
 * the lines that end the block.
 *
 * YAML starts a comment at `#` only at line start or after whitespace, so a
 * `#` inside a word survives. Stripping every `#` would truncate `libs/c#1/*`
 * to `libs/c`, still a valid glob naming a different directory: a wrong answer
 * that looks like a right one.
 */
const stripComment = (s: string): string => s.replace(/(^|\s)#.*$/, "$1");

/**
 * One block-sequence item's value, with any trailing comment removed, or
 * `undefined` if it is a shape this cannot read.
 *
 * A quote only opens a scalar at the START of the value: `libs/don't/*` is a
 * plain scalar holding an apostrophe, and tracking quote state from any quote
 * anywhere would swallow the rest of that line -- re-introducing the bug this
 * function was written to fix, in the opposite direction.
 */
function readScalar(s: string): string | undefined {
  const quote = s[0];
  if (quote !== "'" && quote !== '"') {
    const plain = stripComment(s).trim();
    // An item with no value at all (`- # comment`) is YAML null, not a glob.
    return plain === "" ? undefined : plain;
  }
  // Double-quoted scalars process `\` escapes; see the docstring above.
  if (quote === '"' && s.includes("\\")) return undefined;
  let value = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c !== quote) {
      value += c;
      continue;
    }
    if (quote === "'" && s[i + 1] === "'") {
      value += "'";
      i += 1;
      continue;
    }
    const after = s.slice(i + 1);
    // Only whitespace or a comment may follow the closing quote. `- 'a' oops`
    // is invalid YAML, and reading it as `a` would be a guess.
    return after.trim() === "" || /^\s+#/.test(after) ? value : undefined;
  }
  // Unterminated: invalid YAML, and nothing here knows where it was meant to
  // end.
  return undefined;
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
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

/**
 * A manifest sitting at `root` that exists and declares nothing usable.
 *
 * `path` is absolute; `reason` is one clause, written to follow it.
 */
export interface ManifestProblem {
  path: string;
  reason: string;
}

/**
 * The manifests at `root` that a reader would expect to declare workspaces and
 * that this file could not read.
 *
 * Purely diagnostic, and deliberately separate from `workspaceGlobs`, which
 * answers `undefined` for absent, unreadable and unparseable alike. That is
 * the right answer there -- nothing under `src/extract/` writes to stderr, and
 * every one of those cases means the same thing to discovery: no declaration
 * to read. It is the wrong answer for a reader, because the coverage banner
 * blames SCOPE: a `package.json` with a missing brace makes a monorepo analyze
 * as a single project and the report says the tree is barely covered, naming
 * no cause. The caller that owns stderr asks this instead, and gets one line
 * per manifest.
 *
 * Silence is the answer for a manifest that simply declares no workspaces: a
 * `package.json` with no `workspaces` key is an ordinary package, not a
 * failure, and warning about one would put a line on stderr for every
 * single-project run this tool has ever had.
 *
 * The three shapes that ARE reported are the ones where a reader's
 * expectation and underbrush's answer differ:
 *
 *  - a `package.json` that is not JSON at all;
 *  - a `workspaces` key holding something other than a list (or a yarn-v1
 *    `{ packages: [...] }`), which declares workspaces in a dialect this does
 *    not read;
 *  - `workspaces` entries that are not strings, which `workspaceGlobs` drops
 *    silently -- the run then analyzes a subset of the tree and looks whole;
 *  - a `pnpm-workspace.yaml` whose `packages:` list this refused, which is the
 *    whole reason that file exists.
 */
export function manifestProblems(root: string): ManifestProblem[] {
  const out: ManifestProblem[] = [];
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    const parsed = readJson(pkg);
    if (parsed === undefined) {
      out.push({ path: pkg, reason: "could not be read as JSON" });
    } else {
      const ws = (parsed as { workspaces?: unknown })?.workspaces;
      const list = declaredList(ws);
      if (ws !== undefined && list === undefined) {
        out.push({ path: pkg, reason: `declares "workspaces" in a shape underbrush cannot read` });
      } else if (list !== undefined) {
        const dropped = list.length - strings(list).length;
        if (dropped > 0) {
          out.push({
            path: pkg,
            reason: `declares ${dropped} "workspaces" ${dropped === 1 ? "entry" : "entries"} that is not a string`,
          });
        }
      }
    }
  }
  for (const name of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      out.push({ path, reason: "could not be read" });
      continue;
    }
    if (globsFromPnpmText(text) === undefined) {
      out.push({ path, reason: "declares no `packages:` list this can read" });
    }
  }
  return out;
}
