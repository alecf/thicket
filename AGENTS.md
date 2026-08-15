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
npm install
npm run build          # tsc -p tsconfig.json
npm test               # vitest run
npm run test:watch
npx vitest run tests/path/to/one.test.ts   # single file
```

Node ≥24 is required — the cache uses the built-in `node:sqlite`.

## Non-negotiables

### 1. Determinism is a correctness property

The report must be a pure function of `(source content, config, thicket version)`. Two runs over the same tree must produce byte-identical output, because the whole point is diffing reports across loop iterations.

- Sort every collection before emitting; break ties explicitly (`score desc, id asc`).
- **Never use `localeCompare`.** Sort strings with `compareStrings` from `src/order.ts`. `localeCompare` depends on the host's ICU data and `LANG`/`LC_ALL`, and it disagrees with code-unit order on inputs we handle constantly — under `en-US`, `"src/Util.ts"` sorts *after* `"src/alpha.ts"` because collation folds case. Any repo with a capitalized filename hits this on the first sort, and two machines then emit differently-ordered reports from identical source.
- Never rely on `Map`/`Set` iteration order reflecting anything meaningful.
- Fixed hash seeds. No `Math.random()`, no timestamps, no absolute paths, no wall-clock durations anywhere in the diffable body.
- Paths are POSIX-normalized and repo-relative.
- Clustering is union-find over a threshold graph — never k-means or anything else with a random start.

### 2. All TypeScript API contact goes through the adapter

`typescript/unstable/*` is a dev-build API on a path literally named `unstable`. Everything downstream consumes the `SourceModel` interface (PRD §4.1) so that when 7.1 stabilizes, one file changes. The `typescript` dependency is **pinned exactly**, not caret-ranged.

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

- **Report the variation, not just the sameness.** "19 classes are identical" and "19 rows of a config table, parameterized by `loincCode`, `unit`, `junctionKey`" are the same finding; only the second hands you the abstraction. Every agent asked to act on the first rebuilt the second by hand — and one of them found a live bug doing it (two of the nineteen declared the same LOINC code, which the report now shows as *19 copies, 18 distinct values*).
- **A pointer must resolve to the thing, not to a signpost.** `every copy imports` named a nine-line `export * from` shim and stopped; the 1012-line base class the refactor turned on was one hop further. `directly imported by` said 5 and meant 5-plus-17-behind-a-barrel. Both were *technically true* and both sent an agent to the wrong place — one concluded the number was a bug.
- **A cross-reference must be computed at the level the reader will read it at.** `contains` deliberately lets an L0 parent subsume an L1 child — the coarser match swallows the finer one, which is correct for deduplication. `alsoAt` inherited those children, so a finding labelled `L0` pointed at locations that matched it only at L1. On a real report an L0 cluster of `{ info: vi.fn(), warn: vi.fn(), … }` named two Zod schemas, `z.object({ questionId: z.string(), … })` — they share nothing but "four keys whose values are calls", a template every four-field object in TypeScript matches. The reader has no way to see the level changed, so the field reads as evidence; an agent spent three tool calls disproving a tool bug before it could trust the rest of the block. Subsume across levels, cross-reference within one.

- **A field that is structurally constant for a category is noise dressed as evidence.** Nothing imports a test file, so `directly imported by: nothing outside the cluster` held for all 115 members of a test finding and distinguished none of them.
- **The runtime graph and the type graph are two different objects, and a reader cannot derive one from the other.** `import type` is erased, so the same component was 9 modules with all edges and 7 once type-only edges were dropped — a figure an agent recomputed by hand before it would trust the finding. It cannot be read off the chart: an edge printed `1352 (241 type)` still exists at runtime, so partial per-edge counts do not compose into an erased graph. Both numbers are reported, and both matter. Erasing types to find "the real answer" is the wrong instinct — a runtime cycle can fail at module-init time, a type cycle is a knot a reader must hold in their head, and untangling the second into shared types is exactly the complexity reduction this tool exists to find. The second number is printed only when erasure changes it, so its presence always means something.

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

## Working style

- **A pinned string is not a syntax guard.** When the mermaid edge label gained a parenthesised count (`59 (4 type)`), the pinned assertions were updated to the new output and the suite stayed green — while the chart stopped parsing, because an unquoted mermaid edge label ends at `(`. A string pin agrees with whatever the code now emits. Where output has to satisfy an external grammar, assert the property that grammar cares about (here: every label is quoted, no label holds a raw `"`), and re-run the real parser when the form changes. Measured against mermaid 11.16.1, a bare edge label breaks on `(`, `)`, `[`, `]`, `{`, `}`, `|` and `"`; a quoted one breaks only on `"`.
- **Never write a control character into source as a literal.** `variation.ts` held an actual NUL as the `join()` separator. It compiles and runs, and it makes git report the file as `Bin 7275 bytes` with no diff, `grep` find nothing in it while exiting 0, and every search-based edit silently miss. It was committed that way and cost a real detour to spot. Write `\u0000`.

- **A test that passes when you delete the feature is worse than no test** — it reports safety that isn't there. This bit us repeatedly: a dedup test whose input the API silently deduped for us, an edge-weight test asserting only `weight > 0`, a loop over a set that was always empty, and a casing guard protected only because this checkout lives under `/Users`. Prefer asserting a **specific expected value** over a property that holds trivially (`> 0`, `length > 0`, a loop over a possibly-empty collection). When you add a guard, delete it once and watch the test fail.
- **Assert on the data structure, not the rendered report.** The report is truncated to the top findings and will happily hide a bug that drops 6% of fragments. Cache and clustering changes must be verified against cluster lists.
- **TDD.** Write the failing test, run it and watch it fail for the right reason, then implement. Several bugs in the prototypes were caught only because an invariant was asserted (e.g. "L1 never produces fewer clusters than L0" — a property that held mathematically and failed in practice, which is how the α-renaming scope bug surfaced).
- **Name a field for what it holds, or do not print it.** The tangle legend said "distinct symbols bound across the edge". It is import *sites* — the same symbol in eight files counts eight times, and re-exports count too. An agent computed distinct names, mismatched every edge of a 26-edge tangle, and concluded the tool was broken before working out the real metric. A wrong name costs more than no name, because it is believed.
- **Commit at each completed task**, and push. Progress should be visible from the commit log alone.
- Conventional commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`, `refactor:`.
- Prefer boring code. This tool runs in a loop; predictability beats cleverness.
