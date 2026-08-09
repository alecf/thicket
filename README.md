# thicket

A CLI that analyzes a TypeScript codebase and emits a **deterministic plaintext complexity report**, designed to be read by an LLM inside a refactoring loop.

```
thicket report → LLM picks targets → LLM refactors → thicket report → …
```

thicket never judges, never edits, never opens PRs. It produces **ranked candidates with precise locations** plus a handful of scalar metrics a harness can watch trend across iterations. Deciding when progress is sufficient is the harness's job.

> **Status: pre-alpha, under active construction.** The design is settled and measured (see [`docs/PRD.md`](docs/PRD.md)); the implementation is being built against [`docs/plans/2026-08-09-thicket-v1.md`](docs/plans/2026-08-09-thicket-v1.md). Nothing here is installable yet.

## What it looks for

**Duplication** — every AST node above a size threshold becomes a fragment, so granularities nest naturally: a function is a fragment, the loop inside it is a fragment, the conditional inside that is a fragment. Fragments are hashed at two normalization levels (exact, and α-renamed so that renamed variables still match), with near-miss detection via MinHash/LSH to follow.

**Module tangle** — imports are resolved through the type checker, files are grouped into modules at an adaptively chosen granularity, and the resulting graph is analyzed for cycles (Tarjan SCC), propagation cost, and instability outliers. Cycles are reported with a suggested **feedback edge set**: not "there is a cycle" but "cutting these 2 edges breaks it."

**Simplification** — whole-program facts the type checker already knows: parameters that take the same constant at every call site, conditions that are statically `true`, exports nobody imports.

The interesting result is the **join** between the first two: *modules A, B and C form a cycle and share 4 duplicated clusters — extract the shared logic into a leaf module and the cycle dissolves as a side effect.* Neither analysis surfaces that alone.

## The design constraint that shapes everything

A 48-file toy repository produces roughly **495 duplication candidates**. A report budget realistically holds 20–50 findings.

We are discarding candidates by two orders of magnitude, which means an extra detection technique only adds to a pile that is already being truncated. So:

> **Rank well, then detect more — never the reverse.**

That one conclusion cut embeddings from v1, removed every native dependency, and makes the ranking function the most important code in the project.

## Report shape

```
# thicket report
thicket 0.1.0 · config 8f2a1c · 412 files / 84k LOC · granularity: dir:2 (18 modules)

## Summary
  duplicated mass      18,240 nodes (7.2%)   [prev 20,700 ▼ 11.9%]
  propagation cost     0.34
  dependency cycles    3 (largest SCC: 6 modules)
  findings             38 of 495 shown (dup 24 · tangle 6 · simplify 8)

## Duplication
### THK-DUP-a3f9c210 · score 812 · L1 · 5 copies × 34 nodes
  src/textures/atlas.ts:211,335,378,383  src/mobs/hostile.ts:26
  ArrowFunction, identical modulo identifiers.
```

Finding IDs are derived from content rather than position, so reports diff cleanly across loop iterations — `thicket diff before.json after.json` reports what was actually resolved versus merely moved. Truncation is never silent: "38 of 495" and "38" mean very different things to a harness deciding whether it is finished.

## Design notes

- [`docs/PRD.md`](docs/PRD.md) — technical PRD. Every decision is backed by measurement against real codebases, and several measurements overturned the starting premises (Go was the original implementation language; embeddings were the original duplication mechanism).
- [`prototypes/`](prototypes/) — the throwaway scripts that produced those measurements, kept because each one implements an algorithm the real code needs.

## Stack

TypeScript on Node ≥24, with **zero native dependencies** — `node:sqlite` for the content-addressed cache, and `typescript@next` for the frontend. TypeScript 7.1 exposes a real programmatic API (`typescript/unstable/sync`) backed by the Go compiler, which is the only way to get genuine type information rather than approximate syntax.

## License

MIT
