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
 * Globs come back in declaration order, unmodified. Order is meaning here: a
 * negation only subtracts from what the globs before it matched, and `--filter`
 * is applied against this list as written.
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    // Absent, unreadable and unparseable all land here, and all three mean the
    // same thing: no workspace declaration at this root. None of them may mean
    // "the run fails" -- discovery is a convenience, never a dependency
    // (AGENTS.md §5 applies to it too). An `existsSync` ahead of the read
    // would be a branch no behaviour *this function offers* can distinguish
    // from this catch, so there isn't one. It does distinguish absent from
    // unreadable, which a caller that owns stderr will want; this function just
    // has nothing to say about the difference.
    return undefined;
  }
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
 */
export function globsFromPnpmText(text: string): string[] | undefined {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split("\n")) {
    // YAML starts a comment at `#` only at line start or after whitespace, so
    // a `#` inside a glob survives. Stripping every `#` would truncate
    // `libs/c#1/*` to `libs/c`, which is still a valid glob naming a different
    // directory -- a wrong answer that looks like a right one.
    const line = raw.replace(/(^|\s)#.*$/, "$1").trimEnd();
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
    // A new top-level key ends the block. Anything else under `packages:` is a
    // shape we do not understand, and guessing is worse than not answering.
    if (/^\S/.test(line)) break;
    return undefined;
  }
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
