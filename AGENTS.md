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

A fifth, in fuzzy matching: a fragment and its own ancestor overlap at ~0.99 similarity and are **not** duplication. Exact hashing is immune; MinHash is not.

### 4. Ranking is the product

A 48-file repo yields ~495 duplication candidates against a report budget of 20–50. Recall is not the constraint — selection is. Before adding a new detector, ask whether the ranker is already discarding good candidates. The PRD's re-entry criterion for embeddings applies to any new detection technique.

### 5. Never reference specific private codebases

Analysis and benchmarking happen against real private repositories. **Do not name them, path them, or quote their source in code, comments, docs, commit messages, or test fixtures.** Refer to "a sample project," "test repositories," or the anonymized "Sample A"/"Sample B" used in the PRD. Fixtures live in `tests/fixtures/` and are written by hand.

## Working style

- **TDD.** Write the failing test, run it and watch it fail for the right reason, then implement. Several bugs in the prototypes were caught only because an invariant was asserted (e.g. "L1 never produces fewer clusters than L0" — a property that held mathematically and failed in practice, which is how the α-renaming scope bug surfaced).
- **Commit at each completed task**, and push. Progress should be visible from the commit log alone.
- Conventional commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`, `refactor:`.
- Prefer boring code. This tool runs in a loop; predictability beats cleverness.
