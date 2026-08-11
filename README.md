# thicket

A CLI that analyzes a TypeScript codebase and emits a **deterministic plaintext complexity report**, designed to be read by an LLM inside a refactoring loop.

```
thicket report → LLM picks targets → LLM refactors → thicket report → …
```

thicket never judges, never edits, never opens PRs. It produces **ranked candidates with precise locations** plus a handful of scalar metrics a harness can watch trend across iterations. Deciding when progress is sufficient is the harness's job.

> **Status: v1, early.** Duplication and module tangle work end to end and are covered by tests; the simplification checks and near-miss duplication described below are not in v1 (see [Known limits](#known-limits)).

## Install

Not on npm — the name is taken by an unrelated package, so `npx thicket` will fetch something else. Run it from a clone:

```bash
git clone <this repo> && cd thicket
npm install
npm run build
node dist/cli.js --help
```

Node ≥24 is required: the cache uses the built-in `node:sqlite`. `npm link` puts a `thicket` on your `PATH` if you want one; the examples below spell out `node dist/cli.js`.

## Usage

Point it at a tsconfig. The report goes to stdout, so it pipes:

```bash
node dist/cli.js --config ./tsconfig.json
node dist/cli.js --config ./tsconfig.json > report.md
```

A monorepo takes one `--config` per project. Passing the same path twice does nothing useful — the TypeScript API dedupes by path — but genuinely distinct configs are analyzed as one corpus, so a package duplicated across two of them is found:

```bash
node dist/cli.js --config packages/a/tsconfig.json --config packages/b/tsconfig.json
```

For the loop, keep the JSON sidecar and diff it against the next iteration's:

```bash
node dist/cli.js --config ./tsconfig.json --json before.json > /dev/null
# ...an LLM refactors something...
node dist/cli.js --config ./tsconfig.json --json after.json  > /dev/null
node dist/cli.js diff before.json after.json
```

```
1 finding resolved, 0 new, duplicated mass -65.2% (253 -> 88), propagation cost 0.44 -> 0.44
  - THK-DUP-c389b5be
```

`diff` exits 0 because the comparison ran, not because the numbers improved. Whether a delta is good enough is a policy question, and a tool that encoded one in its exit code would be judging.

### Flags

| Flag | Meaning |
|---|---|
| `--config <path>` | tsconfig to analyze. **Repeatable.** Defaults to `./tsconfig.json`. A solution-style config that owns no files and only lists `references` is expanded. |
| `--depth <1..5>` | Preset for how deep to look: sets the minimum fragment size and the findings cap per section. Default `3`. |
| `--min-nodes <n>` | Override the depth preset's minimum fragment size, in AST nodes. Smaller means more, finer candidates. |
| `--min-lines <n>` | Override the depth preset's minimum fragment size, in lines. A node count does not bound this — 15 AST nodes fit on one line — and extracting a one-line shape is a strict loss. |
| `--budget-tokens <n>` | Hard ceiling on the whole report. Findings are dropped from the bottom of the ranking and the count dropped is always printed. |
| `--max-locations <n>` | Cap the files each finding names. Unset — the default — names every one, so an agent can reach every copy. |
| `--granularity <g>` | How files are grouped into modules for the graph: `auto` (default), `file`, or a directory depth like `2`. |
| `--include-generated` | Also analyze `dist/`, `build/`, `.next/` and friends, which are excluded by default. Matching is by whole path segment, so `src/distance/` is source either way. |
| `--json <path>` | Additionally write the JSON sidecar here. The Markdown still goes to stdout. |
| `--no-cache` | Re-analyze every file, ignoring `.thicket/cache.db`. |
| `--help` | Print usage. |

The depth presets, in full:

| `--depth` | `--min-nodes` | `--min-lines` | findings per section |
|---|---|---|---|
| 1 | 40 | 10 | 10 |
| 2 | 25 | 6 | 20 |
| 3 (default) | 15 | 4 | 40 |
| 4 | 10 | 3 | 80 |
| 5 | 6 | 2 | 200 |

`--depth` is the knob a human turns; `--budget-tokens` is the knob a harness turns, because a harness knows its context window and not its desired depth.

### Commands

| Command | Meaning |
|---|---|
| `diff <before.json> <after.json>` | Compare two `--json` sidecars: findings resolved, findings added, and how each metric moved. Analyzes nothing, so it needs no tsconfig. |
| `cache clear` | Delete `.thicket/cache.db` for the analyzed project. Takes the same `--config` flags, because the cache lives with the codebase rather than with the working directory. |

## Report format

Pointed at this repository's own test fixture, `node dist/cli.js --config tests/fixtures/sample/tsconfig.json` prints exactly this:

`````markdown
# thicket report

thicket 0.1.0 · config 97d8d00b · 4 files / 56 LOC · granularity: file (4 modules)

## Summary

| metric | value |
| --- | --- |
| analyzed | 4 of 4 source files (100.0%) |
| duplicated mass | 253 redundant nodes (overlapping; trend only) |
| duplicated coverage | 37.9% of source bytes |
| propagation cost | 0.44 |
| dependency cycles | 1 (largest SCC: 2 modules) |
| findings | 3 of 3 shown |

## Duplication

`L0` matches copies that are identical once formatting is normalized; `L1` also ignores what identifiers are called. Each finding is therefore the copies of one exact shape — a near-variant that differs by an inserted line is a separate finding, cross-referenced as **see also** where one exists.

### THK-DUP-d165768d · 3 copies × ~10 lines · ~16 lines recoverable

L1 · `FunctionDeclaration`

- **directly imported by:** 1 file outside the cluster

```ts
export function normalizeAlpha(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const dx = p.x - ORIGIN.x;
    const dy = p.y - ORIGIN.y;
    const len = Math.sqrt(dx * dx + dy * dy);
…
```

- `src/alpha.ts:4`
- `src/beta.ts:3,14`

### THK-DUP-c389b5be · 2 copies × ~10 lines · ~7 lines recoverable

L0 · `Block`

- **directly imported by:** 1 file outside the cluster

```ts
{
  const result: Point[] = [];
  for (const p of points) {
    const dx = p.x - ORIGIN.x;
    const dy = p.y - ORIGIN.y;
    const len = Math.sqrt(dx * dx + dy * dy);
…
```

- `src/alpha.ts:4`
- `src/beta.ts:14`

## Module tangle

Arrows run importer → imported. The number is import sites — one per symbol per importing file, `export … from` re-exports included; `type` marks an edge erased at compile time and so not a runtime dependency at all. The dotted arrow is the suggested cut.

### THK-CYC-aca08f5a · SCC of 2 modules

```mermaid
flowchart LR
  src/alpha.ts -. "cut · 1" .-> src/gamma.ts
  src/gamma.ts -->|"1"| src/alpha.ts
```

- **file cycles:** 1 crosses these modules (largest 2 files: `src/alpha.ts` ↔ `src/gamma.ts`).
- **suggested cut:** `src/alpha.ts` → `src/gamma.ts` — 1 symbol in `src/alpha.ts`
- **leaves:** nothing — this breaks the cycle completely.

`````

That fixture holds three structurally identical `normalize` functions, two of which are byte-identical, and an `alpha ↔ gamma` import cycle. Both duplication findings are real and they are not the same finding: the **L1** one covers all three functions (identical once identifiers are α-renamed), the **L0** one covers only the two that match byte for byte — and it is reported as a `Block` rather than a `FunctionDeclaration` because the two functions have different *names*, so the largest exactly-equal node is the body.

Findings appear under `## Duplication`, then `## Module tangle`, then `## Duplication in tests` — which is also the order a token budget spends itself in, so pressure costs test hygiene before it costs production work.

Reading a finding: the heading carries the id to cite and the size to judge by, and the line under it carries `L0`/`L1` (the normalization level), the AST kind, the ranker's `score` (only the ordering is meaningful, not the units), and a `[test]`/`[mixed]` tag where one applies. `~10 lines` is the median span of one copy, and `~16 lines recoverable` is what a successful extraction deletes — `(copies − 1) × (lines − 1)`, less the signature the extracted definition costs. Locations are collapsed to one entry per file — `src/beta.ts:3,14` is two occurrences in one file — and **every** location is listed. They used to be capped at six files, which read as `… and 13 more files`: a line that tells an agent work remains and gives it no way to reach the work, leaving it to grep for the shape by hand. `--max-locations <n>` restores a cap for callers who would rather truncate a finding than lose it whole to a token budget.

**The report is valid CommonMark**, and that is a tested property rather than an aspiration: `tests/markdown-validity.test.ts` checks the rendered report, the golden file, a scope-warning report and a truncated one for indented prose, unseparated headings, unbalanced fences, and tables missing a delimiter row. It matters because the earlier plaintext-ish format was *not* valid Markdown in a way that only showed up once rendered — every body line was indented two spaces, which CommonMark folds into the preceding paragraph, so the whole Summary collapsed onto one line and the four-space excerpt was swallowed by the location list above it instead of becoming a code block. (An indented code block cannot interrupt a paragraph; only a fenced one can.) Excerpt fences are tagged with the language of the file they came from and are lengthened past any backtick run in the source, so a fragment containing a template literal or a Markdown snippet cannot close its own block and spill the rest of the report onto the page as prose.

The fenced block under each finding is the head of its first occurrence. An AST kind alone — `PropertyAssignment`, `Block` — does not say whether a finding is worth acting on, and deciding without an excerpt means opening files that a single cluster can span a hundred of.

Above the excerpt, each finding carries two facts about its **surroundings**:

- **`every copy imports:`** repo files that every file in the cluster imports, excluding ones the rest of the codebase imports just as often. This is where the copies' shared vocabulary already lives, and often where the abstraction already is. On a real report the top finding was 19 duplicated classes, and this line named the base class that already had the exact generic factory methods all 19 reimplement — the difference between "design an abstraction" and "delete the overrides".

  A **re-export shim is followed through**: `models/vitals/VitalObservation.ts → packages/models/src/wearables/VitalObservation.ts`. Naming only the first is how that same finding failed on the next run — the file it named is nine lines of `export * from`, and the 1012-line base class the whole refactor turns on was one hop further on, leaving an agent to find it by hand. A file is followed only when it forwards exactly one module and imports nothing on its own account; a thirty-module barrel stands for no single thing, so it is named as itself.
- **`directly imported by:`** how many files outside the cluster reach into it. This is what turns "this looks big" into "this is contained", and it is what decides whether a finding gets scheduled. A re-export barrel among those importers hides its own consumers behind it, so what it hides is counted and the barrel named: `5 files outside the cluster, and 17 files more through models/vitals/index.ts`. The bare 5 was a floor presented as a total, and an agent that went and checked concluded the number was a bug.

  The line is **omitted entirely for a cluster of test files**, where it is a constant dressed as evidence: nothing imports a test file, so `nothing outside the cluster` holds for every such finding and distinguishes none of them.

Findings are also weighted by **whether consolidating them would buy anything**. Copy count measures how much is duplicated; it says nothing about whether merging leaves the code better. Two clusters can look identical to the ranker and have opposite answers:

- 19 observation classes differing only in the strings `loincCode`, `unit` and `junctionKey` hold. Same fields, different values — one concept with a parameter list, which a base class absorbs. Worth ~2200 lines.
- 193 three-field projections spanning 89 key-sets, 62 appearing exactly once — `{ labOrderId: p.labOrderId, … }` beside `{ average: s.average, … }`. Different fields, so these are different objects that happen to share a syntax template, and the only abstraction available is a generic `pick` no future change can benefit from.

Both are L1 clusters with almost no exactly-identical members, and the second one ranked **second in the report** while two agents asked to act on it independently declined. The discriminator is whether the copies' *field names* drift: same names with different values is one shape parameterized; different names is several shapes wearing one template. Renamed locals do not count — that is what an L1 match already means, and it is extractable. The penalty is graded by the share of field names that drift, and applies to a pool three times the section's size before the slice is taken, because the signal needs token streams the ranker cannot afford across eighteen thousand candidates.

A fourth names **what differs between the copies**:

- **`varies across copies:`** `loincCode` (18), `loincDisplay` (19), `unit` (13), `unitCode` (13)

Reporting the sameness without the variation is what made a real finding read as "19 similar classes" when it was "19 rows of a config table that got compiled into classes" — and the second phrasing hands you the abstraction: a base class with four static fields. An agent asked to act on that finding spent most of its investigation rebuilding this list by hand. Only **literal values** are named: an identifier that differs is what an L1 match already means, and reporting each renamed local under whatever identifier precedes it buries the constants that matter under a dozen `x`, `y`, `sqrt`. The number is distinct values, and it is worth reading — the line above comes from a 19-copy cluster with 18 distinct LOINC codes, because two of the classes declare the same one. That is a live query-correctness bug with nothing to do with duplication, and the agent that found it had to extract the constants itself to see it.

A line also appears when the same shape occurs somewhere it is **not** a copy of this finding:

- **`same shape in other surroundings:`** `apps/web/vitest.setup.tsx:36`, … and 19 more files

This is the report's cheapest pointer at code that may already *be* the extraction, and it costs nothing to compute — it is what subsumption was already throwing away. When a smaller cluster collapses into a larger one, the occurrences of the smaller that do not sit inside the larger are exactly "this fragment, nested differently", and that is where a deduplicated version tends to live. On a real application, 115 copies of a `matchMedia` stub read as "extract a helper into 115 files" until you know the identical block already sits in the project's configured Vitest setup file behind one extra guard — at which point all 115 are dead code and the work is to delete them. An agent given the finding without this line planned the wrong refactor. Locations are ordered **shallowest path first**, because a shared thing lives higher in the tree than its copies do; alphabetical order buried that setup file under twenty test files nested six directories deeper.

A third line appears when two printed findings are **near-variants of one shape**:

- **`see also THK-DUP-…:`** `81% the same shape, 5 more copies`

L1 equality is exact once identifiers are renamed, so a template and a copy of it with one field inserted become two separate findings with nothing connecting them. On a real report that was 19 duplicated classes and 5 more that sat two lines from the same template — acting on the report alone leaves the five behind and costs a second visit. Similarity is shingle Jaccard over the L1 token stream, computed only among the findings actually printed, and the threshold was measured rather than guessed: across 758 non-overlapping pairs the genuine template-and-variant pair scored **0.813**, the next pair **0.462**, and everything else below 0.31, so the bar sits in the empty band between.

The pairs it must *not* link are fragments and their own ancestors, which PRD §5.4 flags and which the same measurement confirmed — the two most similar pairs of all scored 1.000 and 0.921 and both were a node beside the node containing it. Overlapping occurrences are excluded outright.

All three came from handing a report to agents that had never seen this tool and asking whether its top finding was actionable. Three of them, independently, named the same gap — the report said "here are 19 identical things" and nothing about the code around them, and the surrounding facts were what decided feasibility in every case.

Size is the point of those two numbers. Three duplicated lines are not worth a refactor and thirty are, and a reader cannot tell which they are looking at from an AST node count: 17 nodes is four lines in one finding and eleven in the next.

`findings 3 of 3 shown` is load-bearing. Truncation is never silent, and "38" and "38 of 495" mean very different things to a harness deciding whether it is finished.

When findings are held back, an **Omitted** section says what is in them: a count per category, and a histogram of the duplication candidates by recoverable lines. A bare count does not survive contact with a real repository — one run reported `18768 further findings omitted`, which argues equally well for a codebase drowning in cycles, for one tangle restated thousands of times, and for thresholds that admit mostly noise. The breakdown settled it in two lines: exactly **2** of the 18,808 were cycles, and **62%** of the duplication recovers fewer than ten lines. The histogram covers every candidate, not only the withheld ones, because the question is what kind of pile the printed findings came off.

### Two duplication sections

Duplication whose copies are mostly test files goes in a **`## Duplication in tests`** section of its own, with its own much smaller cap, below the production findings and below the module tangle.

This is a split rather than a weight because no weight worked. Test scaffolding took **10 of the top 40** slots on a real application — 231 copies of `{ info: vi.fn(), warn: vi.fn() }`, 124 of `afterEach(() => vi.restoreAllMocks())` — and the ranker was right that they were large: `recoverableLines` is `(copies − 1) × (linesPerCopy − 1)`, so a 6-line shape repeated 231 times genuinely does dominate a 30-line clone repeated twice. Sweeping the test down-weight from 0.4 to 0 moved the count from 10 to 0 continuously, with no natural break anywhere on the curve — every threshold was an arbitrary point on a smooth tradeoff, and the ones low enough to clear the top 40 also buried real cross-test duplication.

Separating the sections makes the question moot: the two kinds of work no longer compete for a slot, and neither has to be scored against the other. On that application the production section's lead finding became a **19×-duplicated 124-line class (2,212 recoverable lines)** that mock setup had been sitting on top of. A tie counts as test — a cluster half of whose copies are test files is as much scaffolding as it is production duplication — and the split is on the measured share, never on the `[mixed]` tag, since a cluster that is 95% test files is tagged `mixed` and is still scaffolding.

Note that raising `--min-lines` does **not** substitute for this. Going from 4 to 10 on that repository dropped 29 of the top 40 findings and 32% of the recoverable lines — deleting 67 copies of a column-selection object and 39 copies of a shared static method along with the noise — while the test-scaffolding count in the top 40 went only from 10 to 9.

That whole report is pinned byte for byte in `tests/golden/sample-report.md`. CI additionally renders it on Linux and on macOS under a locale whose collation disagrees with code-unit order, and fails if the two machines disagree by a single byte.

## What the metrics mean

**`analyzed`** — how many of the TypeScript files on disk under the project root ended up in the program, and therefore in everything below it. A `tsconfig.json` decides this, and it can decide it very differently from what you expect: one real monorepo's root config excluded `apps` and `packages`, so the default run built its program from **176 of 6,286 files** and reported zero dependency cycles and a propagation cost of 0.05. Both were artifacts of the missing 97%. When the program misses part of the tree, thicket says so above the findings and names the `--config` that closes each gap:

```
⚠ 6110 source files are outside this program. Every number above is drawn from the 2.8% that is inside it.
    apps/web  5262 files  → --config apps/web/tsconfig.json
    apps/mobile  451 files  → --config apps/mobile/tsconfig.json
```

The denominator counts hand-written TypeScript only — no `.d.ts`, no generated directories, and nothing under a dot-directory, because an agent worktree in `.claude/` is a second copy of the whole repository and would halve every coverage figure in the report.

**`duplicated mass`** — Σ *nodes × (copies − 1)* over the reported clusters: roughly "how many AST nodes a perfect deduplication would delete". Clusters **overlap and nest** — a `Block` sits inside the `FunctionDeclaration` containing it, and both are reported — so the same source is charged more than once. It is **not a fraction of anything**, and it is not comparable between two different codebases. It is a trend number: watch it fall across iterations of one loop.

**`duplicated coverage`** — the fraction of source bytes covered by at least one *redundant* occurrence. Within each cluster the first occurrence in sorted order is the original a refactor would keep; the rest are redundant, and their byte ranges are unioned across every cluster, so overlapping and nested findings contribute their shared bytes once. This is a genuine fraction in [0, 1] and it is the number that answers "how much of this codebase is redundant".

**`propagation cost`** — the density of the module dependency graph's transitive closure: of all *n²* ordered module pairs, the share where the first transitively depends on the second. It is the "change one thing, how much can be affected" number. A module inside a cycle reaches itself, which is why cycles push it up.

**`dependency cycles` / `largest SCC`** — strongly connected components of the module graph with more than one member, via Tarjan. Each is reported with a **suggested cut**: not "there is a cycle" but "removing this edge breaks it", verified by re-running Tarjan on the graph without that edge. When no single edge suffices, the report says so rather than guessing.

Before any cut, the report looks for edges that are **routing rather than dependency**. An import that resolves through a re-export is a dependency on the *origin*, not on the file it names — so if nearly everything crossing an edge is forwarded from outside the module being depended on, the edge can be **dissolved**: repoint the specifier at the origin and it disappears. Nothing changes, because a re-export is the same binding.

That is a different kind of act from a cut, and strictly cheaper: a cut is a design decision (invert a dependency, move code, agree a layering), a dissolve is a find-and-replace. So dissolves are listed first, and a cut is only suggested for whatever survives them. On a real 12-module tangle this found five edges — `lib → app` (72 of 81 imports), `actions → app` (all 45), `data → app`, `models → app` and one more — every one of them passing through a single file that re-exports `lib/errors.ts`. An agent that investigated that tangle by hand called those five lines "the entire actionable content of this finding".

Deliberately **not** a rule about barrel files. A package's own entry point is structurally identical — 100% forwarded — and dissolving it would reach past a boundary that exists on purpose. What separates the two is whether what the file forwards lives in *another module*, which is a fact about the dependency rather than an opinion about file layout. The `passthrough` fixture pins both cases, and removing either condition fails a test.

No cut is proposed for a tangle **no file-level cycle underlies**. An SCC of modules is a claim about directories; if no file in those modules imports its way back to itself across a boundary, severing an edge removes no cycle that exists. A real 7-module tangle was exactly this, and the cut it used to propose removed zero real cycles.

**Type-only edges are never proposed as cuts.** They are erased at compile time, so cutting one changes nothing that runs. They used to be *preferred*, on the reasoning that moving a types file is the cheapest fix — which produced precisely the wrong recommendation on a real 12-module tangle: a two-symbol `types → models` cut that an agent executed in ten minutes and correctly reported as a no-op, because by the report's own definition that edge was never a runtime dependency. The tangle fixture reproduces this: a package attached to a clique by two `import type` edges is the *best available cut by dissolution* and worth nothing.

The cut is chosen by **how much of the tangle it dissolves**, not by what it costs. Cheapest-edge-that-works reliably finds the least interesting cut — on a real 7-module tangle it proposed a one-symbol edge that detached a leaf and left the other six knotted. Cost is only the tie-break among equally dissolving cuts, and it prefers a type-only edge first (erased at compile time, so the fix is usually moving a types file), then fewest files to edit, then fewest symbols.

Every tangle states **whether anything in it is actually circular at file level**. A module SCC is a claim about directories, and directories are a choice this tool made: on a real 7-module tangle across 417 files there were three file cycles, every one inside a single directory and none crossing a boundary the finding drew — so nothing circular executes, there is no module-init hazard, and the "fix" removes zero real cycles. An agent had to write its own Tarjan implementation to learn that, and it reversed its recommendation. The same line on a 12-module tangle in the same repository reads `6 cross these modules (largest 77 files, including …)`, which is the opposite verdict and the reason the line is worth its width. It is the same algorithm one granularity down, over a graph thicket has already built.

Every cut states **what it leaves**: `leaves: 6 of 7 modules still mutually dependent`, or `nothing — this breaks the cycle completely`. Without that line, "suggested cuts (1)" reads as "apply this and the tangle is gone", which for a leaf-detaching cut is false.

A prefix shared by every module in a component is **lifted into the heading** — `SCC of 7 modules under apps/mobile/` — so the chart reads `components -->|148 (34 type)| lib` rather than repeating `apps/mobile/` fourteen times on seven nodes. Whole path segments only, and only when the prefix is at least two deep: `src/` is the source root and tells the reader where they are, while `apps/mobile/` is the one part of every name that distinguishes nothing.

Each tangle is drawn as a **mermaid flowchart** of the whole component — every intra-SCC edge, labelled with the number of import sites crossing it, with the suggested cut as a dotted arrow. A legend above the section says what the number is — import sites, one per symbol per importing file, re-exports included — because it is neither distinct symbols nor files, and an agent that assumed the former mismatched every edge of a 26-edge tangle and concluded the tool was broken.

Edges that are **entirely `import type`** are marked `type` in the chart. Such an edge is erased at compile time: there is no module-init order to get wrong, no bundler cycle, and breaking it usually means relocating a types file rather than inverting a dependency. On a real 12-module tangle the single most interesting edge was 100% type-only while the suggested cut was a value import — reporting the two identically sends a reader after the wrong one. A single value import anywhere across the module pair clears the flag, and a side-effect `import "./x.js"` binds no names yet is emphatically not erasable — which is why the flag is vetoed rather than derived from the counts, since an import binding zero names erases zero and would vanish from `erased === weight`. An edge that is only **mostly** erased says so: `5 (4 type)` means four of its five bindings are `import type` and the whole runtime dependency is one import in one file, which is usually the cheapest cut available. A real 7-module tangle printed that edge as a bare `5` and nothing suggested looking at it. Edge weights are what make the picture actionable: a 12-module tangle in a real application turned out to be held together by a handful of 1–3 symbol edges among links carrying two thousand. Every edge label is **quoted**, because an unquoted mermaid label ends at the first `(`, `[`, `{` or `|` — which is how the `59 (4 type)` form shipped a chart that would not render. The chart is drawn in full or not at all, never truncated — drop arrows from a cycle and what remains can be acyclic, so a partial chart is not a weaker claim but a wrong one. Past 20 modules or 120 edges it is replaced by the member list and a line saying so.

A finding that names more than a dozen files gets its location list **summarized above the list, not instead of it**: `spread across 1 directory: apps/web/models/member/vitals ×19`, or `spread across 66 directories: … and 63 more directories`. One agent handed a 115-file list wanted nine tenths of it replaced by exactly this — whether the finding is one directory's convention or a cross-package problem was the thing it could not see and had to count by hand. Another, holding a 19-file list, called every entry of it "the finding's backbone" and used all of them. Both are right about their own finding, so the list stays and gains a header.

The **excerpt scales with the size of one copy** — 60% of its lines, floor three, ceiling ten. A flat three lines failed on exactly the findings that needed it most: on a real 15-line block the elided lines 4–13 were the only thing separating that cluster from five near-identical siblings, so the excerpt showed the reader the agreement and hid the disagreement. Three lines of a 100-line class is still right, which is why it is a fraction rather than a bigger constant.

**Finding IDs** (`THK-DUP-…`, `THK-CYC-…`) are derived from **content, never position**. Code that merely moves — reformatted, shifted down by an added import, reordered within its file — keeps its ID, so `thicket diff` reports what was actually resolved rather than what was merely touched. This is the loop's backbone and it has an end-to-end test that moves real code and asserts the IDs survive.

## What it looks for

**Duplication** — every AST node above a size threshold becomes a fragment, so granularities nest naturally: a function is a fragment, the loop inside it is a fragment, the conditional inside that is a fragment. Fragments are fingerprinted at two normalization levels — **L0** exact, and **L1** α-renamed so that renamed variables still match — and clustered by union-find over identical hashes.

**Module tangle** — imports are resolved through the type checker, files are grouped into modules at an adaptively chosen granularity, and the resulting graph is analyzed for cycles and propagation cost.

The interesting result is the **join** between the two: *modules A, B and C form a cycle and share 4 duplicated clusters — extract the shared logic into a leaf module and the cycle dissolves as a side effect.* Neither analysis surfaces that alone.

## The design constraint that shapes everything

A 48-file repository produces roughly **495 duplication candidates**. A report budget realistically holds 20–50 findings.

We are discarding candidates by two orders of magnitude, which means an extra detection technique only adds to a pile that is already being truncated. So:

> **Rank well, then detect more — never the reverse.**

That one conclusion cut embeddings from v1, removed every native dependency, and makes the ranking function the most important code in the project.

## What thicket deliberately does not do

- **It does not judge.** No thresholds, no grades, no pass/fail, no exit code that means "too complex". It reports candidates and metrics; something else decides what is worth fixing.
- **It does not edit.** No codemods, no autofix, no `--write`.
- **It does not open PRs**, post review comments, or touch your VCS in any way.
- **It does not report progress for you.** `diff` prints what changed between two reports. Whether that constitutes enough progress to stop is the harness's call.

## Known limits

- **Near-miss duplication is not in v1.** Only exact (L0) and α-renamed (L1) matches are found. Two functions that differ by one added statement are two separate fragments to thicket. The MinHash/LSH work for near-miss detection exists in `prototypes/` and is not wired up, because ranking, not recall, is the binding constraint.
- **The simplification checks are not in v1** — parameters that take the same constant at every call site, statically-true conditions, exports nobody imports. The type checker knows all three; nothing consumes that yet. There is no `THK-INV-…` finding in a v1 report.
- **The ranker cannot tell a data table from a code block.** An object literal repeated 15 times and a function body repeated 15 times look the same to it: same node count, same copy count, same score. Intra-file repetition is down-weighted and per-file copy counts are capped, which stops a config literal from taking the top of the report, but a few data tables still survive into the lower half. Treating them as refactoring candidates is the reader's mistake to avoid; thicket cannot yet make it for you.
- **Duplication is reported at every granularity that matches.** A cluster and a strictly smaller cluster with the *same* occurrence count are collapsed to the larger one, but an L0 pair nested inside an L1 triple is two findings, as in the example report above. They are genuinely different facts; they still cost two report slots.
- **A real tsconfig is required.** Import resolution runs through the type checker, so there is no "point it at a directory" mode. Declaration files (`.d.ts`) and `node_modules` are never analyzed.

## Design notes

- [`docs/PRD.md`](docs/PRD.md) — the technical PRD, and the rationale for essentially every decision above. Each is backed by measurement against real codebases, and several measurements overturned the starting premises (Go was the original implementation language; embeddings were the original duplication mechanism).
- [`AGENTS.md`](AGENTS.md) — the non-negotiables for anyone, human or otherwise, changing this code. Determinism is a correctness property here, not a nicety.
- [`prototypes/`](prototypes/) — the throwaway scripts that produced those measurements, kept because each one implements an algorithm the real code needs.

## Stack

TypeScript on Node ≥24, with **zero native dependencies** — `node:sqlite` for the content-addressed cache, and `typescript@next` for the frontend. TypeScript 7.1 exposes a real programmatic API (`typescript/unstable/sync`) backed by the Go compiler, which is the only way to get genuine type information rather than approximate syntax.

## License

MIT
