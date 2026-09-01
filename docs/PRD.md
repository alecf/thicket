# thicket — Technical PRD

**Status:** Reviewed, decisions resolved · **Date:** 2026-08-09 · **Scope:** high-level technical plan (implementation plan follows separately)

## 1. Purpose

`thicket` is a CLI that analyzes a TypeScript codebase and emits a **deterministic plaintext complexity report** for consumption by an LLM inside a refactoring loop.

```
thicket report → LLM picks targets → LLM refactors → thicket report → …
```

The harness decides when progress is sufficient and when to open PRs. `thicket` never judges, never edits, never opens PRs. It produces **ranked candidates with precise locations** and a small set of **scalar metrics** the harness can watch trend across iterations.

### 1.1 The central thesis: ranking is the bottleneck, not recall

The LLM is the judge, so false positives cost only a glance while false negatives cost a refactor that never happens. That framing suggests maximizing recall — but measurement contradicts it.

**A 48-file toy repository produces ~495 duplication candidates** (§2.5). A report budget realistically holds 20–50 findings. We are already discarding candidates by two orders of magnitude, and every additional detection technique adds to a pile that is being truncated, not filled.

Therefore the design priority is:

> **Rank well, then detect more — never the reverse.**

This single conclusion cut embeddings from v1 (§11.4), collapsed the normalization ladder from five levels to four (§5.2), and makes §5.5 the most important section of this document.

### 1.2 Non-goals

- Judging whether a refactor is worthwhile
- Editing code, opening PRs, or deciding when progress is sufficient
- Languages other than TypeScript/TSX
- General abstract interpretation or SMT-based reasoning (§6)
- Semantic/Type-4 clone detection in v1 (§11.4 records the re-entry criterion)

---

## 2. Findings from prototyping

Everything below was measured against two real private codebases, referred to here as **Sample A** (a 3-package monorepo, 971 files including declarations, 48 first-party source files) and **Sample B** (a 140-file Next.js app). Several results overturned starting premises.

### 2.1 TypeScript 7.1 ships a real programmatic API — today

TypeScript 7.0 went GA 2026-07-08; the Go rewrite (`microsoft/typescript-go`) *is* mainline `tsc`. Its Go packages live under `internal/` and are not importable, and Microsoft has deliberately declined to expose them — the `tsgolint` fork-and-patch approach is an explicitly unmaintained prototype.

But `typescript@next` (`7.1.0-dev.20260808.1`) ships a curated API:

| Export | Provides |
|---|---|
| `typescript/unstable/async` | `API`, `Snapshot`, `Project`, `Program`, **`Checker`**, `Emitter` |
| `typescript/unstable/ast` | `SyntaxKind`, node types, scanner, visitor, factory |

The AST is lazily materialized from a binary buffer over JSON-RPC to the `tsgo` Go binary. The checker is complete enough for everything here: `getResolvedSignature`, `getSymbolAtLocation`, `getTypeAtLocation`, `getReferencedSymbolsForNode`, `getConstantValue`, `isTypeAssignableTo`, `getExportsOfModule`.

**Risk:** the path is named `unstable` and 7.1 is a dev build. Mitigated by pinning the nightly and confining all API contact to one adapter module (§4.1). 7.1 is expected to stabilize around October 2026.

### 2.2 Measured performance (Sample A, 971 files / 14 MB)

| Operation | Result |
|---|---|
| Load + bind 3-package monorepo | 165 ms |
| Walk every AST node | **2.87M nodes/sec** (51 MB/s) |
| Walk + SHA-256 fingerprint every subtree | 0.82M nodes/sec |
| `getResolvedSignature` per call site | 0.135 ms |
| MinHash + LSH over 3,874 distinct shapes | 564 ms |

SHA-256 is the wrong tool — a 64-bit non-cryptographic hash should roughly triple the fingerprint rate. At ~2M nodes/sec a 1M-line codebase fingerprints cold in seconds, and incremental caching makes warm loop iterations near-instant.

### 2.3 Node is the right runtime; Go buys little

Go was the starting assumption. The measurements don't support it:

- The only good TypeScript frontend is Node-only. Reaching it from Go means reimplementing an *unstable* JSON-RPC + binary AST protocol under a tool designed to run in a loop.
- The AST path is already fast enough in Node (§2.2).
- The CPU-bound stages operate on **thousands** of fragment shapes and **hundreds** of modules — not millions of nodes.
- Distribution: `npx thicket`. Every target user has Node; they're analyzing a TypeScript codebase.

Pipeline stages remain separable, so a hot stage can be relocated later if profiling ever justifies it.

### 2.4 API hazards discovered by running the code

Each of these silently produced *plausible but wrong* output rather than an error. They must be sealed inside the adapter (§4.1). The last two were found during implementation rather than prototyping.

| Hazard | Symptom | Correct handling |
|---|---|---|
| **`forEachChild` aborts on truthy return** | Only the first statement per file was visited; counts looked merely "low" | Traversal helper must swallow callback return values |
| **`Path` is case-canonicalized** (lowercased); `getSourceFileNames()` preserves original casing | Comparing them yields **zero** resolved import edges | Compare through a normalized key |
| **Monorepo files belong to N projects** | `packages/shared` analyzed 3×, appearing as phantom triplicate clones | Unit of analysis is the file's **content hash**, not `(project, file)` |
| **Directory depth collapses in monorepos** | Every path starts `packages/`, so depth-1 grouping yields one module | Strip the longest common directory prefix first |
| **`SyntaxKind` reverse lookup returns range-marker aliases** | `SyntaxKind[SyntaxKind.NumericLiteral]` is `"FirstLiteralToken"`, not `"NumericLiteral"`; `VariableStatement` → `"FirstStatement"` | Match kinds by **enum value**, never by reverse-mapped name |
| **A foreign project's checker throws on an unowned node** | It does not return `undefined`; a blanket `catch` turns the bug into "this repo has no imports" | Query each file through the checker of the project that owns it |

**Module resolution** works cleanly once the casing hazard is handled: `checker.getSymbolAtLocation(moduleSpecifier)` returns the module symbol, whose `declarations[0].path` is the resolved absolute path — correctly handling path aliases, package boundaries, and extensionless specifiers.

### 2.5 The normalization ladder: L1 is the win, L2 is redundant

Measured on Sample A, fragments ≥15 nodes:

| Level | Clusters | Mass | Marginal gain |
|---|---|---|---|
| L0 exact (identifiers preserved) | 121 | 3,103 | — |
| **L1 α-renamed** | **320** | **10,028** | **3.2× mass** |
| L2 structural (literals → kind) | 323 | 10,266 | +2% |
| L3 near-miss (MinHash, Jaccard ≥ 0.7) | +175 clusters over 1,164 shapes | — | new axis |

**L2 does not earn a place as a reported level.** It survives only as the token stream fed into L3's shingling. The ladder is L0 → L1 → L3.

Two normalization requirements, both found by getting them wrong first:

- **α-renaming must be fragment-local.** Indexing bindings per *file* gives two identical fragments different indices depending on what preceded them in their file, so L1 *splits* clusters that L0 united.

  The correct invariant is **L0-equal ⟹ L1-equal**: identical L0 token streams must yield identical L1 token streams, so no L0 cluster may straddle two L1 clusters. Splitting is impossible for any true coarsening, and the per-file bug violates it on every cluster.

  A cluster *count* comparison does **not** detect this, and an earlier draft of this document had it backwards. Coarsening merges equivalence classes, and merging two classes of size ≥ 2 into one *lowers* the cluster count while strictly generalizing — `const dx = p.x - ORIGIN.x` and `const dy = p.y - ORIGIN.y` are two L0 clusters and one L1 cluster. Measured on the fixture at `minNodes 10`: correct code gives L0=17, L1=15, 0 splits; the buggy version gives L0=17, L1=18, 17 splits. "L1 never reports fewer clusters than L0" therefore *fails on correct code and passes on the bug*.
- **Fuzzy matching must exclude ancestor–descendant pairs.** L3's top "clones" were a 2,463-node block against its own 2,469-node parent at ~0.99 similarity. Filtering nesting removed **9,926 of 12,891 candidate pairs (77%)**. Exact hashing is immune; fuzzy matching is not.

### 2.6 Coarse module granularity has no signal

Inter-module edges vs. edges buried as intra-module:

| Granularity | Sample A (48 files) | Sample B (140 files) |
|---|---|---|
| tsconfig project | 2 mods, **1 edge**, 80 intra, 0 cycles | 1 mod, **0 edges**, 296 intra, 0 cycles |
| package.json | 3 mods, 2 edges, 66 intra, 0 cycles | 3 mods, 2 edges, 264 intra, 0 cycles |
| dir depth 1 | 3 mods, 2 edges, 66 intra, 0 cycles | 5 mods, 4 edges, 261 intra, 0 cycles |
| dir depth 2 | 3 mods, 2 edges, 66 intra, 0 cycles | 12 mods, 15 edges, **1 cycle** |
| dir depth 3 | 8 mods, 14 edges, **2 cycles** | 24 mods, 71 edges, **1 cycle** |
| file | 48 mods, 87 edges, 0 cycles | 140 mods, 294 edges, 0 cycles |

The intuitive boundaries are the useless ones: **tsconfig-project and package.json granularity bury 76–100% of edges as intra-module.**

Two consequences:

- **Cycles exist only at module level.** File granularity finds zero cycles in both repos; the cycles are *grouping-induced* (file A in X imports into Y while file C in Y imports back into X, with no file-level cycle). Grouping-induced cycles **are** the tangle signal.
- **√(file count) predicts the useful granularity.** Sample A √48 ≈ 7 → depth 3 yields 8 modules; Sample B √140 ≈ 12 → depth 2 yields exactly 12. In both, that is the first granularity where cycles appear.

### 2.7 Test files do not swamp the report

Both repos: tests are 17–21% of files but only **14% of duplicated mass**. 78–83% of clusters are source-only; **3–4% are mixed test+source** — production logic reimplemented inside a test, arguably the most interesting category.

---

## 3. Technology decisions

| Concern | Choice | Rationale |
|---|---|---|
| Language | **TypeScript on Bun ≥1.4** | §2.3; runs live, no build step |
| TS frontend | **`typescript@next` → `typescript/unstable/async`** | Only path to real types; §2.1. The `sync` variant reads POSIX fds off child stdio, which Bun does not expose |
| Cache | **`node:sqlite`** (built-in, SQLite 3.53.1) | Zero native deps; relational |
| Hashing | **xxhash64 / FNV-1a** (not SHA-256) | ~3× faster; collision risk irrelevant here |
| Near-miss detection | **MinHash + LSH**, fixed seeds | Deterministic, 564 ms over 3.9k shapes |
| Parallelism | `worker_threads` for fingerprinting | Per-file work is embarrassingly parallel |
| Output | Compact Markdown + `--json` sidecar | §9 |

**Zero native dependencies.** Cutting embeddings (§11.4) removed ONNX Runtime, the 307 MB model, `sqlite-vec`, and the vector index. `thicket` is now pure JS over Node built-ins plus the pinned `typescript` nightly.

**Rejected:** Go (§2.3) · tree-sitter (approximate syntax, no types, and its premise — the real compiler being unreachable — is false) · forking typescript-go (rebase treadmill for an API arriving in ~2 months) · libSQL/Turso (vector storage no longer needed at all).

---

## 4. Architecture

```
thicket <command> [--depth N] [--budget-tokens N] [--granularity G]

  ┌─ extract ──────────────────────────────────────────┐
  │ TS API adapter → files → fragments, symbols, edges │
  └────────────────────────┬───────────────────────────┘
                           ↓  (content-addressed)
  ┌─ cache (node:sqlite) ──────────────────────────────┐
  │ files · fragments · occurrences · minhash · edges  │
  └────────────────────────┬───────────────────────────┘
                           ↓
     ┌─────────────┬───────┴────────┬──────────────┐
     ↓             ↓                ↓              ↓
  duplication   module graph    invariants     (join)
   (§5)            (§7)           (§6)      dup × tangle
     └─────────────┴───────┬────────┴──────────────┘
                           ↓
  ┌─ rank + budget (§5.5, §9.3) ───────────────────────┐
  │ the part that actually determines report quality   │
  └────────────────────────┬───────────────────────────┘
                           ↓
              Markdown report + JSON sidecar
```

### 4.1 The adapter boundary

All contact with `typescript/unstable/*` — and every hazard in §2.4 — is confined to `src/extract/ts-adapter.ts`:

```ts
interface SourceModel {
  files(): Iterable<FileHandle>;              // deduped by content hash
  fragments(f: FileHandle): Iterable<Fragment>;
  imports(f: FileHandle): Iterable<ImportEdge>;   // resolved, case-normalized
  resolveCall(node): SymbolRef | undefined;
  referencesTo(sym: SymbolRef): Iterable<Location>;
  typeAt(node): TypeInfo;
}
```

Everything downstream consumes `SourceModel`. When 7.1 stabilizes, one file changes.

---

## 5. Pillar 1 — Duplication

### 5.1 Fragment extraction

Every AST node whose kind is *interesting* and whose subtree size ≥ threshold becomes a fragment. Multi-granularity falls out naturally: a function is a fragment, so is the loop inside it, so is the conditional inside that.

**Interesting kinds:** function-like declarations, blocks, statements, loop/if/switch bodies and branches, object/array literals, call expressions, JSX elements, template literals, catch clauses.

**Excluded kinds** (§2.4): imports/exports and their clauses — structurally identical everywhere, zero refactoring signal. Without this filter the entire top of the report is `ImportDeclaration`.

### 5.2 The normalization ladder

The level at which two fragments match is itself signal — it tells the LLM how mechanical the extraction will be.

| Level | Normalization | Catches | Signal |
|---|---|---|---|
| **L0** | raw token text | byte-identical | trivially extractable |
| **L1** | α-renaming, **fragment-local** (§2.5); literals keep kind | renamed variables | mechanical extraction |
| *(internal)* | identifiers and literals → `SyntaxKind` | — | token stream for L3 only |
| **L3** | MinHash over 5-shingles of the internal stream | near-miss, insertions/deletions | needs judgment |

L0 and L1 are exact hash-and-group: linear, trivially cacheable, no tuning.

### 5.3 Near-miss via MinHash + LSH

1. Serialize each fragment's normalized AST to a pre-order token sequence with structure markers.
2. Take 5-shingles; compute a 128-permutation MinHash signature with **fixed seeds**.
3. Band into 32 bands × 4 rows; fragments sharing a bucket become candidate pairs.
4. **Discard ancestor–descendant pairs** (§2.5) — 77% of candidates, and pure noise.
5. Compute exact Jaccard on shingle sets; keep pairs ≥ **0.7** (loosened by `--depth`).
6. Cluster by union-find, edges processed in `(similarity desc, id asc)` order for determinism.

### 5.4 Ranking — the core algorithm

Report slots are scarce by two orders of magnitude (§1.1), so ranking *is* the product:

```
copies = min(occurrences, 10 × distinct_files)   # cap intra-file repetition
score  = fragment_size × (copies − 1)            # nodes deletable by extracting
       × log2(1 + copies)                        # widespread > paired
       × spread                                  # 2.5 cross-module · 1.4 cross-file · 0.8 intra-file
       × level_weight                            # L0 > L1 > L3
       × test_weight                             # [test] down-weighted, [mixed] not
```

**The copy cap is the one non-obvious term**, and it was added only after measuring against real repositories. A shape repeated 99 times inside a single file is a data table, not a missing abstraction — but raw mass endorses it: on one repo a 99-copy, 21-node `PropertyAssignment` from one config literal outscored an 8-copy, 109-node function duplicated across eight route files by **12306 to 2612** (2058 deletable nodes against 763). No spread multiplier small enough to be honest overcomes a 12× count difference, so the count itself is capped. The cap binds on **under 3% of candidates** on every repository measured — it removes the pathology without reordering everything else.

**Intra-file duplication is down-weighted, not excluded.** It is **70–84% of all candidates** on every repo measured, so suppressing it would empty the report of repeated handlers and repeated markup. A more aggressive variant scored better on a hand-rubric precisely because it removed that whole category — pushing a genuinely extractable repeated `onChange` handler from rank 4 to rank 53 — and was rejected for that reason.

**A known limit of the current feature set:** a 40-node object literal repeated 15 times and a 40-node code block repeated 15 times are identical in *every* feature the ranker has. Separating them needs a new signal — occurrences being consecutive siblings under one `ObjectLiteralExpression` — not a new weight. Until then a few data tables survive in the lower half of the report.

**Subsumption:** where a parent cluster and child cluster cover the same occurrence multiset, keep only the parent. A budget optimization, not a correctness fix.

**Tagging:** clusters are marked `[test]` (all occurrences in tests) or `[mixed]` (spanning test and source). Mixed clusters are *not* penalized — they indicate production logic duplicated into tests (§2.7).

---

## 6. Pillar 2 — Simplification

Deliberately narrow: **whole-program call-site invariants**, not general invariant inference. Every check is deterministic and reads facts the checker already computed. Abstract interpretation and SMT are explicitly out of scope.

| Check | Method | Output |
|---|---|---|
| **Constant-condition branches** | `getTypeAtLocation` returns literal `true`/`false` | dead branch, safely deletable |
| **Always-same-argument parameters** | `getReferencedSymbolsForNode` + `getResolvedSignature` across *all* call sites | "`flag` is `true` at all 7 call sites — inline it" |
| **Never-undefined optionals** | param typed `T \| undefined`, no call site passes undefined | tighten the signature |
| **Dead exports** | exported symbol with zero external references | delete |
| **Redundant guard chains** | identical condition re-tested in a nested scope | collapse |

The always-same-argument check is the standout: a genuine whole-program fact, invisible to anyone reading a single file, yielding boolean-parameter removal — among the highest-yield mechanical simplifications available.

---

## 7. Pillar 3 — Module tangle

### 7.1 Adaptive granularity

Given §2.6, granularity cannot be a fixed default. `thicket` **selects the granularity whose module count lands nearest √(file count), clamped to [8, 64]**, after stripping the longest common directory prefix.

Candidate granularities, coarse to fine: tsconfig project → `package.json` → directory depth 1..N → file. `--depth` shifts the target band; `--granularity` overrides explicitly.

This avoids the failure mode the data exposes at both ends: coarse boundaries produce a 1-node graph, file granularity produces a large DAG with no cycles at all.

### 7.2 Graph construction

- **Nodes:** files grouped per §7.1.
- **Edges:** resolved via `checker.getSymbolAtLocation(moduleSpecifier).declarations[0].path`, compared case-normalized (§2.4). **Weight = count of distinct symbols referenced**, so pulling one constant is not treated like pulling thirty.

### 7.3 Metrics

| Metric | Algorithm | Reported as |
|---|---|---|
| **Cycles** | Tarjan SCC | each SCC with edges + approximate **minimum feedback edge set** |
| **Propagation cost** | density of transitive closure (Baldwin/MacCormack) | single scalar, ideal for trend-watching |
| **Instability / Abstractness** | `I = Ce/(Ca+Ce)`, `A`, distance from main sequence | per-module outliers |
| **Hubs** | fan-in / fan-out outliers | god-modules |
| **Hinges** | articulation points + edge betweenness | "cut here to untangle" |

Reporting the **feedback edge set** rather than merely "there is a cycle" is what makes this actionable: *"these 6 modules form a cycle; cutting these 2 edges breaks it"* is a refactoring instruction.

### 7.4 The join — the differentiating feature

Intersecting pillars 1 and 3:

> Modules A, B, C form a dependency cycle **and** share 4 duplicated fragment clusters.
> → Extract the shared logic into a new leaf module; the cycle dissolves as a side effect.

Neither pillar surfaces this alone. It is cheap once both exist — a join on the fragment→module mapping — and directly answers the "snarled dependencies where shared logic should be extracted" goal.

---

## 8. Caching

### 8.1 Content-addressed schema

The requirement *"an identical expression seen 3 times should only be processed once"* falls out of content addressing rather than special-case logic.

```sql
file(id, path, content_hash, mtime)
fragment(norm_hash PK, level, kind, node_count, token_count)   -- ONE row per distinct shape
occurrence(fragment_hash → fragment, file_id, start, end, parent_hash)
minhash(fragment_hash PK, signature BLOB)
module_edge(from_module, to_module, weight, symbols)
symbol(id, file_id, name, kind, exported)
reference(symbol_id, file_id, start, end)
finding(id, kind, score, payload JSON, run_id)
```

Both caching layers emerge from one design:

- **Within a run:** an identical expression appearing 3× produces one `fragment` row and three `occurrence` rows. Hashed once, MinHashed once.
- **Across runs:** `file.content_hash` gates re-extraction — unchanged files are skipped entirely. In the loop's steady state only the files the LLM just edited are re-analyzed.

`occurrence.parent_hash` supports both subsumption (§5.4) and the ancestor–descendant filter (§5.3) without re-walking the tree.

**As implemented, v1 collapses `fragment` and `occurrence` into one
`fragment_occurrence` row carrying both the L0 and the L1 hash.** Keying a row
by its own normalized hash separates the two levels of the *same* fragment, and
the L1 suppression rule (§5.2) needs them together — without it the cached run
reports findings the uncached run correctly drops. The row is keyed by
`(path, seq)` rather than by byte range, because two AST nodes can share a range
exactly (a statement and its child expression, when ASI ate the semicolon).
Deduplication of identical shapes moves to the in-memory grouping, which had to
happen anyway.

### 8.2 Invalidation

Keyed on per-file `content_hash` plus a global `config_hash` (thicket version + normalization rules + thresholds). A config change invalidates derived tables; `thicket cache clear` resets everything.

---

## 9. The report

### 9.1 Stable finding IDs — the loop's backbone

Each finding gets an ID derived from its *content*, not its position:

```
THK-DUP-a3f9c210    THK-CYC-77b1e004    THK-INV-2c8d9f31
```

This makes reports **diffable across iterations**, letting the harness detect real progress rather than churn:

```
thicket diff before.json after.json
  → 3 findings resolved, 1 new, duplicated mass −12%, propagation cost 0.34 → 0.29
```

### 9.2 Structure

Compact Markdown — parsed natively by LLMs, debuggable by humans, no decorative nesting.

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
  client/src/textures/atlas.ts:211,335,378,383  shared/src/mobs/hostile.ts:26
  ArrowFunction, identical modulo identifiers.

### THK-DUP-1e77b204 · score 640 · L3 · 3 near-miss · Jaccard 0.81  [mixed]
  shared/src/crafting.ts:88  shared/src/crafting.test.ts:34,50

## Module tangle
### THK-CYC-77b1e004 · SCC of 6 modules
  cycle: shared/blocks → server/world → shared/entities → shared/blocks
  suggested cuts (2 edges): server/world→shared/entities, client/net→server/world
  ⚠ these modules share 4 duplicate clusters (THK-DUP-a3f9c210, …)
    → extract to a leaf module; the cycle dissolves

## Simplification
### THK-INV-2c8d9f31 · parameter always constant
  server/src/plugin-api.ts:88 `registerPlugin(name, opts, strict)`
  `strict` is `true` at all 7 call sites.

… 457 further findings omitted (--budget-tokens 8000)
```

A `--json` sidecar carries identical finding IDs for harnesses that prefer parsing.

### 9.3 Depth and budget

- **`--depth 1..5`** — preset table controlling min fragment size, Jaccard threshold, findings per section, granularity target band, and whether excerpts are included.
- **`--budget-tokens N`** — hard ceiling. Findings emit in rank order until exhausted.

Budget is likely the more useful knob: the harness knows its context window, not its desired depth. **Truncation is never silent** — the omitted count is always stated, because "38 findings" and "38 of 495 findings" mean very different things to a harness deciding whether it is done.

### 9.4 Determinism guarantees

The report is a pure function of `(source content, config, thicket version)`:

- Fixed hash and MinHash seeds; no reliance on Map insertion order
- All collections sorted before emission; ties broken by `(score desc, id asc)`
- Paths POSIX-normalized and repo-relative
- No timestamps, durations, or absolute paths in the diffable body
- Deterministic clustering (union-find over a threshold graph; never k-means)
- Enforced by golden-file tests over a fixture repo

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `typescript/unstable` API churn | **High** | Single adapter (§4.1); pinned nightly; 7.1 stabilizes ~Oct 2026 |
| **Ranking surfaces the wrong 40 of 495** | **High** | §5.4 is the core algorithm; validate against real repos before adding detectors |
| Silent-wrong API hazards (§2.4) | Medium | All four sealed in the adapter, each with a regression test |
| Adaptive granularity picks badly | Medium | `--granularity` override; report the chosen level in the header |
| Node too slow on 1M+ LOC | Low | Measured headroom (§2.2); `worker_threads`; stages separable |

---

## 11. Resolved decisions

| # | Question | Decision | Basis |
|---|---|---|---|
| 1 | Module granularity | **Adaptive, target √n modules**, clamped [8,64] | §2.6 — coarse granularity yields 0–2 edges and no cycles |
| 2 | Test files | **Include, tag, down-weight**; `[mixed]` not penalized | §2.7 — only 14% of mass, and mixed clusters are high-signal |
| 3 | Monorepos | **One unified report** | Cross-package duplication (21 clusters) and package-spanning cycles are invisible per-project |
| 4 | Embeddings / `--semantic` | **Cut from v1** | §1.1 — already 10× more candidates than budget; added recall has no consumer |
| 5 | Report format | **Compact Markdown + `--json` sidecar** | LLM-native, human-debuggable; `--budget-tokens` does the real work |

**Re-entry criterion for #4:** build L4 embeddings only if a tuned ranker exhausts good L0/L1/L3 candidates before filling the report budget. Until that happens, more detection is strictly wasted work.

---

## 12. Proposed v1 scope

**Ship first** — the smallest thing that closes the refactor loop end-to-end:

1. TS adapter with all four §2.4 hazards sealed and regression-tested
2. Duplication L0 + L1 (fragment-local α-renaming)
3. Module graph: adaptive granularity, Tarjan SCC, propagation cost
4. Content-addressed cache
5. Ranked report with stable IDs, `--budget-tokens`, `--json`
6. `thicket diff`

**Then, in order:**

7. L3 MinHash/LSH with ancestor–descendant exclusion
8. The dup × tangle join (§7.4) — the differentiating feature
9. Simplification checks (§6), starting with always-same-argument

**Not planned:** L4 embeddings (§11.4).

Rationale: steps 1–6 produce a working loop. Everything after improves recall or actionability on a system that already runs, and each can be validated against real repositories before the next is built.
