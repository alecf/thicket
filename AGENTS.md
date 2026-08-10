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
- **Report the variation, not just the sameness.** "19 classes are identical" and "19 rows of a config table, parameterized by `loincCode`, `unit`, `junctionKey`" are the same finding; only the second hands you the abstraction. Every agent asked to act on the first rebuilt the second by hand — and one of them found a live bug doing it (two of the nineteen declared the same LOINC code, which the report now shows as *19 copies, 18 distinct values*).
- **A pointer must resolve to the thing, not to a signpost.** `every copy imports` named a nine-line `export * from` shim and stopped; the 1012-line base class the refactor turned on was one hop further. `directly imported by` said 5 and meant 5-plus-17-behind-a-barrel. Both were *technically true* and both sent an agent to the wrong place — one concluded the number was a bug.
- **A field that is structurally constant for a category is noise dressed as evidence.** Nothing imports a test file, so `directly imported by: nothing outside the cluster` held for all 115 members of a test finding and distinguished none of them.
- **The cheapest new signal is usually one you are already computing and discarding.** The top request across three agents — "is the deduplicated version already somewhere?" — was answered by keeping what `subsume` throws away. Whether a module tangle is a real cycle or an artifact of directory grouping was the same Tarjan run one granularity down. Neither needed a new technique; check for this before reaching for one.
- **When a weight has to arbitrate between two incomparable kinds of work, split the sections instead.** Test scaffolding held 10 of the top 40 slots; sweeping the test weight from 0.4 to 0 moved that count smoothly to 0 with no natural break, meaning every threshold was arbitrary. `## Duplication in tests` is a separate section with its own cap, so nothing has to be scored against it.

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

- **A test that passes when you delete the feature is worse than no test** — it reports safety that isn't there. This bit us repeatedly: a dedup test whose input the API silently deduped for us, an edge-weight test asserting only `weight > 0`, a loop over a set that was always empty, and a casing guard protected only because this checkout lives under `/Users`. Prefer asserting a **specific expected value** over a property that holds trivially (`> 0`, `length > 0`, a loop over a possibly-empty collection). When you add a guard, delete it once and watch the test fail.
- **Assert on the data structure, not the rendered report.** The report is truncated to the top findings and will happily hide a bug that drops 6% of fragments. Cache and clustering changes must be verified against cluster lists.
- **TDD.** Write the failing test, run it and watch it fail for the right reason, then implement. Several bugs in the prototypes were caught only because an invariant was asserted (e.g. "L1 never produces fewer clusters than L0" — a property that held mathematically and failed in practice, which is how the α-renaming scope bug surfaced).
- **Name a field for what it holds, or do not print it.** The tangle legend said "distinct symbols bound across the edge". It is import *sites* — the same symbol in eight files counts eight times, and re-exports count too. An agent computed distinct names, mismatched every edge of a 26-edge tangle, and concluded the tool was broken before working out the real metric. A wrong name costs more than no name, because it is believed.
- **Commit at each completed task**, and push. Progress should be visible from the commit log alone.
- Conventional commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`, `refactor:`.
- Prefer boring code. This tool runs in a loop; predictability beats cleverness.
