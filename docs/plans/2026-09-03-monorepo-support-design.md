# Monorepo support — design

Status: accepted, not yet implemented.
Measured against **Sample C**, a 7337-file / 10-workspace TypeScript monorepo
(bun workspaces + turbo). Workspaces are referred to below as `app-1` (6048
files), `app-2` (633), `app-3` (89), `app-4` (2), `pkg-1` (103), `pkg-2` (61),
`pkg-3` (27), and three small `svc-*` packages. Per AGENTS.md §6 no real name,
path, or source appears here.

## 1. The problem, measured

Pointed at Sample C's root, Underbrush built a program from **333 of 7337 files
(4.5%)**. The root `tsconfig.json` excludes the two directories holding every
workspace; the 333 are root-level scripts plus whatever the `paths` mapping
dragged in transitively.

The scope warning (`src/extract/scope.ts`) diagnosed this correctly and named
the right fix. Following that advice by hand — eleven `--config` arguments —
produced:

| metric | root config alone | all workspace configs |
| --- | --- | --- |
| analyzed | 333 / 7337 (4.5%) | 6831 / 7337 (**93.1%**) |
| dependency cycles | 0 | 2 (largest SCC 12 modules, 10 at runtime) |
| propagation cost | 0.04 | 0.12 |
| findings | 484 | 21384 |

The zero-cycles result at 4.5% was exactly the artifact the scope warning says
it is. Cold analysis ran in ~14 min; a warm re-run took **161 s** and produced
a **byte-identical** report, so the cache invariant (AGENTS.md §5) holds at
6831-file scale and the cost of getting this right is not the blocker.

The blocker is that the eleven arguments are hand-assembled. Nothing in the
tool knows a workspace exists.

Two further defects surfaced while validating the expanded run, and both are
fixed by the same work:

- **The residual gap advice is a dead end.** At 93.1%, the remaining 506 files
  are excluded by the workspace tsconfigs' *own* `exclude` lists — 198 test
  files in `app-2`, 173 e2e/archive files in `app-1`. The report still prints
  `--config app-2/tsconfig.json`, a config already on the command line and the
  very one excluding them. Meanwhile `app-2/tsconfig.test.json` exists and
  covers precisely those 198 files, but `owningDir` hardcodes the
  `tsconfig.json` basename and never looks for a sibling.
- **The cache root is derived, not pinned.** `cachePathFor(project.root)` where
  `project.root = commonRootDir(opened)`. Narrow the config set to one
  workspace and the common root collapses into that workspace, putting
  `.underbrush/cache.db` inside a subpackage.

## 2. Decisions

| # | Decision | Rejected alternative |
| --- | --- | --- |
| 1 | Discovery is **automatic** when a workspace root is found; `--no-workspaces` turns it off | opt-in `--workspaces` flag; "expand only on shortfall" |
| 2 | Per workspace, start at `tsconfig.json` and add sibling `tsconfig*.json` **only if it contributes files** | `tsconfig.json` only; every `tsconfig*.json` unconditionally |
| 3 | `--filter` supports **names, globs, path globs, `!` negation** | exact names only; turbo's `...` dependency traversal |
| 4 | `underbrush [dir]`; **no upward search** — the named directory is the root | walk up to the workspace root |
| 5 | Module granularity targets a **module size**, chosen per workspace | one global depth; per-workspace `[8,64]` clamp; workspace-as-module |
| 6 | Workspace selection and filters are **cache-neutral** — they do not join the config hash | hash them, per a literal reading of AGENTS.md §4b |

## 3. Discovery

New module `src/extract/workspaces.ts`, upstream of the adapter. It emits the
same `configs: string[]` the adapter already accepts, so nothing downstream
changes shape.

**Nothing about the layout is built in.** Underbrush has no knowledge of any
directory name. Globs are read from exactly two manifests:

- `package.json` → `workspaces`, both the array form and yarn's
  `{ "packages": [...] }` object form
- `pnpm-workspace.yaml` → `packages:`

Negation entries (`"!libs/legacy"`) are honored; both package managers define
them. A repo declaring `["*"]` or `["src/mod/*"]` behaves identically.

**Membership.** Expand the globs to directories containing a `package.json`.
Read `name` from each; a workspace without one is addressable by path only.

**The root is itself a workspace.** Sample C's root `tsconfig.json` covers 333
files that live in no workspace at all. Omitting it trades one coverage hole
for another. The config list is *root tsconfig + every selected workspace's
configs*.

**pnpm's YAML.** Hand-parse the single shape that matters — a `packages:` key
holding a list of scalars — rather than add a dependency to a two-dependency
project. Anything unrecognized degrades to "no workspaces found", i.e. today's
behavior. Discovery is a convenience, never a dependency: an unreadable
manifest, a glob matching nothing, a workspace whose tsconfig will not load —
each degrades to "that workspace is not in the program" and surfaces through
the existing scope warning.

## 4. Config selection

Per selected workspace:

1. Load `tsconfig.json`, or if absent the first `tsconfig*.json` in
   `compareStrings` order.
2. Diff the files it yields against `scanSourceFiles` over that workspace's
   subtree — machinery that already exists.
3. If files remain and unloaded siblings exist, load the next sibling in
   `compareStrings` order; keep it only if it contributes at least one new
   file. Repeat to fixpoint.

Deciding by **loading** rather than by interpreting `include`/`exclude` globs
is deliberate. Reimplementing tsconfig glob semantics, `extends` chains
included, is a silent-wrongness trap of the kind AGENTS.md §3 catalogues, and
the two sibling shapes in Sample C are already different: `app-2`'s test config
is *disjoint* from its main one, while `svc-1`'s typecheck config is a
*superset* of its main one. A glob-diffing shortcut has to get both right.

Cost is bounded: a sibling is loaded only when unanalyzed files remain. On
Sample C that is two extra loads, both of which pay for themselves (198 and 12
files).

This also retires the dead-end advice. Once siblings are considered, the
scope warning must additionally never name a config already passed.

## 5. Filtering

`--filter=<pattern>`, repeatable, order-significant.

- A pattern is a **path** pattern if it starts with `./`, `../`, or `/`;
  otherwise it is a **name** pattern. This is turbo's own disambiguation rule
  and it is what stops a scoped package name like `@scope/pkg` being read as a
  path.
- `*` globs within either form.
- A leading `!` negates.
- If the first filter is a negation the selection starts from "all", otherwise
  from empty.
- A filter matching no workspace is an **error** listing what is available,
  never a silently empty report.

**The denominator follows the selection.** Under `--filter`, coverage is
measured against the selected workspaces' subtrees only, so a deliberately
scoped run stays quiet rather than reporting the rest of the repo as a gap.
This is the rule `analysisScope` already documents for
`--config <workspace>/tsconfig.json`.

Turbo's `...` dependency traversal is deliberately out of scope: it needs the
workspace dependency graph and a decision about whether the denominator follows
the expansion, and no validated need for it has appeared.

## 6. CLI surface

```
underbrush [dir]              analyze <dir> (default ".")
  --filter <pattern>          select workspaces; repeatable
  --no-workspaces             ignore workspace manifests
```

`cache` and `diff` remain reserved first positionals, checked before `[dir]`,
so `underbrush cache clear` and `underbrush diff a.json b.json` stay unambiguous; a
directory genuinely named `diff` is reachable as `./diff`.

**No upward search.** `underbrush` analyzes exactly where it is pointed. Pointing
at a workspace scopes the run *and* the coverage denominator to that workspace.
A directory with neither workspaces nor a tsconfig is an error naming the
nearest ancestor that has one — discoverability without the surprise of a leaf
directory silently analyzing 6831 files.

Explicit `--config` suppresses discovery: the caller asked for something
specific. `--filter` implies discovery. Per AGENTS.md §4b, `--no-workspaces`
disables *only* workspace discovery — not `--exclude`, not the banner sniff.

## 7. Cache

**One cache, pinned to `<dir>`.** Not derived from `commonRootDir`. Pinning
also keeps repo-relative paths — which are the cache keys — stable across runs
of differing scope, so a filtered run is a pure hit against the full run's rows.

The one case `<dir>` cannot win: a project reference reaching *above* `<dir>`
would force `../`-prefixed paths and break the repo-relative-path contract
(`src/extract/ts-adapter.ts:431`). There correctness wins — use the higher root
and say so.

**Workspace selection and filters must not join the config hash.** A stale
`config_hash` makes `openDatabase` delete and rebuild the database
(`src/cache/db.ts:264`). The cache is consulted per file, keyed by path and
content hash (`src/fingerprint/cluster.ts:89`), and the file list always comes
from the tsconfigs, never from the cache — so a filter changes which files are
*asked about*, never the fragments extracted for any one of them. Hashing
filters would make `--filter=app-1` throw away the whole-repo cache and the
next full run throw away `app-1`'s, which is the per-subpackage thrash this
design exists to prevent.

This refines AGENTS.md §4b. The rule should read: anything that changes *what
is stored for a file* joins the hash; anything that changes only *which files
are asked about* does not. By that test `minNodes`, `minLines`, `types` and
`version` belong in the hash, and workspace selection does not.

> Observation, not part of this change: `exclude`, `includeGenerated` and
> `bannerScan` are in the hash today but only affect file membership, so they
> over-invalidate by the same test. Worth a separate look.

## 8. Granularity

At one global depth, Sample C's modules ranged from 63 files to 1786 — the
"peers at different scales" failure AGENTS.md already calls out for depth. A
workspace is a real semantic boundary, unlike a directory depth, so it is the
one place depth may legitimately differ.

**Target a module size, not a module count.** Compute one global target size
(total files ÷ the clamped `sqrt` target, ≈107 files/module on Sample C), then
let each workspace pick the depth whose modules land nearest that size.

- Sizes even out by construction.
- The repo-wide count stays near today's (~60, versus ~136 for a per-workspace
  `[8,64]` clamp).
- A genuinely small package honestly resolves to a single module rather than
  being shredded into eight 8-file ones.
- Unlike a proportional split of a fixed global budget, one workspace's depth
  does not shift when an unrelated package is added.

Workspace-as-module was rejected outright: PRD §2.6 measured that
`package.json`-level boundaries bury 76–100% of edges, and both real SCCs in
Sample C live *inside* a single workspace and would vanish.

## 9. Testing

Per AGENTS.md, each guard gets a test that fails when the guard is deleted.

- **Fixture `tests/fixtures/workspaces/`** deliberately uses directory names
  that are *not* `apps`/`packages`/`services` — a hardcoded name then fails the
  test rather than passing by luck.
- Manifest parsing: array form, yarn object form, pnpm YAML, negation globs, a
  glob matching nothing, an unreadable manifest.
- Sibling selection: a fixture with a disjoint test config and one with a
  superset config; assert the *file set*, and assert that a sibling
  contributing nothing is not loaded.
- Filters: each form, negation-first, order significance, and that a
  no-match filter errors rather than emitting an empty report.
- Denominator: a filtered run reports no gap for unselected workspaces.
- Cache: assert `cache.db` lands at `<dir>/.underbrush/` for a filtered run —
  this is the regression that motivated pinning. Assert a filtered run and a
  full run share a cache (row count grows, never resets).
- Cold/warm cluster-list equality through `tests/cache-pipeline.test.ts`,
  which must assert on clusters, not Markdown.
- Determinism: two runs, byte-identical output.

## 10. Not doing

- Turbo's `...` dependency traversal, and `[HEAD^1]` changed-since filters.
- Reading `turbo.json`. It never declares membership; it inherits it from the
  package manager. Reading it would imply a knowledge it does not have.
- Per-workspace report sections. The merged report already surfaces
  cross-workspace duplication, which was the most valuable class of finding in
  the validation run and would be invisible in per-workspace reports.

## 11. Open risks

- **`selectGranularity` is currently count-targeted.** Switching to
  size-targeting changes module names on non-monorepo repos too, which moves
  `UB-CYC-*` ids. Finding ids are the loop's backbone (PRD §9.1), so this
  needs either a deliberate id-churn note or size-targeting confined to the
  multi-workspace path.
- **Program load cost scales with workspace count**, and the sibling probe adds
  loads. Sample C's cold run was ~14 min; the probe should not make that
  materially worse, but it is unmeasured.
- **The 81-file cross-module cycle found in Sample C is reported by naming four
  arbitrary members**, not a path. Unrelated to this design, but it is the
  largest structural finding the expanded coverage unlocked, and it is not yet
  actionable.
