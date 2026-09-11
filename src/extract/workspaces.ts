import { readFileSync } from "node:fs";
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
 */
export function workspaceGlobs(root: string): string[] | undefined {
  return globsFromPackageJson(root);
}

function globsFromPackageJson(root: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    // Absent, unreadable and unparseable all land here, and all three mean the
    // same thing: no workspace declaration at this root. None of them may mean
    // "the run fails" -- discovery is a convenience, never a dependency
    // (AGENTS.md §5 applies to it too). An `existsSync` ahead of the read would
    // be a branch no behaviour can distinguish from this catch, so there isn't
    // one.
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
