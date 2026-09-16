# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## What this is

`thicket` is a CLI that analyzes a TypeScript codebase and emits a deterministic plaintext complexity report for an LLM to consume inside a refactoring loop. It reports **candidates**; something else does the judging and the editing.

**Read [`docs/PRD.md`](docs/PRD.md) before making design decisions.** Nearly every choice in it is backed by a measurement, and several of those measurements overturned the obvious answer. If you find yourself about to argue for Go, tree-sitter, or embeddings, the PRD already covers why each was rejected.

Work is tracked in [`docs/plans/2026-08-09-thicket-v1.md`](docs/plans/2026-08-09-thicket-v1.md).

## Layout

```
src/extract/     TS API adapter, fragment extraction, import resolution
src/fingerprint/ normalization ladder (L0/L1), hashing, clustering
src/graph/       module grouping, Tarjan SCC, propagation cost
src/cache/       node:sqlite content-addressed store
src/report/      ranking, budget truncation, Markdown + JSON emission
tests/fixtures/  small TypeScript projects with known-correct answers
prototypes/      research scripts (NOT the implementation — see prototypes/README.md)
```

## Commands

```bash
bun install
bun run thicket --config <tsconfig>   # runs src/cli.ts live; no build step
bun install --frozen-lockfile --os='*' --cpu='*'   # every platform's tsgo
bun run build          # compile a binary for THIS platform into dist-bin/
bun run build:all      # ...and for all four; one host builds the whole matrix
bun run build:npm      # stage the npm packages (needs build:all first)
bun run build:formula  # emit the Homebrew formula from dist-bin/checksums.txt
bun run typecheck      # tsc -p tsconfig.test.json -- the ONLY thing that reads test-file types
bun run test           # vitest run
bun run test:watch
bunx vitest run tests/path/to/one.test.ts   # single file
```

Bun ≥1.4 is required. The cache uses `node:sqlite`, which Bun implements; the
bundled JS fallback shipped in the npm package still runs under Node ≥24.

## Non-negotiables

### 1. Determinism is a correctness property

The report must be a pure function of `(source content, config, thicket version)`. Two runs over the same tree must produce byte-identical output, because the whole point is diffing reports across loop iterations.

- Sort every collection before emitting; break ties explicitly (`score desc, id asc`).
- **Never use `localeCompare`.** Sort strings with `compareStrings` from `src/order.ts`. `localeCompare` depends on the host's ICU data and `LANG`/`LC_ALL`, and it disagrees with code-unit order on inputs we handle constantly — under `en-US`, `"src/Util.ts"` sorts *after* `"src/alpha.ts"` because collation folds case. Any repo with a capitalized filename hits this on the first sort, and two machines then emit differently-ordered reports from identical source.
- **Ordering data must be adversarial, or the assertion is decorative.** A sort is pinned only by input that can *fail* it, and that needs two properties: a name whose **code-unit order differs from collation order** (`Util.ts` before `alpha.ts`; `-` 0x2D, `.` 0x2E and `_` 0x5F straddling the letters), and a path whose **sorted position differs from any plausible insertion order** (`a/c.ts` between `a.min.ts` and `a_c.ts`, so no walk that finishes one directory before starting another emits the sorted list by luck). Four sorts reached review with data that had neither, and swapping `compareStrings` for `localeCompare` left all of them green. `ORDERING_PROBE` in `tests/helpers.ts` carries both — reference it rather than rederiving one; where the data has to be domain-shaped (tsconfig basenames, directory names), say which property it carries and point back at the probe. CI greps `src/` for the banned call, which is a floor, not a substitute: it cannot see a sort that is merely unpinned.
- Never rely on `Map`/`Set` iteration order reflecting anything meaningful.
- Fixed hash seeds. No `Math.random()`, no timestamps, no absolute paths, no wall-clock durations anywhere in the diffable body.
- Paths are POSIX-normalized and repo-relative.
- Clustering is union-find over a threshold graph — never k-means or anything else with a random start.

### 2. All TypeScript API contact goes through the adapter

`typescript/unstable/*` is a dev-build API on a path literally named `unstable`. Everything downstream consumes the `SourceModel` interface (PRD §4.1) so that when 7.1 stabilizes, one file changes. The `typescript` dependency is **pinned exactly**, not caret-ranged.

The seal earned its keep when the runtime moved to Bun. `typescript/unstable/sync` cannot run there at all: it spawns the `tsgo` server and does blocking RPC over `child.stdout._handle.fd`, a Node internal Bun does not expose, and its client refuses the alternative (`"Socket connections are not yet supported in the sync client"`). The fix was `typescript/unstable/async`, which talks over the child's *streams* — six awaits in `ts-adapter.ts` and nothing else in the repository changed. The sync API is auto-generated from the async one, so the two are the same surface with `Promise` wrappers, and AST materialization makes no client calls at all: a source file arrives as one payload and the tree materializes locally, which is why `walk`, `forEachChildSafe` and fragment extraction stayed synchronous.

Two consequences worth keeping:

- **`resolveImport` must stay synchronous.** It is called from inside AST walks, so making it `async` is the one change that *would* go viral. Every module specifier is instead resolved up front, one batched `getSymbolAtLocation(nodes[])` per file — which is also strictly fewer round trips than the sync API made. A specifier that arrives at `resolveImport` unresolved is a bug, not a missing module, and it throws rather than answering `undefined`.
- **Declare the batch overload first.** `unknown` accepts an array, so with the single-node signature ahead of it every batch call silently resolves to the scalar overload and the result type is a lie.

### 3. Four API hazards, each of which fails silently

These produced plausible-but-wrong output rather than errors, which is what makes them dangerous. Each is sealed in the adapter and each has a regression test. Do not remove the guards.

| Hazard | What it looks like when you get it wrong |
|---|---|
| `forEachChild` aborts if the callback returns anything truthy | Only the first statement of each file is visited; counts look merely "low" |
| `Path` is case-canonicalized; `getSourceFileNames()` is not | **Zero** import edges resolve, which reads as "this repo has no imports" |
| A file in N tsconfig projects is visited N times | Shared packages appear as phantom identical clones |
| Directory depth collapses in monorepos | Every path starts `packages/`, so depth-1 grouping yields one module |
| `SyntaxKind[k]` returns range-marker aliases | `NumericLiteral` reverse-maps to `"FirstLiteralToken"`, `VariableStatement` to `"FirstStatement"` — so matching on kind *names* silently misses cases. Match by enum value. |
| A foreign project's checker throws on an unowned node | Not `undefined` — a blanket `catch` turns it into "this repo has no imports" |
| The API holds an open connection to its `tsgo` child | Nothing — the report is printed, correct and complete, and then the process never exits. `run.ts` closes it in a `finally`; `tests/process-exit.test.ts` is the only test that spawns a real subprocess, because an in-process `main()` call cannot see this |
| A side-effect `import "./x.js"` binds no names | So "every binding on this edge is erased" is *vacuously true* for it, and a live module-init dependency is reported as type-only — telling a reader a cycle breaks by moving a types file. Erasability is vetoed per import, never derived from `erased === weight`. |

A fifth, in fuzzy matching: a fragment and its own ancestor overlap at ~0.99 similarity and are **not** duplication. Exact hashing is immune; MinHash is not.

### 4. Ranking is the product

A 48-file repo yields ~495 duplication candidates against a report budget of 20–50. Recall is not the constraint — selection is. Before adding a new detector, ask whether the ranker is already discarding good candidates. The PRD's re-entry criterion for embeddings applies to any new detection technique.

Two corollaries, both learned the expensive way:

- **`recoverableLines` is `(copies − 1) × (linesPerCopy − 1)`, so per-copy size is only half the value.** A 6-line shape repeated 231 times outranks a 30-line clone repeated twice, and it is *right* to. Filtering on lines-per-copy therefore does not remove noise — on a real application, raising `--min-lines` from 4 to 10 deleted 29 of the top 40 findings and 32% of the recoverable lines while barely denting the noise it was aimed at.
- **A finding is not actionable without its surroundings.** Three agents handed a report and asked whether its top finding was actionable independently named the same gap: "here are 19 identical things" and nothing about the code around them. What decided feasibility every time was context the report already had — the base class every copy imports, how many files reach into the cluster, and whether another printed finding is the same shape with a field added. Cheap lookups, all of them.
- **Rank on whether consolidating buys anything, not on how much is duplicated.** Two L1 clusters can be indistinguishable by size and opposite in worth: 19 classes differing only in the *values* of `loincCode`/`unit` are one concept parameterized (a base class absorbs them), while 193 three-field projections differing in every *key* are 89 different objects sharing a syntax template, whose only abstraction is a generic `pick` nothing can ever benefit from. The second ranked #2 in the report and two agents independently refused to do it. The discriminator is field-name drift; renamed locals do not count, because that is what an L1 match already means.
- **Prefer dissolving a dependency to cutting it.** An import resolving through a re-export is a dependency on the origin, not on the file it names, so an edge that is mostly forwarded can be repointed at the origin and disappears with no semantic change. That is a find-and-replace where a cut is a design decision, so dissolves are offered first and a cut only covers what survives. The rule is keyed on the origin living in *another module* — a package's own entry point is 100% forwarded too, and dissolving it would reach past a boundary that exists on purpose. Keeping the test on that distinction is what stops it becoming an opinion about barrel files.
- **A proposed fix that changes nothing at all is worse than no proposal — but check which property actually makes it worthless.** A cut for an SCC no file-level cycle underlies removes no cycle that exists, and is refused outright. Type-only edges were once *preferred* as cuts on the reasoning that moving a types file is cheap, produced a two-symbol cut an agent executed in ten minutes and correctly called a no-op, and were then banned. That ban was aimed at the wrong property: what made that cut worthless was that it shaved one module off a tangle and left the rest, which `MAX_RESIDUAL_SHARE` rejects whether the edge is erased or not. Type-only cuts are now *demoted*, not excluded — a runtime edge wins any tie, because only a runtime cycle can fail at module-init time, but a type-only cut that breaks a conceptual cycle completely is proposed and labelled. A cycle in the type system is real complexity: a reader cannot understand either module without the other.
- **Refusing a bad fix is only half the rule; the fallback has to be allowed to refuse too.** Once type-only edges and non-circular SCCs were rejected as cuts, the chooser rejected the pointless candidate and then reached for the next-cheapest one instead of concluding it had nothing to say. On a real 9-module tangle every available cut left 8 of the 9 mutually dependent, and the report printed one directly above the line admitting it changed almost nothing. A cut must now leave at most two thirds of the tangle standing, or eliminate the cycle outright. And the refusal has to carry the number it rejected: "nothing you remove helps" and "the best available removes 1 of 9" are different answers, the search computes both, and an agent handed only the first recomputed the second by hand before it would believe the tangle was irreducible. Same rule for the legend — the section stopped promising a dotted arrow on charts that no longer draw one.

- **A weight is only as wide as the node kinds it knows about, and a blind spot looks like agreement.** `fieldNameDrift` decides whether copies are one concept parameterized or several sharing a template. `NAME_HOLDERS` listed seven kinds with no JSX among them. A JSX attribute name is an `Identifier` leaf, so L1 α-renames it, and `<p role= className=>` matches `<Badge variant= className=>`. On a 5540-file application all sixteen JSX findings scored `total: 0` and kept full weight. Ten of them took the top of the report. The number said "no drift" where it meant "nothing to measure". Adding `JsxAttribute` removed four findings and moved nothing else. The tag name is excluded deliberately. Four dialog-header primitives around one Title-plus-Description shape are parallel components. `<div>` beside `<TabsList>` and `<SelectContent>` is a syntax template. Both are four or five distinct tag names, and three normalizations failed to separate them.
- **Correct reuse has the same AST as copy-paste, and only arithmetic tells them apart.** A finding read "43 copies · ~208 lines recoverable" over 43 route handlers. Each one opens with a single call to a shared helper. A reader who checks that finding and finds it already done discounts the other 58. The test is not a judgement: the shortest thing that can replace a call is a call. It holds only at L0, where every copy is the same text. It never holds for a fragment carrying a body, a literal, a template, or a second call. Twenty identical `useEffect(() => { … })` blocks are a hook waiting to be written, and the body is what makes them extractable. It took 2 of 165 candidates.
- **Some duplication is a framework's API, and the filename says so.** Storybook CSF wants one `const meta` per story file. Two such findings held production slots on a real report. A cluster is a file-role convention when every file shares a dotted role suffix. It must also carry at most one more occurrence than it has files. That second half is the one that is easy to leave out. A Drizzle `updatedAt` column sat in 39 `.schema.ts` files, one role suffix and 100% of them, but 56 times with seven in one file. That shape is per table, and a shared column helper absorbs every copy. Never for test-majority clusters. `.test.ts` passes every condition, and one `vi.mock` block per test file is scaffolding a setup file can absorb. Tests are held out of production slots by a **section**. Stacking a weight on top re-penalizes them, and reorders the test section on a rule that does not apply there.
- **Two findings over the same files are one job, and nothing in the report was saying so.** Ten of 59 findings described one structure. Seven sibling files repeated eight shapes between them, and two findings covered the identical seven files. The reader rebuilt the grouping by hand. `subsume` cannot see it, because it drops a fragment covered at the same location. These are different shapes side by side. Keyed on set **containment**, not similarity. File-set Jaccard over those 59 findings decayed smoothly from 1.0 with no empty band, so every threshold was arbitrary. Containment needs no number and says something actionable. Visiting the covering finding's files reaches every copy of the covered one. 23 of the 174 overlapping pairs nest.
- **Report the variation, not just the sameness.** "19 classes are identical" and "19 rows of a config table, parameterized by `loincCode`, `unit`, `junctionKey`" are the same finding; only the second hands you the abstraction. Every agent asked to act on the first rebuilt the second by hand — and one of them found a live bug doing it (two of the nineteen declared the same LOINC code, which the report now shows as *19 copies, 18 distinct values*).
- **A pointer must resolve to the thing, not to a signpost.** `every copy imports` named a nine-line `export * from` shim and stopped; the 1012-line base class the refactor turned on was one hop further. `directly imported by` said 5 and meant 5-plus-17-behind-a-barrel. Both were *technically true* and both sent an agent to the wrong place — one concluded the number was a bug.
- **A cross-reference must be computed at the level the reader will read it at.** `contains` deliberately lets an L0 parent subsume an L1 child — the coarser match swallows the finer one, which is correct for deduplication. `alsoAt` inherited those children, so a finding labelled `L0` pointed at locations that matched it only at L1. On a real report an L0 cluster of `{ info: vi.fn(), warn: vi.fn(), … }` named two Zod schemas, `z.object({ questionId: z.string(), … })` — they share nothing but "four keys whose values are calls", a template every four-field object in TypeScript matches. The reader has no way to see the level changed, so the field reads as evidence; an agent spent three tool calls disproving a tool bug before it could trust the rest of the block. Subsume across levels, cross-reference within one.

- **A field that is structurally constant for a category is noise dressed as evidence.** Nothing imports a test file, so `directly imported by: nothing outside the cluster` held for all 115 members of a test finding and distinguished none of them.
- **The runtime graph and the type graph are two different objects, and a reader cannot derive one from the other.** `import type` is erased, so the same component was 9 modules with all edges and 7 once type-only edges were dropped — a figure an agent recomputed by hand before it would trust the finding. It cannot be read off the chart: an edge printed `1352 (241 type)` still exists at runtime, so partial per-edge counts do not compose into an erased graph. Both numbers are reported, and both matter. Erasing types to find "the real answer" is the wrong instinct — a runtime cycle can fail at module-init time, a type cycle is a knot a reader must hold in their head, and untangling the second into shared types is exactly the complexity reduction this tool exists to find. The second number is printed only when erasure changes it, so its presence always means something.

- **Directory DEPTH is not a property of a codebase, and nothing should treat it as one.** PRD §2.6 picks one depth N and makes every directory at that depth a module, erasing all structure below it. Measured on 48- and 140-file samples, it concluded that "file granularity finds zero cycles… grouping-induced cycles ARE the tangle signal". That does not survive scale. On a 3298-file application, depth 4 made `src/lib` (1586 files) and `src/stores` (4 files) peers while `src/lib/services` (328 files) was not a module at all — and file granularity found **13** cycles, not zero, including a 22-file ring inside `src/lib` with 21 files circular at runtime. A tangle seven directories down is the same tangle as one two directories down. `--granularity dir` makes every directory a module at its own depth, no collapsing; the common prefix is still stripped, because a monorepo whose every module is named `packages/…` is a different failure.

- **The cheapest new signal is usually one you are already computing and discarding.** The top request across three agents — "is the deduplicated version already somewhere?" — was answered by keeping what `subsume` throws away. Whether a module tangle is a real cycle or an artifact of directory grouping was the same Tarjan run one granularity down. Neither needed a new technique; check for this before reaching for one.
- **Exclusion rules must match on both sides of the coverage figure, and a file's own banner is the only portable way to spot generated code.** A sample monorepo analyzed 6626 files, of which **3411 self-declared as machine-generated** — 3407 re-export shims named `Icon3d.ts` and one 5016-line route table. `GENERATED_DIR_SEGMENTS` caught none of them: it matches directory segments only. A filename pattern (`*.gen.ts`) is the obvious fix and reaches 1 of the 3408, because naming conventions vary and *the generator's banner does not* — `@generated`, "auto-generated" and "Code generated by …" are cross-ecosystem. So the banner sniff is the general mechanism and `--exclude` is the escape hatch; a hardcoded name list would be tuning to one repo. Two consequences justified the work on their own: the sole cut the tangle section proposed was 191 symbols inside the generated route table, a file stamped "you should NOT make any changes," and that one file glued a **701-file** cycle together that was really **14**. And when the sniff first landed, `scanSourceFiles` still counted those 3408 on disk — so the report blamed the package they lived in for being outside the program and printed the `--config` that was already passed. The rules have to run on the denominator too, or the fix invents a gap no flag can close.

- **A number computed from a sample must not be printable as a total.** `varies across copies` counts distinct values among the first `MAX_COPIES_COMPARED` copies. On a real finding of 103 copies it printed `description (20)`, which by this file's own doctrine reads *a small enumerable parameter set — build a table*; the truth was 101 distinct descriptions, which says the opposite, that it must stay a free parameter. An agent designed the wrong abstraction on it. Saturation is now rendered `≥20` — but only when copies were actually left out, because comparing all four copies of a four-copy cluster and finding four values is exact, and `≥4` would understate what we know. The comment justifying the bare number said the sample was as good as the whole; that was true of *which* constants vary and false of *how many values* they take.

- **Type duplication is complexity too, and volume-based ranking can never surface it.** `recoverableLines` is `(copies − 1) × (linesPerCopy − 1)`, so four copies of a five-line interface score 13 against a duplicated function's 43. A type declaration is small *by nature* even when what repeats is an entire concept, so it loses every contest decided on volume — not sometimes, structurally. Measured on a real application: 33 groups of structurally identical declarations (`SimpleLogger`/`OpsLogger`/`SlackLogger` among them, and a 31-line `WebhookConversationData` declared byte-identically in two files), and the report surfaced **zero** of them at any depth setting. `## Duplicated types` is its own section with its own cap, which took that repo from 0 shown to 10 of 173 candidates. The general lesson is the one above it — incomparable kinds of work get sections, not weights — but the specific trap is assuming "reduce complexity" means "reduce code". Three interfaces that should be one are complexity, and consolidating them removes a concept rather than a line count.

- **When a weight has to arbitrate between two incomparable kinds of work, split the sections instead.** Test scaffolding held 10 of the top 40 slots; sweeping the test weight from 0.4 to 0 moved that count smoothly to 0 with no natural break, meaning every threshold was arbitrary. `## Duplication in tests` is a separate section with its own cap, so nothing has to be scored against it.

### 4b. Every opinion gets its own off switch

The tool is opinionated on purpose — it decides from a prose banner that a
machine wrote a file, it refuses cuts it judges pointless, it excludes
directories by name. Opinions are what make the report short enough to act on.
But each one is a guess about someone else's codebase, so each gets a flag that
turns off **only** that guess: `--no-banner-scan` must not drag the directory
rule back on with it, and `--include-generated` must not cancel `--exclude`,
which is an instruction rather than a guess. Anything that changes the finding
set also joins the config hash, or a warm cache serves an answer from settings
the reader cannot see.

### 5. The cache may never change the answer

`.thicket/cache.db` stores whole fragments — position, size, kind, **and both
normalization hashes on one row** — because clustering decides whether an L1
finding is genuinely coarser than L0 by asking which L0 shape each member had.
Split the levels into separate rows and that question becomes unanswerable, so
the warm path invents findings the cold path suppresses (114 of them on a
146-file test repository). Two rules follow:

- Anything added to the cache must be verified by `tests/cache-pipeline.test.ts`,
  which asserts the cold and warm **cluster lists** are deeply equal. Assert on
  clusters, not on the Markdown: the report is truncated to the top findings and
  will happily hide a cache that lost 6% of its fragments.
- The cache is an optimization, never a dependency. A corrupt, foreign-version
  or unwritable database degrades to "analyze everything" — it must never be the
  reason a report cannot be produced.

### 6. Never reference specific private codebases

Analysis and benchmarking happen against real private repositories. **Do not name them, path them, or quote their source in code, comments, docs, commit messages, or test fixtures.** Refer to "a sample project," "test repositories," or the anonymized "Sample A"/"Sample B" used in the PRD. Fixtures live in `tests/fixtures/` and are written by hand.

Anonymizing is not enough on its own. A figure from a private repository has to
**earn its place by justifying a decision**: "raising `--min-lines` from 4 to 10
dropped 29 of the top 40 findings" is why a threshold is where it is, and it
stays. A figure that only decorates an argument the reader already accepts does
not: "one real application here is 5,798 files and 1.5M lines" was there to make
"reading a repo costs tokens" sound stronger, and a reader cannot check it. Cut
those. A reviewer reads them as showing off with someone else's codebase.

### 6b. Write in Technical Standard English

This applies to everything: the README, the site, `docs/`, code comments, commit
messages, PR descriptions, CLI output, and what you say to the person you are
working with. One voice, everywhere.

The rules:

- **One idea per sentence.** Twenty words is the ceiling. Fifteen is better.
- **Subject, verb, object, in that order.** Active voice. Present tense.
- **No chained clauses.** No em dash carrying the meaning, no semicolon joining
  two balanced halves, no "not X but Y", no trailing "instead of Z", no
  appositive stacked on an appositive. If a sentence needs a dash to hold
  together, it is two sentences.
- **Plain words.** Write "thicket does the searching", not "a deterministic
  pass finds". Write "the agent decides", not "the model spends its judgement".
  Say the thing. Do not narrate it.
- **Name the actor.** "thicket follows a re-export shim" beats "a re-export shim
  is followed through".
- **One term per concept, reused.** A finding is a finding on every page. Do
  not reach for a synonym to vary the prose.
- **Put the point first.** State the fact, then the evidence for it. Do not
  build to it.
- **No figures of speech, and no closing flourish.** A cost is a cost, not a
  bill that arrives. A tangle is a tangle, not a knot the reader holds in their
  head. This is the tic that survives every other rule, because it shows up in
  the last sentence of a paragraph that was otherwise fine, where it reads as
  style rather than as padding. Two of them got past a rewrite whose whole point
  was to remove them, and the person reading the page caught both.

What this does NOT license:

- **Deleting the evidence.** Every measurement in this repository is here
  because someone got the answer wrong without it. Rewrite the sentence, keep
  the number. When a section is dense with facts, break it into subheadings
  rather than cutting it down.
- **Dropping precision.** "α-renamed" and "strongly connected component" are
  the right words and there is no simpler one. Plain means plainly built, not
  vague.

The failure mode this exists to stop is prose that reads as though a model wrote
it. A real reader hit a five-clause sentence about symlink resolution, and gave
up on the page before the install command. Measure the result rather than
trusting your ear: a rewritten page should come in around 10 words per sentence
with almost no em dashes. `README.md` went from 19.3 words and 101 em dashes to
13.2 and 6, and the six that remain are quoting the report's own output.

### 7. What ships is a directory, and the binary must be run to be tested

Analysis goes through `typescript/unstable/async`, which spawns a **native tsgo
child process**. That is the fact the whole distribution story is downstream of,
and it cannot be engineered away from this side.

- **`bun build --compile` succeeding proves nothing.** The bundle compiled
  cleanly long before anyone ran it; the binary died on first invocation with
  `ENOENT: no such file or directory, open '/$bunfs/package.json'`. The
  `typescript` package finds tsgo by reading its own package.json relative to
  `import.meta.url`, which inside a bundle is `file:///$bunfs/root/cli` — a
  virtual path with no filesystem under it. Only an *extracted artifact, run
  from a directory with no `node_modules`*, can see this, which is why the
  `package` CI job exists and why it `cd`s out of the checkout first. Inside the
  checkout a stray `node_modules` satisfies the resolution the packaged layout
  is supposed to satisfy alone, and the job goes green while the artifact is
  broken for everyone.
  **And one reference report cannot see it.** Every `new API` is a place that
  fault can reappear: `createAPI` fixed the call site in `openProject`, and the
  workspace probe added a second one, which the packaged binary then failed on
  for every directory run while the `--config` report stayed byte-identical. So
  the job renders *both entry paths* — `--config <tsconfig>` and a bare
  directory — because only the second reaches `sourceFileNames`.
- **tsgo will not start without its `lib.*.d.ts` files beside it.** It does not
  degrade — it panics with `bundled: …/lib.d.ts does not exist; this executable
  may be misplaced`. So the shipping unit is a directory: the binary, `tsgo/tsc`,
  and ~110 declaration files. 24MB and 3.9MB respectively, per platform.
- **Locate it from `process.execPath`, never `import.meta.url`.** The latter is
  virtual inside a bundle. `execPath` also resolves *through* a symlink to the
  real file, which is the only reason a Homebrew `bin/` → `libexec/` symlink
  works at all.
- **Resolution is a fallthrough, not an override.** `$THICKET_TSGO`, then
  `<dirname(execPath)>/tsgo/tsc`, then `undefined` to mean "let `typescript`
  resolve it as it always has". Drop that third step and every developer command
  breaks, along with the determinism job, which runs from source deliberately.
- **The tsgo version joins the config hash.** A different compiler parses and
  resolves differently, and the cache is keyed on that hash — see §5.
- **Let Bun fetch tsgo; do not hand-roll it.** Every platform's compiler is an
  optional dependency of `typescript`, and `bun install --os='*' --cpu='*'`
  installs all of them, verified against the sha512 in `bun.lock`. The build
  copies them out of `node_modules`. A previous version downloaded them from the
  registry itself, which meant a second cache and a second integrity check to
  keep correct -- and reviewers found real bugs in both (a fail-open digest
  check, and a half-extracted cache trusted forever). One host still cross-builds
  the whole matrix in seconds; no macOS or arm runner is needed to BUILD.

## Working style

- **A pinned string is not a syntax guard.** When the mermaid edge label gained a parenthesised count (`59 (4 type)`), the pinned assertions were updated to the new output and the suite stayed green — while the chart stopped parsing, because an unquoted mermaid edge label ends at `(`. A string pin agrees with whatever the code now emits. Where output has to satisfy an external grammar, assert the property that grammar cares about (here: every label is quoted, no label holds a raw `"`), and re-run the real parser when the form changes. Measured against mermaid 11.16.1, a bare edge label breaks on `(`, `)`, `[`, `]`, `{`, `}`, `|` and `"`; a quoted one breaks only on `"`.
- **Never write a control character into source as a literal.** `variation.ts` held an actual NUL as the `join()` separator. It compiles and runs, and it makes git report the file as `Bin 7275 bytes` with no diff, `grep` find nothing in it while exiting 0, and every search-based edit silently miss. It was committed that way and cost a real detour to spot. Write `\u0000`.

- **A test that passes when you delete the feature is worse than no test** — it reports safety that isn't there. This bit us repeatedly: a dedup test whose input the API silently deduped for us, an edge-weight test asserting only `weight > 0`, a loop over a set that was always empty, and a casing guard protected only because this checkout lives under `/Users`. Prefer asserting a **specific expected value** over a property that holds trivially (`> 0`, `length > 0`, a loop over a possibly-empty collection). When you add a guard, delete it once and watch the test fail.
- **A shape restated by hand is a shape that will fall behind, and no restatement fails loudly.** The same mistake showed up at three altitudes. Adding a required `typeDuplication` to `Census` broke nothing at runtime, because vitest transpiles without typechecking — the three test literals that never got the field kept passing, and only `npm run typecheck` ever saw them — a step `npm test` does not cover, so a green local test run proves nothing about it. A helper annotated `(json: { cycles: { modules: string[] }[] }, …)` restated the cycle shape structurally, which erases every *other* field, so `cuts` and `residual` stopped resolving the moment they were added. Worst of the three was the assertion: `duplication + testDuplication + cycles === totalFindings` went on balancing after `typeDuplication` joined the partition, because the fixture it ran against had no type findings — and its `cycles` term was zero there too. A term omitted from a partition check is invisible exactly when it is wrong. Infer the shape rather than restating it (`<C extends { modules: string[] }>`), and check a partition against a fixture where every term is non-zero — `tests/fixtures/census/` exists to be that fixture.
- **Assert on the data structure, not the rendered report.** The report is truncated to the top findings and will happily hide a bug that drops 6% of fragments. Cache and clustering changes must be verified against cluster lists.
- **TDD.** Write the failing test, run it and watch it fail for the right reason, then implement. Several bugs in the prototypes were caught only because an invariant was asserted (e.g. "L1 never produces fewer clusters than L0" — a property that held mathematically and failed in practice, which is how the α-renaming scope bug surfaced).
- **Name a field for what it holds, or do not print it.** The tangle legend said "distinct symbols bound across the edge". It is import *sites* — the same symbol in eight files counts eight times, and re-exports count too. An agent computed distinct names, mismatched every edge of a 26-edge tangle, and concluded the tool was broken before working out the real metric. A wrong name costs more than no name, because it is believed.
- **Commit at each completed task**, and push. Progress should be visible from the commit log alone.
- Conventional commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`, `refactor:`.
- Prefer boring code. This tool runs in a loop; predictability beats cleverness.
