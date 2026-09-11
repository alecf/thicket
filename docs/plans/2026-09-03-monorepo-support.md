# Monorepo Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Point thicket at a monorepo root and have it analyze every workspace, with turbo-style `--filter` to narrow the run.

**Architecture:** A new `src/extract/workspaces.ts` reads workspace globs from the root manifest, expands them to workspace directories, applies filters, and picks each workspace's tsconfigs. It emits the `configs: string[]` the adapter already accepts, so nothing downstream changes shape. A cheap `sourceFileNames` probe in the adapter (names only, no AST materialization) drives coverage-based sibling selection without paying for a second full program load.

**Tech Stack:** TypeScript, bun, vitest, `node:path`'s `matchesGlob`, `node:fs`. No new dependencies.

**Design doc:** `docs/plans/2026-09-03-monorepo-support-design.md`. Read it first — it records six decisions and their rejected alternatives.

**Non-negotiables that apply throughout:**
- Sort every collection with `compareStrings` from `src/order.ts`. Never `localeCompare`.
- No fixture, test, comment, or commit message may name the private repo this was validated against. Use "a sample monorepo".
- TDD: write the failing test, run it, watch it fail *for the right reason*, then implement.
- A test that still passes when you delete the feature is worse than no test. After each guard lands, delete it once and confirm the test fails.

---

### Task 1: Workspace fixtures

> **BUILT — the fixture on disk is the source of truth.** This section records
> intent, and it took three review rounds to get right; each round added
> something because the previous version could not falsify the rule it stood
> for. Where this text and `tests/fixtures/workspaces/` disagree, the fixture
> wins, and the disagreement is a bug in this document.

The fixture deliberately uses `tools/` and `libs/` — **not** `apps/`, `packages/`, or `services/`. A hardcoded directory name must fail these tests rather than pass by luck.

**The governing rule for every element below: if deleting the feature it exists
to test leaves the fixture behaving identically, it is not pulling its weight.**
Four properties are here only to satisfy that test — `deep/a/b/gamma` (a `**`
glob), a `node_modules` decoy, a `tsconfig.json` on the negation-excluded
workspace, and `tools/alpha/src/b.ts` (keeping `tsconfig.build.json` a *proper*
subset). Each is noted where it appears.

Two fixtures are built here. `tests/fixtures/workspaces-solution/` is small but
not optional: Task 7 asserts that the root's coverage check is scoped to files
in no workspace, and that guard is untestable against the main fixture, whose
root has no sibling config to be wrongly picked up.

Use `module`/`moduleResolution` `"nodenext"` throughout, matching every other
fixture in the repo. (An earlier draft said `"bundler"`; under bundler
resolution an extensionless relative specifier resolves, which would make this
fixture a weaker test of the AGENTS.md rule that `resolveImport` *throws* on an
unresolved specifier.)

**Files:**
- Create: `tests/fixtures/workspaces/package.json`
- Create: `tests/fixtures/workspaces/tsconfig.json`
- Create: `tests/fixtures/workspaces/scripts/root-util.ts`
- Create: `tests/fixtures/workspaces/tools/alpha/{package.json,tsconfig.json,tsconfig.test.json,tsconfig.build.json,src/a.ts,src/b.ts,src/a.test.ts}`
- Create: `tests/fixtures/workspaces/libs/beta/{package.json,tsconfig.json,src/b.ts}`
- Create: `tests/fixtures/workspaces/libs/ignored/{package.json,tsconfig.json,src/c.ts}`
- Create: `tests/fixtures/workspaces/tools/cfgonly/{package.json,base.json,global.d.ts}`
- Create: `tests/fixtures/workspaces/deep/a/b/gamma/{package.json,tsconfig.json,src/g.ts}`
- Create: `tests/fixtures/workspaces/deep/a/b/gamma/node_modules/dep/package.json` (a decoy)
- Create: `tests/fixtures/workspaces-solution/` (see Step 6)
- Modify: `.gitignore` — a `!tests/fixtures/**/node_modules/` carve-out, so the decoy is tracked

**Step 1: Root manifest and config**

`tests/fixtures/workspaces/package.json`:
```json
{
  "name": "fixture-root",
  "private": true,
  "workspaces": ["tools/*", "libs/*", "deep/**", "!libs/ignored"]
}
```

`tests/fixtures/workspaces/tsconfig.json` — covers only `scripts/`, mirroring a real root config that excludes every workspace directory:
```json
{
  "compilerOptions": { "target": "es2022", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true },
  "include": ["scripts/**/*.ts"]
}
```

`tests/fixtures/workspaces/scripts/root-util.ts`:
```ts
export function rootUtil(n: number): number {
  return n * 2;
}
```

**Step 2: `tools/alpha` — the workspace with a sibling test config**

`tools/alpha/package.json`: `{ "name": "@fix/alpha", "version": "0.0.0" }`

`tools/alpha/tsconfig.json` — excludes tests, the shape that loses files:
```json
{
  "compilerOptions": { "target": "es2022", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`tools/alpha/tsconfig.test.json` — disjoint from the above:
```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.test.ts"],
  "exclude": []
}
```

`tools/alpha/src/a.ts`:
```ts
export function alpha(n: number): number {
  return n + 1;
}
```

`tools/alpha/src/a.test.ts`:
```ts
import { alpha } from "./a.js";

export function checkAlpha(): boolean {
  return alpha(1) === 2;
}
```

**Step 3: `libs/beta` (no sibling) and `libs/ignored` (excluded by the negation glob)**

`libs/beta/package.json`: `{ "name": "beta", "version": "0.0.0" }`
`libs/beta/tsconfig.json`: same shape as alpha's but with no `exclude`.
`libs/beta/src/b.ts`:
```ts
export function beta(n: number): number {
  return n - 1;
}
```

`libs/ignored/package.json`: `{ "name": "ignored", "version": "0.0.0" }`
`libs/ignored/src/c.ts`:
```ts
export function ignored(): string {
  return "should never be analyzed";
}
```
`libs/ignored/tsconfig.json`: same shape as `libs/beta`'s, covering `src/**/*.ts`.

**It must have a working tsconfig**, and this is the point of it. An earlier
draft of this plan said the opposite — that it should have *no* config, so that
the negation glob was the only thing excluding it. That reasoning was inverted:
with no config, `configsFor` yields nothing for it either way, so deleting the
negation handling entirely produced byte-identical output end to end and the
fixture asserted nothing. With a working config, honouring the negation is the
only thing keeping its source out of the analyzed set, and deleting that
handling moves the coverage figure.

**Step 3b: `tools/cfgonly` — a workspace that provides configs and owns no source**

Observed in Sample D: a workspace whose whole job is to publish shared tsconfig
bases, consumed by the others as `"extends": "@scope/cfg/base.json"`. It has a
`package.json`, so it *is* a workspace, but no `tsconfig*.json` and no source.
Config selection must yield zero configs for it rather than throwing or
inventing one.

`tools/cfgonly/package.json`: `{ "name": "@fix/cfgonly", "version": "0.0.0" }`
`tools/cfgonly/base.json`:
```json
{ "compilerOptions": { "strict": true } }
```
`tools/cfgonly/global.d.ts`:
```ts
declare const __FIXTURE__: true;
```
Note the only `.ts` here is a `.d.ts`, which `scanSourceFiles` already skips —
so this workspace contributes zero to the denominator and must never appear as
a coverage gap.

**Step 4: Add helpers**

In `tests/helpers.ts`, append:
```ts
/**
 * A workspace root whose own tsconfig covers only `scripts/`, beside three
 * workspaces and one excluded by a negation glob. Directory names are
 * deliberately `tools/` and `libs/`: any hardcoded `apps`/`packages` name
 * fails here instead of passing by luck. `tools/alpha` carries a sibling
 * `tsconfig.test.json` covering the one file its main config excludes.
 */
export function workspacesRoot(): string {
  return resolve(here, "fixtures/workspaces");
}
```

**Step 5: Commit**

```bash
git add tests/fixtures/workspaces tests/helpers.ts
git commit -m "test: fixture monorepo with non-conventional workspace directory names"
```

---

### Task 2: Read workspace globs from the root manifest

**Files:**
- Create: `src/extract/workspaces.ts`
- Create: `tests/workspaces.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { workspaceGlobs } from "../src/extract/workspaces.js";
import { workspacesRoot, partialRoot } from "./helpers.js";

describe("workspaceGlobs", () => {
  it("reads the array form from package.json", () => {
    expect(workspaceGlobs(workspacesRoot())).toEqual(["tools/*", "libs/*", "!libs/ignored"]);
  });

  // A root that is not a workspace root must be distinguishable from one
  // declaring zero workspaces, or discovery cannot decide whether to run.
  it("answers undefined when no manifest declares workspaces", () => {
    expect(workspaceGlobs(partialRoot())).toBeUndefined();
  });
});
```

**Step 2: Run it and watch it fail**

Run: `bunx vitest run tests/workspaces.test.ts`
Expected: FAIL — cannot find module `../src/extract/workspaces.js`.

**Step 3: Implement**

`src/extract/workspaces.ts`:
```ts
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
 * Nothing about the layout is built in. `apps`, `packages` and `services` are
 * strings that appear in other people's manifests, never in this file.
 */
export function workspaceGlobs(root: string): string[] | undefined {
  return globsFromPackageJson(root) ?? globsFromPnpm(root);
}

function globsFromPackageJson(root: string): string[] | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // An unparseable manifest is not a workspace declaration. Discovery is a
    // convenience, never a dependency (AGENTS.md §5 applies to it too).
    return undefined;
  }
  const ws = (parsed as { workspaces?: unknown })?.workspaces;
  // npm/bun/yarn-berry take an array; yarn v1 takes { packages: [...] }.
  if (Array.isArray(ws)) return strings(ws);
  const packages = (ws as { packages?: unknown })?.packages;
  if (Array.isArray(packages)) return strings(packages);
  return undefined;
}

const strings = (xs: readonly unknown[]): string[] =>
  xs.filter((x): x is string => typeof x === "string");
```

**Step 4: Run and confirm PASS**

**Step 5: Commit**

```bash
git add src/extract/workspaces.ts tests/workspaces.test.ts
git commit -m "feat: read workspace globs from package.json"
```

---

### Task 3: pnpm-workspace.yaml

**Files:**
- Create: `tests/fixtures/workspaces-pnpm/{pnpm-workspace.yaml,package.json,libs/gamma/package.json,libs/gamma/src/g.ts}`
- Modify: `src/extract/workspaces.ts`
- Modify: `tests/workspaces.test.ts`

**Step 1: Fixture**

`pnpm-workspace.yaml`:
```yaml
# a comment that must not become a glob
packages:
  - 'libs/*'
  - "tools/*"
  - '!libs/private'
```
`package.json`: `{ "name": "pnpm-fixture-root", "private": true }` — **no** `workspaces` key, so the YAML path is the only way to find these.

**Step 2: Write the failing test**

```ts
it("reads the block-list form from pnpm-workspace.yaml", () => {
  expect(workspaceGlobs(pnpmWorkspacesRoot())).toEqual(["libs/*", "tools/*", "!libs/private"]);
});

// Degrading to `undefined` keeps a shape we cannot parse from silently
// becoming a wrong answer.
it("answers undefined for a pnpm manifest shape it does not understand", () => {
  expect(globsFromPnpmText("packages: { a: 1 }\n")).toBeUndefined();
});
```

**Step 3: Implement**

Add to `src/extract/workspaces.ts`:
```ts
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
    // a `#` inside a glob survives.
    const line = raw.replace(/(^|\s)#.*$/, "$1").trimEnd();
    if (line.trim() === "") continue;
    if (!inPackages) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
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
```

**Step 4: Run, confirm PASS. Step 5: Commit**

```bash
git commit -am "feat: read workspace globs from pnpm-workspace.yaml"
```

---

### Task 4: Expand globs to workspace directories

**Files:** Modify `src/extract/workspaces.ts`, `tests/workspaces.test.ts`

**Step 1: Write the failing test**

```ts
describe("discoverWorkspaces", () => {
  it("finds workspaces under non-conventional directory names", () => {
    expect(discoverWorkspaces(workspacesRoot())).toEqual([
      { dir: "deep/a/b/gamma", name: "@fix/gamma" },
      { dir: "libs/beta", name: "beta" },
      { dir: "tools/alpha", name: "@fix/alpha" },
      { dir: "tools/cfgonly", name: "@fix/cfgonly" },
    ]);
  });

  // The negation glob is the only thing excluding `libs/ignored`; it has a
  // package.json AND a tsconfig.json like the others, so honouring the negation
  // is the only thing keeping its source out of the analyzed set. Delete the
  // negation handling and this fails -- and so does the coverage figure.
  it("honours negation globs", () => {
    const dirs = discoverWorkspaces(workspacesRoot()).map((w) => w.dir);
    expect(dirs).not.toContain("libs/ignored");
  });

  // `deep/a/b/gamma` is reachable only through the `deep/**` glob. Every other
  // workspace sits at depth 2 under a `dir/*` glob, so without this one a naive
  // single-level expansion passes every test here -- and the decision to walk
  // for package.json and MATCH, rather than expand globs into paths, would be
  // asserted by nothing.
  it("matches a workspace nested below a ** glob", () => {
    const dirs = discoverWorkspaces(workspacesRoot()).map((w) => w.dir);
    expect(dirs).toContain("deep/a/b/gamma");
  });

  // Delete the node_modules skip in the package walk and `dep` becomes a
  // workspace. `.gitignore` carries a `!tests/fixtures/**/node_modules/`
  // carve-out so the decoy is actually tracked -- the same trick the repo
  // already uses to keep a fixture `dist/` alive.
  it("never treats a package inside node_modules as a workspace", () => {
    const dirs = discoverWorkspaces(workspacesRoot()).map((w) => w.dir);
    expect(dirs.some((d) => d.includes("node_modules"))).toBe(false);
  });
});
```

**Step 2: Run, watch it fail.**

**Step 3: Implement**

```ts
import { readdirSync } from "node:fs";
import { matchesGlob } from "node:path";
import { compareStrings } from "../order.js";

export interface Workspace {
  /** Repo-relative POSIX directory. */
  dir: string;
  /** `name` from its package.json, when it has one. */
  name?: string;
}

/** Depth bound for the package walk. Past any real layout; bounds a `**` glob. */
const MAX_WALK_DEPTH = 8;

/**
 * Every directory declared by the root manifest that actually holds a
 * `package.json`, sorted.
 *
 * Candidates are collected by walking for `package.json` and then MATCHED
 * against the globs, rather than by expanding the globs into paths. Expansion
 * would need its own `**` semantics; this needs none, and it never proposes a
 * directory that is not a package.
 */
export function discoverWorkspaces(root: string): Workspace[] {
  const globs = workspaceGlobs(root);
  if (globs === undefined) return [];
  const include = globs.filter((g) => !g.startsWith("!"));
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));

  const out: Workspace[] = [];
  for (const dir of packageDirs(root)) {
    if (!include.some((g) => matchesGlob(dir, g))) continue;
    if (exclude.some((g) => matchesGlob(dir, g))) continue;
    const name = packageName(join(root, dir));
    out.push(name === undefined ? { dir } : { dir, name });
  }
  return out.sort((a, b) => compareStrings(a.dir, b.dir));
}

/** Repo-relative directories holding a package.json, excluding `root` itself. */
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
      // Same skips as `scanSourceFiles`: a checkout inside a dot-directory is
      // a whole second copy of every package in the repo.
      if (name === "node_modules" || name.startsWith(".")) continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (existsSync(join(abs, name, "package.json"))) out.push(childRel);
      walk(join(abs, name), childRel, depth + 1);
    }
  };
  walk(root, "", 1);
  return out;
}

function packageName(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}
```

**Step 4: Run, confirm PASS. Step 5: Commit**

```bash
git commit -am "feat: expand workspace globs to package directories"
```

---

### Task 5: `--filter` selection

**Files:** Modify `src/extract/workspaces.ts`, `tests/workspaces.test.ts`

**Step 1: Write the failing tests**

```ts
const WS: Workspace[] = [
  { dir: "libs/beta", name: "beta" },
  { dir: "tools/alpha", name: "@fix/alpha" },
  { dir: "tools/omega", name: "@fix/omega" },
];

describe("selectWorkspaces", () => {
  it("selects by exact name", () => {
    expect(selectWorkspaces(WS, ["beta"]).map((w) => w.dir)).toEqual(["libs/beta"]);
  });

  it("globs on the name, and a scoped name is not read as a path", () => {
    expect(selectWorkspaces(WS, ["@fix/*"]).map((w) => w.dir))
      .toEqual(["tools/alpha", "tools/omega"]);
  });

  // THE BUG THIS TEST EXISTS FOR. `matchesGlob` treats `/` as a path
  // separator, so a scoped package name never matches `*`. Measured on a
  // sample monorepo, `--filter=*` silently selected 3 of 10 workspaces and
  // reported a clean-looking result over 30% of the tree; on another, where
  // every name is scoped, it errored instead. A partial selection that does
  // not announce itself is the worse of the two. Name patterns are matched as
  // STRINGS, where `/` is an ordinary character.
  it("selects every workspace for `*`, scoped names included", () => {
    expect(selectWorkspaces(WS, ["*"]).map((w) => w.dir))
      .toEqual(["libs/beta", "tools/alpha", "tools/omega"]);
  });

  it("treats a ./-prefixed pattern as a path glob", () => {
    expect(selectWorkspaces(WS, ["./tools/*"]).map((w) => w.dir))
      .toEqual(["tools/alpha", "tools/omega"]);
  });

  // A leading negation starts from everything; otherwise selection starts empty.
  it("starts from all when the first filter is a negation", () => {
    expect(selectWorkspaces(WS, ["!beta"]).map((w) => w.dir))
      .toEqual(["tools/alpha", "tools/omega"]);
  });

  it("applies filters in order", () => {
    expect(selectWorkspaces(WS, ["@fix/*", "!@fix/omega"]).map((w) => w.dir))
      .toEqual(["tools/alpha"]);
  });

  // Silently empty is the failure mode that wastes an afternoon: the report
  // looks clean because nothing was analyzed.
  it("throws naming what is available when a filter matches nothing", () => {
    expect(() => selectWorkspaces(WS, ["nope"])).toThrow(/nope/);
    expect(() => selectWorkspaces(WS, ["nope"])).toThrow(/beta/);
  });

  // A workspace whose directory name differs from its package name is normal:
  // in Sample D a directory `evals` publishes as `@scope/evals`, so the
  // obvious `--filter=evals` matches nothing. That is turbo's behavior too and
  // we keep it -- but the error has to resolve to the thing, so it lists BOTH
  // addresses of every workspace and the reader can see `./evals` works.
  it("lists both the name and the path of each workspace when it fails", () => {
    expect(() => selectWorkspaces(WS, ["alpha"])).toThrow(/@fix\/alpha/);
    expect(() => selectWorkspaces(WS, ["alpha"])).toThrow(/\.\/tools\/alpha/);
  });
});
```

**Step 2: Run, watch them fail.**

**Step 3: Implement**

```ts
/**
 * Apply `--filter` patterns in order.
 *
 * A pattern is a PATH pattern when it starts with `./`, `../` or `/`, and a
 * NAME pattern otherwise. That is turbo's own rule, and it is what stops a
 * scoped package name -- which contains a slash -- being read as a directory.
 */
export function selectWorkspaces(
  all: readonly Workspace[],
  filters: readonly string[],
): Workspace[] {
  if (filters.length === 0) return [...all];
  const selected = new Set<Workspace>(filters[0]!.startsWith("!") ? all : []);
  for (const filter of filters) {
    const negated = filter.startsWith("!");
    const pattern = negated ? filter.slice(1) : filter;
    const hits = all.filter((w) => matchesFilter(w, pattern));
    if (hits.length === 0) {
      // Both addresses of every workspace, because the pattern that failed is
      // usually the other one: a directory `evals` publishing as
      // `@scope/evals` makes `--filter=evals` match nothing, and the reader
      // needs to see that `./evals` is right there.
      const known = all
        .map((w) => (w.name === undefined ? `./${w.dir}` : `${w.name} (./${w.dir})`))
        .sort(compareStrings);
      throw new Error(
        `--filter ${filter} matched no workspace. Available: ${known.join(", ")}`,
      );
    }
    for (const hit of hits) {
      if (negated) selected.delete(hit);
      else selected.add(hit);
    }
  }
  return [...selected].sort((a, b) => compareStrings(a.dir, b.dir));
}

function matchesFilter(ws: Workspace, pattern: string): boolean {
  if (pattern.startsWith("./") || pattern.startsWith("../") || pattern.startsWith("/")) {
    // A PATH is matched as a path: `/` is a separator, so `./tools/*` does not
    // reach `tools/a/b`. `posix.matchesGlob`, never the bare export, which is
    // the win32 implementation on Windows -- see `discoverWorkspaces` for the
    // measurement and the premise test that pins it.
    return posix.matchesGlob(ws.dir, pattern.replace(/^\.\//, ""));
  }
  // A NAME is matched as a string. `matchesGlob` would treat the `/` in a
  // scoped name as a separator, so `*` would silently skip every scoped
  // package -- selecting part of the repo and reporting it as if whole.
  return ws.name !== undefined && globToRegExp(pattern).test(ws.name);
}

/** `*` matches any run of characters, `/` included. Everything else is literal. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
```

**Step 4: Run, confirm PASS. Step 5: Commit**

```bash
git commit -am "feat: turbo-style --filter selection over workspaces"
```

---

### Task 6: A cheap file-name probe in the adapter

`openProject` awaits `getSourceFile(name)` per file, which materializes an AST. Sibling selection only needs the *names*, so it gets its own entry point that skips materialization.

**Files:** Modify `src/extract/ts-adapter.ts`, create `tests/probe.test.ts`

**Step 1: Write the failing test**

```ts
it("lists a project's source files without materializing them", async () => {
  const { root, names } = await sourceFileNames([
    resolve(workspacesRoot(), "tools/alpha/tsconfig.json"),
  ]);
  // The main config excludes tests; the probe must reflect that exactly.
  // NOTE the paths: `root` is commonRootDir of the OPENED configs, which for a
  // single workspace config is that workspace's own directory -- so these are
  // NOT repo-relative. `openProject` does the same with the same argument.
  expect(root).toBe(resolve(workspacesRoot(), "tools/alpha"));
  expect(names).toEqual(["src/a.ts", "src/b.ts"]);
});

it("sees the file the sibling test config adds", async () => {
  const names = await sourceFileNames([
    resolve(workspacesRoot(), "tools/alpha/tsconfig.json"),
    resolve(workspacesRoot(), "tools/alpha/tsconfig.test.json"),
  ]);
  expect(names).toEqual(["src/a.test.ts", "src/a.ts", "src/b.ts"]);
});
```

Note both assert an exact list. `expect(names.length).toBeGreaterThan(0)` would pass with the feature deleted.

`src/b.ts` exists so that `tools/alpha/tsconfig.build.json` (`include: ["src/a.ts"]`)
is a *proper* subset of `tsconfig.json`'s file set rather than equal to it. With
the two sets equal, Task 7's "a sibling that adds nothing is not chosen"
assertion passes under a weaker rule than the one we want. Expect the probe to
return the program's files, which is the transitive closure — `a.test.ts` imports
`a.ts`, so the second case lists three files, not two.

**Step 2: Run, watch it fail.**

**Step 3: Implement** — in `src/extract/ts-adapter.ts`, factor the existing name loop so the probe and `openProject` share the skip rules (`node_modules`, `.d.ts`, `.json`), then:

```ts
/**
 * Repo-relative paths of a project's source files, without materializing any.
 *
 * `openProject` awaits `getSourceFile` per name, which builds the AST; this
 * stops at `getSourceFileNames`. Used to decide whether a workspace's sibling
 * tsconfig contributes files before paying to load it for real. Applies the
 * same skip rules as `openProject` so the two agree about what a "source file"
 * is -- a probe that counted `.d.ts` would propose a sibling that adds nothing
 * analyzable.
 *
 * Deliberately does NOT apply the generated-directory, banner or --exclude
 * rules: those need file text, which is the cost this exists to avoid, and a
 * sibling that contributes only excluded files is a rounding error against a
 * second full program load.
 */
export interface ProbeResult {
  /** Absolute, POSIX-separated; exactly what `openProject` would report. */
  root: string;
  /** Relative to `root`, POSIX, deduped, sorted with `compareStrings`. */
  names: string[];
}

export async function sourceFileNames(configs: readonly string[]): Promise<ProbeResult> {
  const api = new API({ cwd: commonRootDir(configs) });
  try {
    const { snapshot, configs: opened } = await expandReferences(api, [...configs]);
    const root = commonRootDir(opened);
    const seen = new Set<string>();
    for (const project of snapshot.getProjects()) {
      for (const name of await project.program.getSourceFileNames()) {
        if (isSkippedSourceName(name)) continue;
        seen.add(toPosix(relative(root, name)));
      }
    }
    return [...seen].sort(compareStrings);
  } finally {
    // The API holds an open connection to its tsgo child; without this the
    // process never exits (AGENTS.md §3).
    api.close();
  }
}
```

Check the exact disposal call used by `run.ts`'s `finally` and mirror it.

**Step 4: Run, confirm PASS. Step 5: Commit**

```bash
git commit -am "feat: probe a project's source file names without materializing ASTs"
```

---

### Task 7: Coverage-driven config selection

**Split the file first.** By Task 7 `src/extract/workspaces.ts` holds manifest
reading (two formats), a YAML subset parser, a filesystem walk, `--filter`
selection, and now tsconfig probing — four ideas, and `configsFor` drags in
`ScanOptions` and `sourceFileNames` besides. The seam already exists and is
clean: nothing below `interface Workspace` calls anything above it except
`workspaceGlobs` and `readJson`. Move manifest reading (`workspaceGlobs`,
`globsFromPnpmText`, `unquote`, `strings`, `readJson`) to
`src/extract/manifest.ts`; everything from `interface Workspace` down stays.
Split `tests/workspaces.test.ts` along the same line. Do this as its own commit
before any Task 7 behaviour lands, so the move is reviewable as a pure move.

**Add a nested-workspace case to `tests/fixtures/workspaces-solution/`.** The
`excludeDirs` rule below has to hold for a parent workspace, not only for the
root, and nothing currently exercises that.

**Files:** Modify `src/extract/workspaces.ts`, `tests/workspaces.test.ts`

**Step 1: Write the failing test**

```ts
it("adds a sibling tsconfig only when it contributes files", async () => {
  const chosen = await configsFor(workspacesRoot(), [
    { dir: "tools/alpha", name: "@fix/alpha" },
    { dir: "libs/beta", name: "beta" },
  ]);
  expect(chosen).toEqual([
    "libs/beta/tsconfig.json",
    "tools/alpha/tsconfig.json",
    "tools/alpha/tsconfig.test.json",  // adds src/a.test.ts
    "tsconfig.json",                   // the root is a workspace too
  ]);
});
```

`libs/beta` has no sibling, so its absence from the list proves siblings are not added blindly. Delete the contribution check and `tools/alpha/tsconfig.test.json` still appears — so also assert the negative: add a `tools/alpha/tsconfig.build.json` that is a strict *subset* of the main config and assert it is **not** chosen.

Three more cases, each observed in a real repo:

```ts
// Sample D has a workspace that publishes shared tsconfig bases and owns no
// source. It is a workspace (it has a package.json) with no tsconfig*.json at
// all -- must contribute nothing rather than throw.
it("contributes no config for a workspace that has none", async () => {
  const chosen = await configsFor(workspacesRoot(), [{ dir: "tools/cfgonly", name: "@fix/cfgonly" }]);
  expect(chosen.filter((c) => c.startsWith("tools/cfgonly"))).toEqual([]);
});

// Sample D's root tsconfig is `{"files": [], "references": [...]}` -- it owns
// zero files and delegates. Scoping the root's coverage check to the whole
// tree would show every workspace's files as the ROOT's gap, and then hunt for
// a root sibling to close a gap that is not the root's to close.
//
// This needs `tests/fixtures/workspaces-solution/`, built in Task 1. The main
// `workspaces` fixture CANNOT substitute: its root has no sibling
// `tsconfig*.json`, so deleting the scoping changes nothing observable there --
// the root's gap would grow, `configsForOne` would find no sibling, and the
// answer would be identical. The solution fixture's root DOES carry a
// `tsconfig.build.json` reaching into `tools/**`, which is what makes the
// mis-scoped behaviour visible.
it("scopes the root's own coverage check to files in no workspace", async () => {
  const chosen = await configsFor(solutionWorkspacesRoot(), [{ dir: "tools/alpha" }]);
  expect(chosen).not.toContain("tsconfig.build.json");
});

// The root config may `reference` a workspace that discovery also selects.
// AGENTS.md §3 hazard 3 is that a file in N tsconfig projects gets visited N
// times, which surfaces as phantom identical clones.
//
// Assert on the FILE set, not on `chosen`. `expect(new Set(chosen).size)
// .toBe(chosen.length)` cannot fail: `configsFor` iterates distinct
// directories and each emits configs from its own directory, so a duplicate
// config path is impossible by construction. The hazard lives one layer
// lower, when the adapter expands the root's `references: [{path:
// "tools/alpha"}]` and meets `tools/alpha/tsconfig.json` already on the list.
it("analyzes each file once when the root references a workspace", async () => {
  const chosen = await configsFor(solutionWorkspacesRoot(), [{ dir: "tools/alpha" }]);
  const project = await openProject(chosen.map((c) => resolve(solutionWorkspacesRoot(), c)));
  try {
    const paths = project.files().map((f) => f.path);
    expect(paths).toEqual([...new Set(paths)].sort(compareStrings));
  } finally {
    project.close();
  }
});
```

**Step 2: Run, watch it fail.**

**Step 3: Implement**

```ts
/**
 * The tsconfigs to analyze for `root` and `workspaces`.
 *
 * The root counts as a workspace: its own tsconfig routinely covers files that
 * live in no workspace at all (scripts, tooling), and dropping it trades one
 * coverage hole for another.
 *
 * Per workspace: take `tsconfig.json` (or the first `tsconfig*.json` in sorted
 * order when there is none), then diff what it yields against the source files
 * on disk under that workspace. Only when files remain is a sibling loaded,
 * and only siblings that contribute are kept. Most workspaces cost zero extra
 * probes; on a sample monorepo exactly two paid for one each.
 *
 * Decided by LOADING rather than by interpreting include/exclude globs.
 * Reimplementing tsconfig glob semantics, `extends` chains included, is a
 * silent-wrongness trap of the kind AGENTS.md §3 catalogues -- and the two
 * sibling shapes in the wild differ: one is disjoint from its main config, the
 * other a superset of it.
 */
export async function configsFor(
  root: string,
  workspaces: readonly Workspace[],
  opts: ScanOptions = {},
): Promise<string[]> {
  const chosen: string[] = [];
  const workspaceDirs = workspaces.map((w) => w.dir);
  for (const dir of [".", ...workspaceDirs]) {
    // Every directory owns only what lives in NO workspace beneath it.
    //
    // The root is the obvious case: Sample D's root config is `{"files": [],
    // "references": [...]}` -- it owns nothing itself -- and measuring its
    // coverage against the whole tree would blame it for every workspace's
    // files and then hunt for a root sibling to close that gap.
    //
    // But the root is NOT the only case, which an earlier draft of this ternary
    // got wrong. Task 4 makes nested workspaces reachable: `tools/**` yields
    // both `tools/alpha` and `tools/alpha/sub`. A parent workspace scoped with
    // `{}` counts its child's files as its own gap, and then hunts for a
    // sibling config inside the parent to close a gap that is not the parent's
    // to close -- the same bug `tests/fixtures/workspaces-solution/` exists to
    // catch, one level down. So subtract nested workspaces from every scope,
    // not just from the root's.
    const nested = workspaceDirs.filter((d) => dir === "." || d.startsWith(`${dir}/`));
    chosen.push(...(await configsForOne(root, dir, { ...opts, excludeDirs: nested })));
  }
  // A root solution config may `reference` a workspace discovery also selected,
  // so the same path can arrive twice.
  return [...new Set(chosen)].sort(compareStrings);
}
```

`configsForOne` reads `tsconfig*.json` from that directory (sorted, `tsconfig.json` first). **If there are none it returns `[]`** — a workspace can legitimately exist to publish shared config bases and own no source. Return repo-relative POSIX paths so the result is deterministic and printable.

> **Two findings from Task 6 change how the probing must work. Read both before
> writing `configsFor`.**
>
> **(a) A probe's paths are relative to the configs it was given, not to the
> repo.** `sourceFileNames([tools/alpha/tsconfig.json])` answers
> `["src/a.ts", "src/b.ts"]` — **not** `["tools/alpha/src/a.ts", …]` — because the
> root is `commonRootDir` of the *opened* configs, which for one workspace config
> is that workspace's own directory. `openProject` behaves identically, so the
> two agree with each other; but a per-workspace probe diffed against
> `scanSourceFiles` at the repo root finds **zero** overlap, reads it as "this
> config covers nothing", and adds every sibling in the repo.
>
> **(b) The probe is not the saving this plan assumed.** Measured: 1.0× on a
> 2-file project, 1.7× at 32 files, 4.9× at 1000. Both entry points pay the same
> fixed ~35 ms to spawn `tsgo` and load the default lib; only `openProject` pays
> per file. At workspace scale a probe is **not** cheaper than a load — it is
> ~35 ms of fixed cost each, so N probes is N × 35 ms of pure overhead.
>
> Both point the same way: **probe once over all primaries, not once per
> workspace.**
>
> **(c) But batching does NOT guarantee the repo root — this is the trap.** The
> root is `commonRootDir` of whatever configs were passed. If every selected
> workspace lives under `tools/`, the root is `tools/`; and `--filter` narrowing
> the selection to a *single* workspace collapses it to exactly case (a) again —
> so the landmine is reachable through a user-facing flag, not just through a
> careless implementation. Never assume the probe's root; read it. The signature
> returns `{ root, names }` for precisely this reason, and step 3 below has to
> rebase against it.

Revised algorithm — two probes total, not N:

1. Per selected workspace, take `tsconfig.json`, or the first `tsconfig*.json`
   in `compareStrings` order if there is none. Collect them all.
2. **One** `sourceFileNames(allPrimaries)` call, destructured as
   `{ root: probeRoot, names }`.
3. Rebase before comparing: a probe name is repo-relative only after prefixing
   `relative(repoRoot, probeRoot)`. Assert the result stays inside the repo — a
   probe root *above* the repo root means a reference escaped, which is the one
   case repo-relative paths cannot express (`src/extract/ts-adapter.ts`). Gap =
   `scanSourceFiles(repoRoot)` minus the rebased set. Attribute each gapped file
   to the workspace directory that contains it — the deepest one, so a nested
   workspace claims its own files rather than its parent's (Task 4 made nesting
   reachable).
   **Test this with `--filter` narrowed to one workspace**, which is the shape
   that makes `probeRoot !== repoRoot` and would otherwise silently report the
   whole repo as a gap.
4. For each workspace with a gap and unloaded siblings, add that workspace's
   siblings as candidates. If none, stop.
5. **One** further `sourceFileNames(allPrimaries + candidates)` call. Keep only
   the candidates that contributed a file step 3 had in the gap.

This also retires `excludeDirs`: with the gap computed once, globally, and
attributed to the deepest containing workspace, a parent never sees its child's
files as its own and the root never sees any workspace's. Delete that parameter
rather than carrying it — but keep the `workspaces-solution` fixture assertions,
which still pin the behaviour the parameter was there to produce.

**Step 4: Run, confirm PASS. Step 5: Commit**

```bash
git commit -am "feat: pick each workspace's tsconfigs by what they actually cover"
```

---

### Task 8: Pin the cache root; wire up the CLI

Two changes that must land together — the CLI is what supplies the root the cache is pinned to.

**Files:** Modify `src/run.ts`, `src/cli.ts`, `tests/cli.test.ts`, `tests/cache.test.ts`

**Step 1: Write the failing tests**

```ts
// The regression this exists for: with the root derived from commonRootDir,
// narrowing to one workspace collapses the root into that workspace and the
// cache lands in a subpackage.
it("keeps one cache at the analyzed root even when filtered to one workspace", async () => {
  await runReport({ dir: workspacesRoot(), filter: ["@fix/alpha"] });
  expect(existsSync(join(workspacesRoot(), ".thicket/cache.db"))).toBe(true);
  expect(existsSync(join(workspacesRoot(), "tools/alpha/.thicket/cache.db"))).toBe(false);
});

// Filters change the finding set but must not change the config hash, or a
// change of scope deletes and rebuilds the shared cache.
it("shares one cache between a filtered and an unfiltered run", async () => {
  const wide = await runReport({ dir: workspacesRoot() });
  const narrow = await runReport({ dir: workspacesRoot(), filter: ["@fix/alpha"] });
  expect(configHashOf(narrow)).toBe(configHashOf(wide));
});

it("analyzes the directory named as a positional", async () => {
  expect(await main([workspacesRoot()])).toBe(0);
});

it("errors, naming the nearest ancestor, when a directory has no project", async () => {
  const code = await main([join(workspacesRoot(), "tools/alpha/src")]);
  expect(code).toBe(1);
});
```

**Step 2: Run, watch them fail.**

**Step 3: Implement**

- `src/cli.ts`: add `filter: { type: "string", multiple: true }` and `workspaces: { type: "boolean", default: true }` to `parseArgs`. In the positional handling, keep `cache` and `diff` reserved **first**, then treat a lone remaining positional as `dir`. Pass `dir` and `filter` through to `runReport`.
- `src/run.ts`: accept `dir` and `filter`. When `--config` is absent and `workspaces !== false`, call `discoverWorkspaces` → `selectWorkspaces` → `configsFor`. Pin `const analysisRoot = dir` and use `cachePathFor(analysisRoot)`.
- Guard the escape case: if `project.root` resolves *above* `dir`, use `project.root` and warn, because repo-relative paths must not gain a `../` prefix (`src/extract/ts-adapter.ts:431`).
- **Do not** add filters or the workspace list to `configHash`.
- **Warn when a manifest exists but could not be read.** `workspaceGlobs` (Task 2)
  answers `undefined` for absent, unreadable and unparseable alike, which is the
  right call *there* — `src/extract/` writes to stderr nowhere, every warning in
  this codebase lives in `src/cli.ts`, and the coverage banner is a loud
  backstop (a monorepo whose manifest failed to read falls from ~93% coverage to
  a single project and the report says so). But the banner blames *scope*, not
  the manifest, so a `package.json` that exists and is unreadable reads as "not a
  monorepo". The CLI owns stderr and can tell these apart cheaply: an existing
  manifest that failed to read or parse gets one line; ENOENT stays silent. This
  is the layer to do it in.

Update `USAGE` with `[dir]`, `--filter`, `--no-workspaces`.

**Step 4: Run the full suite** — `bun run test && bun run typecheck`. Both must be green; `bun run test` does not typecheck test files, so the second command is not optional.

**Step 5: Commit**

```bash
git commit -am "feat: thicket [dir], --filter, --no-workspaces; pin the cache to the analyzed root"
```

---

### Task 9: Fix the scope warning's dead-end advice

**Files:** Modify `src/extract/scope.ts`, `tests/scope.test.ts`

**Why this is bigger than it looks.** On Sample D at 98.3% coverage, **8 of the
9 remaining gaps advised a `--config` that was already on the command line**.
The ninth correctly advised nothing. So at high coverage — exactly the state
this feature produces — the scope warning degrades into a list of instructions
that cannot work, and one of them named a solution config that owns no files at
all. Left unfixed, monorepo support makes this section actively misleading.

**Step 1: Write the failing test**

```ts
// The observed failure: at 93% coverage the report advised a --config that was
// already on the command line, and was the very config excluding those files.
it("never advises a config that was already passed", () => {
  const scope = analysisScope(workspacesRoot(), ["tools/alpha/src/a.ts"], {
    analyzedConfigs: ["tools/alpha/tsconfig.json"],
  });
  const gap = scope.gaps.find((g) => g.dir === "tools/alpha");
  expect(gap?.config).not.toBe("tools/alpha/tsconfig.json");
});

// `analysisScope` is synchronous and loads no program, so it CANNOT know which
// sibling covers the gap -- it can only know which configs were already tried.
// Naming one would be a guess presented as an instruction, which is the defect
// this task exists to remove. So it offers the untried candidates and asserts
// nothing about which works.
it("offers the siblings that have not been tried, and not the one that has", () => {
  const scope = analysisScope(workspacesRoot(), ["tools/alpha/src/a.ts"], {
    analyzedConfigs: ["tools/alpha/tsconfig.json"],
  });
  const gap = scope.gaps.find((g) => g.dir === "tools/alpha");
  expect(gap?.configs).toEqual([
    "tools/alpha/tsconfig.build.json",
    "tools/alpha/tsconfig.test.json",
  ]);
});

// The common case after this feature lands: every config in the directory was
// already passed, so there is nothing left to suggest. Say nothing rather than
// repeat an instruction the reader already followed.
it("offers nothing when every config in the directory was already tried", () => {
  const scope = analysisScope(workspacesRoot(), ["libs/beta/src/b.ts"], {
    analyzedConfigs: ["libs/beta/tsconfig.json"],
  });
  expect(scope.gaps.find((g) => g.dir === "libs/beta")?.configs).toEqual([]);
});
```

**Step 2: Run, watch them fail.**

**Step 3: Implement** — give `ScanOptions` an `analyzedConfigs?: readonly string[]`. Replace `ScopeGap.config?: string` with `configs: string[]`: every `tsconfig*.json` in the owning directory, sorted with `compareStrings`, minus those already analyzed. The current code hardcodes the `tsconfig.json` basename in two places — both must change. Update `scopeWarning` in `src/report/markdown.ts` to render a list (and to render nothing when the list is empty), and update the JSON sidecar shape.

> **Design note — read before implementing.** An earlier draft of this task said
> "emit the first remaining sibling", and asserted that would be
> `tsconfig.test.json`. It would not: sorted, `tsconfig.build.json` comes first,
> and it covers nothing new. That is the fixture doing its job. The deeper point
> is that ranking siblings requires knowing what each one *covers*, which needs a
> program load — `analysisScope` is synchronous by design and has none. So it
> must not rank. Where ranking is possible is the workspace path: `configsFor`
> (Task 7) already probes every candidate sibling and keeps the ones that
> contribute, so after it runs, a surviving gap genuinely has no config that
> closes it. **If Task 7 threads its probe results through, prefer that: emit an
> empty `configs` for a directory whose siblings were all probed and rejected.**
> Decide this while implementing, and say in the report which way you went.

**Step 4: Run, confirm PASS. Step 5: Commit**

```bash
git commit -am "fix: stop advising a --config that was already passed"
```

---

### Task 10: Size-targeted granularity, confined to the multi-workspace path

**Risk:** `THK-CYC-*` ids derive from module names. Changing granularity globally churns ids on ordinary repos, and finding ids are the loop's backbone (PRD §9.1). So size-targeting applies **only** when more than one workspace is in play; single-project runs keep today's `selectGranularity` exactly.

**Measured shape of the problem.** In both sample monorepos a *single*
workspace holds ~88% of the source: 6048 of 6831 in Sample C, 3923 of 4464 in
Sample D. So per-workspace granularity is not mainly about splitting the big
app — it is about not shredding the small packages. Sample D makes the case
concrete: it has workspaces of 1, 3, 5 and 12 source files. A per-workspace
`[8, 64]` clamp would try to cut a 1-file workspace into 8 modules; size
targeting resolves each to exactly one, which is the honest answer.

> **Before you write a cross-workspace assertion, read this.** The `workspaces`
> fixture has **zero** cross-workspace imports, so its module graph has no
> inter-workspace edges at all. Adding one means a bare specifier
> (`@fix/alpha`), which under `"type": "module"` + `nodenext` will not resolve
> without a `paths` mapping or a real `node_modules` link — and AGENTS.md §2 is
> explicit that a specifier arriving at `resolveImport` unresolved is a **bug
> that throws**, not a missing module. So the first cross-workspace edge you add
> gets you a crash, not a quietly absent edge. Add the `paths` mapping to the
> consuming workspace's tsconfig at the same time you add the import.

**Files:** Modify `src/graph/granularity.ts`, `tests/granularity.test.ts`

**Step 1: Write the failing test**

```ts
// One global depth makes a large workspace's subdirectory a peer of a small
// workspace's whole tree. Assert the spread narrows, with exact counts.
it("picks a depth per workspace so module sizes are comparable", () => {
  const g = selectGranularityAcross(
    [{ dir: "big", paths: bigPaths /* 400 files */ },
     { dir: "small", paths: smallPaths /* 12 files */ }],
  );
  expect(moduleSizes(g).max / moduleSizes(g).min).toBeLessThan(4);
  expect(g.moduleOf["small/src/x.ts"]).toBe("small");
});

it("leaves single-project runs on the existing granularity", () => {
  expect(selectGranularity(paths).label).toBe("dir:2");
});
```

**Step 2: Run, watch them fail.**

**Step 3: Implement** — add `selectGranularityAcross(groups)`: compute one global target size (`total files ÷ clamp(round(sqrt(total)), 8, 64)`), then per group pick the depth whose mean module size is nearest that target, prefixing module names with the workspace directory. Leave `selectGranularity` untouched.

**Step 4: Run the full suite plus `bun run typecheck`. Step 5: Commit**

```bash
git commit -am "feat: per-workspace granularity targeting a module size"
```

---

### Task 11: Validate against a real monorepo and measure

**Not a code task — a measurement.** The design makes two cost claims that are currently unverified.

**Step 1: Golden-path check.** Against **two** sample monorepos (paths supplied
at run time, never committed). They differ in every way that matters: package
manager, manifest format, root-config style.

```bash
bun run thicket <dir> --json /tmp/ws.json > /tmp/ws.md
```

| | Sample C | Sample D |
| --- | --- | --- |
| manifest | `package.json` `workspaces` | `pnpm-workspace.yaml` |
| root tsconfig | owns 333 files, excludes every workspace dir | solution config, owns **zero** files |
| workspaces | 10 | 14, one with no tsconfig, one addressed by a non-glob entry |
| baseline coverage | 333 / 7337 = 4.5% | 3968 / 4348 = 91.3% |
| **expected after discovery** | **6831 / 7337 = 93.1%**, 2 SCCs | **4390 / 4464 = 98.3%**, 3 SCCs |

Both must match the hand-assembled `--config` baseline finding-for-finding.
Sample D is the sharper test of discovery (its manifest is the only place the
workspace list exists); Sample C is the sharper test of the payoff (its
baseline is 4.5%).

**Step 2: Cost.** Time a cold run (`--no-cache`) and a warm one. The design predicts the sibling probes add little because probes skip AST materialization. **If cold time regresses more than ~25%, stop and reconsider** — the fallback is to load all `tsconfig*.json` per workspace in a single pass and report which contributed.

**Step 3: Determinism.** Run twice warm; `md5` must match. Run cold and warm; the *cluster lists* must be deeply equal (`tests/cache-pipeline.test.ts`), not merely the Markdown, which is truncated to the top findings and will hide a cache that lost fragments.

**Step 4: Filter check.** `--filter` on one workspace must report no gap for the others, and must not reset the cache — assert row count grows rather than resetting.

**Step 5: Record the measurements** in the design doc under a new "Measured" section, then commit.

---

### Task 12: Documentation

**Files:** Modify `AGENTS.md`, `README.md`, `docs/PRD.md`

- `AGENTS.md`: note that workspace discovery is an opinion with its own off switch (§4b), and record the refinement to the cache-hash rule — *what is stored for a file* joins the hash, *which files are asked about* does not.
- `AGENTS.md`, a new hazard — **one class is bounded only by the runtime choice.**
  Proposed wording, measured rather than asserted:

  > A glob alternating `*` with literals backtracks exponentially under node's
  > JavaScript glob implementation (6.4s at ten stars on a 40-character subject)
  > and is constant-time under bun's native one — measured at 0.000s from the
  > *same* `dist/` JavaScript, so the immunity belongs to the runtime, not the
  > build. Manifest globs come from the repository being analyzed, so do not
  > reintroduce a complexity cap to fence a case the supported runtime cannot
  > reach. Do not assume the same of a *compiled RegExp*, which is slow on both
  > (1.2s under bun at ten stars) and is why `matchesNameGlob` exists.

- **Reconcile the runtime claims with bun-exclusivity.** `AGENTS.md` currently
  says "`dist/` still runs under Node ≥24 for anyone who installs the bin", and
  `package.json` `engines` carries `"node": ">=24"`. Both contradict a bun-only
  target, and the node path is exactly where the glob hazard above lives. Check
  whether the bun-compiled-binary work has already changed `engines` before
  editing it, so the two do not fight.
- `README.md`: document `thicket [dir]`, `--filter`, `--no-workspaces`.
- `docs/PRD.md`: a short subsection under §7.1 on per-workspace granularity, noting that a workspace is a semantic boundary where directory depth is not.

```bash
git commit -am "docs: monorepo discovery, filtering, and the cache-hash refinement"
```
