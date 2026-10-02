# Multi-Language Support Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Analyze Python and Go repositories. Keep one shared core for clustering, the module graph, ranking, the cache and the report.

**Architecture:** Each language gets a **frontend** and a **profile**. The frontend parses files and resolves imports. The profile holds the rules that today name TypeScript syntax kinds directly. TypeScript keeps tsgo. Go uses its own standard-library parser. Python uses tree-sitter. Import resolution for Go and Python is hand-written and needs no toolchain.

**Read first:** `docs/PRD.md` §2.3, §4.1 and §5. AGENTS.md §1, §3, §4, §4b, §5 and §7. Most of the work in this plan is re-deriving AGENTS.md §4 for each new language.

**Status:** Phases 0 and 1 are approved for the TypeScript codebase now. Phases 2 to 4 are the design for the Go rewrite. They are not built in TypeScript. See §0.

---

## 0. Decisions

Recorded 2026-10-02.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | How far does this go in the TypeScript codebase? | Phases 0 and 1 only. | thicket will be rewritten in Go once TypeScript 7.1 ships a Go API. Phase 0's profile and Phase 1's measurements carry over. Frontend code would be written twice. |
| D2 | Which language comes first? | Python. | Python has real import cycles, so all three pillars apply. `if TYPE_CHECKING:` maps onto the existing type-only edge logic. It tests the shared core harder than Go does. |
| D3 | What does a repo with several languages get? | One merged report. | One file for the agent to read. Cross-language cycles cannot exist, so tangle sections merge with no special case. Each finding names its language. |
| D4 | How is Go source parsed? | `go/parser` and `go/ast` from the Go standard library. | The rewrite gets an exact Go parser for free. No cgo and no grammar files. Python is the only tree-sitter language. |
| D5 | Where do Go import edges come from? | Parse `go.mod` and map import paths to directories. No Go toolchain. | The report stays a pure function of the source. `go list` would make the installed Go version an input to the report. |
| D6 | What replaces the empty cycle section for Go? | A coupling measure: propagation cost and the most depended-on packages. | Go forbids import cycles between packages. An empty section reads as "no problem found". `src/graph/metrics.ts` already computes propagation cost. |
| D7 | How are Python imports resolved? | A hand-written resolver. No Python runtime. | Pure path logic, so it ports to Go line for line. grimp would need a Python interpreter in either codebase. Validated once against grimp in Phase 1. |
| D8 | How does a Python import inside a function body count? | A new `deferred` count on the edge. | The edge exists at runtime but cannot fail at module load. Folding it into `erased` would tell the reader the edge vanishes. Printed only when it changes a number. |
| D9 | Is the Go `if err != nil` idiom filtered? | Decided by Phase 1 data. | Build the filter only if the baseline shows the idiom crowding the top 40. If built, it is on by default and `--include-go-idioms` turns it off. |
| D10 | When does Phase 0 land? | Now, as its own PR. | It changes no behavior and the determinism job checks it. |
| D11 | What format do the profile contract tests use? | Data-driven golden files. | vitest reads them now. A Go test reads the same files after the rewrite. |

### 0.1 A PRD claim to revisit

PRD §2.3 says typescript-go's packages live under `internal/` and Microsoft declined to expose them. D1 assumes TypeScript 7.1 changes that. When 7.1 ships, rewrite §2.3 and its "Go buys little" reasoning from the release itself.

---

## 1. Why this is mostly a heuristics problem

Parsing a new language is cheap. The hard part is the rules that make the report short enough to act on.

### 1.1 What is already language-neutral

- **The module graph.** `src/graph/build.ts` reads only `Project.files()`, `importDetailsOf()` and `reexportsOf()`. Tarjan, grouping, cuts and dissolves never see an AST. A frontend that fills in `ImportDetail` gets the tangle section with no changes.
- **Clustering and the cache.** Everything after `shapeFragments` sees a `ShapedFragment`. That is a kind string, a node count, a span and two hashes. `alphaRename` works on `Id:` tokens and does not care which language produced them.
- **Ranking arithmetic.** `recoverableLines`, the copy cap, spread and subsumption use only spans, paths and counts. Spans are in lines, so scores from different languages are comparable in a merged report (D3).

### 1.2 Where TypeScript leaks out of the adapter

| File | What it knows about TypeScript |
|---|---|
| `src/fingerprint/fragments.ts` | Imports `SyntaxKind`. Holds `IGNORED_KINDS`, `LITERAL_KINDS`, the `Identifier` test and the token stream format. |
| `src/report/kinds.ts` | Imports `SyntaxKind`. Holds the alias map and the type-declaration kinds behind `## Duplicated types`. |
| `src/report/callsite.ts` | Imports `SyntaxKind`. Spells about 23 kind names for `isBareCall` and the keyword-position rule. |
| `src/report/variation.ts` | `NAME_HOLDERS` lists eight TypeScript kinds, including `JsxAttribute`. |
| `src/report/rank.ts` | `TEST_PATTERN` matches `.test.ts` and `__tests__/`. |
| `src/report/markdown.ts` | Maps file extensions to code fence languages. |
| `src/cli.ts`, `src/extract/workspaces.ts` | Discovery is tsconfig and `package.json` workspaces. |

Each row is a rule AGENTS.md §4 justifies with a measurement. Every one needs an answer per language. A missing answer does not fail. It reads as agreement, which is the `NAME_HOLDERS` lesson.

---

## 2. Choosing the parser

### 2.1 Options considered

| Option | What it gives | Decision |
|---|---|---|
| tree-sitter | A concrete syntax tree for almost every language, with named fields. Grammars ship `tags.scm` and `locals.scm` queries for definitions and scopes. | **Python.** `web-tree-sitter` (WASM) for Phase 1. The rewrite needs a binding without cgo (§2.2). |
| Go standard library `go/parser`, `go/ast` | An exact Go parser with no external dependency. | **Go**, in the rewrite (D4). |
| `@ast-grep/napi` | tree-sitter plus a pattern language. | Rejected. A native addon complicates `bun build --compile`. |
| SCIP indexers (`scip-go`, `scip-python`) | Symbols, definitions and references in one standard format. | Rejected. Too heavy a step to run each loop iteration. |
| Language servers (gopls, pyright) | Definitions and references over LSP. | Rejected. Slow and stateful for a tool that runs in a loop. |
| `go list`, grimp | Exact import graphs from each language's own tools. | Rejected for the product (D5, D7). grimp is used once in Phase 1 to check the hand-written resolver. |
| Universal ASTs (Babelfish UAST, srcML, GitHub Semantic) | One schema for every language. | Rejected. Babelfish and Semantic are abandoned. A single schema erases the per-language detail the profile rules need. |
| tree-sitter for TypeScript too | One parser everywhere. | Rejected. PRD §2.3 still holds. It would also lose type-only edges and re-export origins. |

No maintained standard for a language-agnostic AST exists. tree-sitter is the common denominator.

### 2.2 Consequences for distribution and determinism

- **The Python grammar ships as a file.** It sits beside the binary, the same way tsgo's `lib.*.d.ts` files do. AGENTS.md §7 applies in full.
- **The rewrite needs tree-sitter without cgo.** The common Go bindings use cgo, which breaks building every platform from one host. Running the WASM grammar under `wazero` avoids cgo. Its maturity is unchecked. Task 1.4 checks it.
- **The grammar version joins the config hash.** A new grammar can change the tree, so it can change the report (AGENTS.md §5).
- **No external toolchain is an input.** D5 and D7 keep the report a pure function of `(source content, config, thicket version)`.

---

## 3. Target interfaces

These are sketches. Phase 0 discovers the real shape. The rewrite ports it to Go.

```ts
/** One per language. Owns all contact with that language's parser. */
interface LanguageFrontend {
  id: "typescript" | "go" | "python";
  /** Finds projects under a directory: tsconfig, go.mod, pyproject.toml. */
  discover(dir: string): Promise<ProjectSpec[]>;
  open(spec: ProjectSpec, opts: OpenProjectOptions): Promise<Project>;
  profile: LanguageProfile;
}

/** The rules downstream code asks about. Keyed on namespaced kind strings. */
interface LanguageProfile {
  isIgnoredKind(kind: Kind): boolean;      // fragments.ts IGNORED_KINDS
  isLiteralKind(kind: Kind): boolean;      // fragments.ts LITERAL_KINDS
  isIdentifierKind(kind: Kind): boolean;
  isNameHolder(kind: Kind): boolean;       // variation.ts NAME_HOLDERS
  isTypeDeclKind(kind: Kind): boolean;     // kinds.ts, ## Duplicated types
  isBareCall(tokens: readonly string[]): boolean;  // callsite.ts
  isTestPath(path: string): boolean;       // rank.ts TEST_PATTERN
  fenceLanguage(path: string): string;     // markdown.ts
}
```

Two rules for the interface:

- **Kinds are namespaced strings**, as `go:CallExpr` or `py:call`. A kind from one language must never hash the same as a kind from another. Merged reports (D3) then cluster correctly with no special case.
- **TypeScript keeps matching by enum value inside its profile.** The `SyntaxKind` alias hazard (AGENTS.md §3) stays sealed in the TypeScript profile. Nothing outside it sees a numeric kind.

`Project` stays as it is. `ImportDetail` gains `deferred` for Python (D8). `erased` is always 0 for Go.

---

## Phase 0: Seal TypeScript syntax behind a profile

**In the TypeScript codebase, now (D10).** No behavior change. The determinism job and every reference report stay byte-identical.

### Task 0.1: Extract the TypeScript profile

**Files:**
- Create: `src/lang/typescript/profile.ts`
- Modify: `src/fingerprint/fragments.ts`, `src/report/kinds.ts`, `src/report/callsite.ts`, `src/report/variation.ts`, `src/report/rank.ts`, `src/report/markdown.ts`

**Steps:**
1. Move `IGNORED_KINDS`, `LITERAL_KINDS`, `NAME_HOLDERS`, the type-declaration kinds, `TEST_PATTERN` and the fence map into the profile. Move the comments that justify them too.
2. Callers import the TypeScript profile directly. Passing it as an argument would serve a second language, and D1 keeps that out of this codebase. The `LanguageProfile` interface is the deliverable the rewrite ports.
3. After the move, `grep -rn "SyntaxKind\|typescript/unstable" src` must match only `src/extract/` and `src/lang/typescript/`.
4. Add that grep to CI next to the `localeCompare` check.

**Verify:** `bun run typecheck`, `bun run test`, and the determinism job. Diff a reference report against `main`. It must be empty.

### Task 0.2: Namespace kind strings

**Files:**
- Modify: `src/fingerprint/fragments.ts`, `src/cache/db.ts`, `src/version.ts`

**Steps:**
1. Prefix every kind with `ts:` when it enters the token stream and the `ShapedFragment`.
2. Strip the prefix wherever a kind is printed, so the report stays byte-identical.
3. Bump the cache schema version, because cached rows hold unprefixed kinds.

**Verify:** `tests/cache-pipeline.test.ts` passes with cold and warm cluster lists deeply equal. The reference report diff is empty.

### Task 0.3: Write the profile contract as golden files

**Files:**
- Create: `tests/lang/contract/<language>/<case>/` with `input.<ext>` and `expected.json`
- Create: `tests/lang/profile-contract.test.ts`

Each case is a directory, so a Go test runner can read the same files after the rewrite (D11). `expected.json` holds the L0 and L1 token streams and every profile verdict for the input. It also names the AGENTS.md §4 lesson the case guards. Initial TypeScript cases:

- A field name is a name holder. Two shapes that differ only in field names report drift.
- A literal's value enters the L0 stream. `f(2)` and `f(3)` differ at L0.
- Template string content enters the L0 stream.
- A single call to a shared helper is a bare call. A call with a body argument is not.
- A test file is recognized by its path, and `latest/attest.ts` is not.

The vitest runner iterates the directories in `compareStrings` order. Delete each guard once in the TypeScript profile and watch its case fail.

---

## Phase 1: Measure before designing

**In the TypeScript codebase, now (D1).** Prototype scripts only, in `prototypes/`. They are not the implementation. Every Phase 2 to 4 decision cites a number from here, as the PRD does.

### Task 1.1: Python baseline

**Files:**
- Create: `prototypes/python-baseline.ts`

**Steps:**
1. Parse a sample Python repository with `web-tree-sitter` and the Python grammar.
2. Emit L0 and L1 token streams with no profile rules at all. Named nodes become kinds. Identifiers and literals follow the current `Id:` and literal token forms.
3. Feed `clusterFragments` and the ranker. Record the top 40 findings.
4. Classify each finding as actionable, idiom, or noise. Record the counts.

**Questions to answer:**
- How often does `self.x = x` in `__init__` reach the top 40?
- Do f-string contents reach the token stream? This is the `TemplateHead` hazard again. Check `f"a{x}"` against `f"b{x}"`.
- How many import cycles does the sample have at file and directory granularity? How many survive once `if TYPE_CHECKING:` imports are dropped? How many once function-body imports are dropped (D8)?

### Task 1.2: Python resolver check

**Files:**
- Create: `prototypes/python-resolve.ts`

Write the D7 resolver as a prototype. Cover `pyproject.toml` roots, the `src/` layout, relative imports, `__init__.py` and namespace packages. Compare its edges against grimp on the same sample. Record every disagreement and its cause. This is the only place grimp is used.

### Task 1.3: Go baseline

**Files:**
- Create: `prototypes/go-baseline.ts`

Same steps as Task 1.1, with the tree-sitter Go grammar. The rewrite uses `go/ast` (D4), but token streams from both parsers are close enough to answer these questions:

- How many of the top 40 are `if err != nil { return …, err }`? The answer decides D9.
- Do keyed struct literals need to be name holders? Count the findings whose copies differ only in field keys.
- What does propagation cost look like on the sample at package granularity (D6)? Does it separate well-layered packages from coupled ones?

### Task 1.4: tree-sitter without cgo

**Files:**
- Create: `prototypes/wazero-tree-sitter/` (a small Go program)

Parse one Python file in Go through the WASM grammar under `wazero`. Record whether it works, the parse time against `web-tree-sitter`, and the binary size. If it fails, record what a cgo build would cost the cross-build matrix.

### Task 1.5: Write up the measurements

**Files:**
- Modify: `docs/PRD.md` (new section on multi-language support)

Record the numbers that justify each Phase 2 to 4 decision. Anonymize per AGENTS.md §6. Keep only the figures that justify a decision.

**Decision gate:** If the baseline top 40 for a language is mostly actionable with a small idiom list, it goes into the rewrite. If it is mostly noise that no rule separates, stop and report that.

---

## Phases 2 to 4: Design for the Go rewrite

These phases are not built in TypeScript (D1). They record the design so the rewrite starts from decisions, not from questions. File paths name responsibilities, not final Go package paths.

## Phase 2: Shared frontend plumbing

### Task 2.1: Python syntax layer

1. Wrap tree-sitter behind the same `walk` contract `src/extract/traverse.ts` provides. Fragment extraction then stays one function.
2. Include anonymous nodes that carry text a fragment depends on. An operator such as `+` against `-` must change L0. Write the test first.
3. Locate the grammar from the executable's own path, then fall back. Mirror `tsgo-path.ts`, including the fallthrough order.
4. Pin the grammar version exactly and add it to the config hash.

### Task 2.2: Language selection and the merged report

1. Discovery runs every frontend's `discover` over the directory. A repository with `pyproject.toml` and `tsconfig.json` yields both.
2. Add `--language <id>`, repeatable, to restrict analysis. It joins the config hash.
3. `--config <tsconfig>` keeps working and implies `--language typescript`.
4. Sort discovered projects with the ordering rule from AGENTS.md §1. Test it with adversarial data.
5. Emit one report (D3). Every finding names its language. Findings from all languages share the slot budget, ranked on the same arithmetic.

## Phase 3: Python

### Task 3.1: Python profile

Fill every `LanguageProfile` method. Pass every golden-file case. Expected answers, to be confirmed by Task 1.1:

- **Test paths:** `test_*.py`, `*_test.py`, `tests/`, `conftest.py`.
- **Name holders:** `keyword_argument`, `pair` keys in dict literals, class-body assignments.
- **Literals:** `string` including f-string content, `integer`, `float`, `true`, `false`, `none`. Apply the keyword-position rule from `callsite.ts`: `None` as a keyword argument value is data. `None` inside an expression is not.
- **Type declarations:** classes decorated `@dataclass`, and classes deriving `TypedDict`, `NamedTuple`, `Protocol` or `BaseModel`.
- **Generated code:** `_pb2.py` banners. Confirm the existing sniff catches them.

### Task 3.2: Python import resolution

Port the Task 1.2 resolver (D7).

1. Find import roots from `pyproject.toml`, a `src/` layout, or the repository root.
2. Resolve absolute and relative imports to repo-relative files. Handle `__init__.py` and namespace packages.
3. Resolve every import before any walk runs. Import lookup during a walk stays synchronous and fails loudly on an unresolved specifier (AGENTS.md §2).
4. An import of a third-party package resolves to nothing and is not an edge.

### Task 3.3: Python edge kinds

| Python form | Fails at module load? | Maps to |
|---|---|---|
| Top-level `import x` | Yes | runtime edge |
| Inside `if TYPE_CHECKING:` | No, never executed | `erased`, as `import type` today |
| Inside a function body | No, deferred | `deferred` (D8) |

The edge label prints `deferred` beside `type` only when it is non-zero. The cycle section reports a third component count, with deferred edges dropped, only when it differs from the runtime count.

An `__init__.py` that only re-exports fills `reexportsOf`. The dissolve rule applies as written: dissolve only when the origin lives in another module.

## Phase 4: Go

### Task 4.1: Go profile

Fill every method against `go/ast` node types. Pass every golden-file case. Expected answers, to be confirmed by Task 1.3:

- **Test paths:** `_test.go`, `testdata/`.
- **Name holders:** `KeyValueExpr` keys in composite literals, struct `Field` names, interface method names.
- **Type declarations:** `TypeSpec` with a `StructType` or `InterfaceType`.
- **Ignored kinds:** `ImportSpec`, the package clause, `FieldList` in parameter position.
- **Generated code:** the existing banner sniff already matches `// Code generated … DO NOT EDIT.` Add a golden-file case to prove it.

### Task 4.2: The `if err != nil` idiom

Build this only if Task 1.3 shows the idiom crowding the top 40 (D9). If built, it is on by default. `--include-go-idioms` turns it off (AGENTS.md §4b). It joins the config hash. The Omitted preamble names it as the mechanism and counts only removed findings that would have reached a printed slot.

### Task 4.3: Go module graph

1. Read the module path and `replace` directives from `go.mod`. Read `go.work` if present (D5).
2. An import path under the module path maps to a directory. That directory is the package.
3. `symbols` counts selector uses of the imported package in the file. `erased` is always 0. `reexportsOf` is always empty.
4. Build constraints (`//go:build`, `_linux.go` suffixes) are ignored for v1, so every file is analyzed. The report says so in one line.

### Task 4.4: Coupling in place of cycles

The cycle section for Go is replaced (D6):

- One line states that Go forbids import cycles between packages.
- Propagation cost at package granularity, from `src/graph/metrics.ts`.
- The most depended-on packages, with direct and transitive dependent counts.

Never print an empty section with no explanation.

---

## Out of scope

- Languages beyond Python and Go.
- Python and Go frontends in the TypeScript codebase (D1).
- Type information for Python. tree-sitter has none. Any rule that needs a type stays TypeScript-only, and the profile says so.
- Cross-language duplication. Namespaced kinds make it impossible by construction.
- L3 MinHash for new languages. It inherits whatever L3 does for TypeScript.

## Risks

- **Silent gaps in a profile.** A missing name holder or literal kind does not error. It produces confident wrong output. The golden-file contract is the main defense. Each new language needs its own adversarial cases as well.
- **Idiom filters as tuning to one repository.** Base each filter on a language-wide convention, not on one sample. AGENTS.md §4 makes the same point about banners against filename lists.
- **Hand-written resolvers drift from the real toolchain.** D5 and D7 trade exactness for determinism. Task 1.2 measures the gap for Python. Go build constraints are a known gap (Task 4.3).
- **The rewrite depends on TypeScript 7.1.** If the Go API slips or ships without what thicket needs, D1 needs revisiting. Phases 0 and 1 are useful either way.
