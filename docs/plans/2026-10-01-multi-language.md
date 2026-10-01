# Multi-Language Support Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Analyze Go and Python repositories. Keep one shared core for clustering, the module graph, ranking, the cache and the report.

**Architecture:** Each language gets a **frontend** and a **profile**. The frontend parses files and resolves imports. The profile holds the rules that today name TypeScript syntax kinds directly. TypeScript keeps tsgo. Go and Python use tree-sitter for syntax and their native toolchains for imports.

**Read first:** `docs/PRD.md` §2.3, §4.1 and §5. AGENTS.md §1, §3, §4, §4b, §5 and §7. Most of the work in this plan is re-deriving AGENTS.md §4 for each new language.

**Status:** Proposal. Phase 0 is a refactor with no behavior change and is worth doing on its own. Phases 2 to 4 depend on the measurements in Phase 1.

---

## 1. Why this is mostly a heuristics problem

Parsing a new language is cheap. The hard part is the rules that make the report short enough to act on.

### 1.1 What is already language-neutral

- **The module graph.** `src/graph/build.ts` reads only `Project.files()`, `importDetailsOf()` and `reexportsOf()`. Tarjan, grouping, cuts and dissolves never see an AST. A frontend that fills in `ImportDetail` gets the tangle section with no changes.
- **Clustering and the cache.** Everything after `shapeFragments` sees a `ShapedFragment`. That is a kind string, a node count, a span and two hashes. `alphaRename` works on `Id:` tokens and does not care which language produced them.
- **Ranking arithmetic.** `recoverableLines`, the copy cap, spread and subsumption use only spans, paths and counts.

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
| tree-sitter via `web-tree-sitter` | A concrete syntax tree for almost every language, with named fields. Grammars ship `tags.scm` and `locals.scm` queries for definitions and scopes. WASM, so no native addon. | **Use for Go and Python syntax.** |
| `@ast-grep/napi` | tree-sitter plus a pattern language. | Rejected. A native addon complicates `bun build --compile`. Revisit only for writing idiom rules. |
| SCIP indexers (`scip-go`, `scip-python`) | Symbols, definitions and references in one standard format. | Deferred. Too heavy a step to run each loop iteration. Revisit if re-export origins matter for Python. |
| Language servers (gopls, pyright) | Definitions and references over LSP. | Rejected. Slow and stateful for a tool that runs in a loop. |
| Native toolchains | `go list -deps -json` returns the exact package graph. CPython `ast` and `grimp` handle Python. | **Use for imports** where the toolchain is exact. |
| Universal ASTs (Babelfish UAST, srcML, GitHub Semantic) | One schema for every language. | Rejected. Babelfish and Semantic are abandoned. A single schema erases the per-language detail the profile rules need. |
| tree-sitter for TypeScript too | One parser everywhere. | Rejected. PRD §2.3 still holds. It would also lose type-only edges and re-export origins. |

No maintained standard for a language-agnostic AST exists. tree-sitter is the common denominator.

### 2.2 Consequences for distribution and determinism

- **The grammars ship as files.** Each `.wasm` grammar sits beside the binary, the same way tsgo's `lib.*.d.ts` files do. AGENTS.md §7 applies in full. The `package` CI job must run a Go and a Python report from an extracted artifact with no `node_modules`.
- **Grammar versions join the config hash.** A new grammar can change the tree, so it can change the report (AGENTS.md §5).
- **External toolchain versions join the config hash.** If imports come from `go list`, the Go version is an input to the report. Record it in the hash and print it in the report header.
- **A missing toolchain degrades, and says so.** With no `go` on `PATH`, fall back to a tree-sitter import scan and report that the graph is approximate. Never fail the whole report.

---

## 3. Target interfaces

These are sketches. Phase 0 discovers the real shape.

```ts
/** One per language. Owns all contact with that language's parser and toolchain. */
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

- **Kinds are namespaced strings**, as `go:call_expression`. A Go kind and a TypeScript kind must never hash the same by accident. Mixed-language repos then cluster correctly without a special case.
- **TypeScript keeps matching by enum value inside its profile.** The `SyntaxKind` alias hazard (AGENTS.md §3) stays sealed in the TypeScript profile. Nothing outside it sees a numeric kind.

`Project` stays as it is. `ImportDetail.erased` and `erasable` gain a per-language meaning, defined in Phases 3 and 4.

---

## Phase 0: Seal TypeScript syntax behind a profile

No behavior change. The determinism job and every reference report stay byte-identical.

### Task 0.1: Extract the TypeScript profile

**Files:**
- Create: `src/lang/typescript/profile.ts`
- Modify: `src/fingerprint/fragments.ts`, `src/report/kinds.ts`, `src/report/callsite.ts`, `src/report/variation.ts`, `src/report/rank.ts`, `src/report/markdown.ts`

**Steps:**
1. Move `IGNORED_KINDS`, `LITERAL_KINDS`, `NAME_HOLDERS`, the type-declaration kinds, `TEST_PATTERN` and the fence map into the profile. Move the comments that justify them too.
2. Thread the profile through to each caller. Pass it as an argument. Do not import it as a module singleton, or Phase 2 has to undo that.
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

### Task 0.3: Write the profile contract test

**Files:**
- Create: `tests/lang/profile-contract.test.ts`

One parameterized suite that every profile must pass. Each case names the AGENTS.md §4 lesson it guards. Examples:

- A field name is a name holder. Two shapes that differ only in field names report drift.
- A literal's value enters the L0 stream. `f(2)` and `f(3)` differ at L0.
- Template and interpolated string content enters the L0 stream.
- A single call to a shared helper is a bare call. A call with a body argument is not.
- A test file is recognized by its path, and `latest/attest.<ext>` is not.

Delete each guard once in the TypeScript profile and watch its case fail.

---

## Phase 1: Measure before designing

Prototype scripts only, in `prototypes/`. They are not the implementation. Every later decision cites a number from here, as the PRD does.

### Task 1.1: Go baseline

**Files:**
- Create: `prototypes/go-baseline.ts`

**Steps:**
1. Parse a sample Go repository with `web-tree-sitter` and the Go grammar.
2. Emit L0 and L1 token streams with no profile rules at all. Named nodes become kinds. Identifiers and literals follow the current `Id:` and literal token forms.
3. Feed `clusterFragments` and the ranker. Record the top 40 findings.
4. Classify each finding as actionable, idiom, or noise. Record the counts.

**Questions to answer:**
- How many of the top 40 are `if err != nil { return …, err }`? This is the expected analog of the old `ImportDeclaration` flood.
- Do keyed struct literals need to be name holders? Count the findings whose copies differ only in field keys.
- What does `go list -deps -json` cost per run on the sample? Is it fast enough to run every loop iteration?

### Task 1.2: Python baseline

**Files:**
- Create: `prototypes/python-baseline.ts`

Same steps as Task 1.1, with the Python grammar.

**Questions to answer:**
- How often does `self.x = x` in `__init__` reach the top 40?
- Do f-string contents reach the token stream? This is the `TemplateHead` hazard again. Check it explicitly with `f"a{x}"` against `f"b{x}"`.
- How many import cycles does a sample repository have at file and directory granularity? How many survive once `if TYPE_CHECKING:` imports are dropped?
- Is a hand-written resolver over `pyproject.toml` and the `src/` layout accurate enough? Compare its edges against `grimp` on the same repository.

### Task 1.3: Write up the measurements

**Files:**
- Modify: `docs/PRD.md` (new section on multi-language support)

Record the numbers that justify each Phase 2 to 4 decision. Anonymize per AGENTS.md §6. Keep only the figures that justify a decision.

**Decision gate:** If the baseline top 40 for a language is mostly actionable with a small idiom list, proceed. If it is mostly noise that no rule separates, stop and report that before building more.

---

## Phase 2: A tree-sitter frontend

### Task 2.1: Shared tree-sitter syntax layer

**Files:**
- Create: `src/lang/tree-sitter/syntax.ts`, `src/lang/tree-sitter/grammars.ts`
- Modify: `package.json`, `scripts/build-binary.ts`, `scripts/build-npm.ts`

**Steps:**
1. Wrap `web-tree-sitter` behind the same `walk` contract `src/extract/traverse.ts` provides. Fragment extraction then stays one function.
2. Include anonymous nodes that carry text a fragment depends on. An operator such as `+` against `-` must change L0. Write the test first.
3. Locate grammars from `process.execPath`, then fall back to `node_modules`. Mirror `tsgo-path.ts`, including the fallthrough order.
4. Add grammar versions to the config hash.
5. Pin grammar package versions exactly.

**Verify:** A unit test that parses one file per language and asserts a specific token stream. The `package` CI job renders a report from the extracted artifact.

### Task 2.2: Language selection

**Files:**
- Modify: `src/cli.ts`, `src/run.ts`
- Create: `src/lang/registry.ts`

**Steps:**
1. Discovery runs every frontend's `discover` over the directory. A repository with `go.mod` and `tsconfig.json` yields both.
2. Add `--language <id>`, repeatable, to restrict analysis. It joins the config hash.
3. Keep `--config <tsconfig>` working unchanged. It implies `--language typescript`.
4. Sort discovered projects with `compareStrings`. Test the order with `ORDERING_PROBE`-style data.

**Open question:** Does a mixed-language repository produce one report or one per language? One report is simpler for the agent. Cross-language cycles cannot exist, so the tangle sections merge cleanly. Decide in this task.

---

## Phase 3: Go

### Task 3.1: Go profile

**Files:**
- Create: `src/lang/go/profile.ts`, `tests/fixtures/go-basic/`

Fill every `LanguageProfile` method. Pass the contract test from Task 0.3. Expected answers, to be confirmed by Phase 1:

- **Test paths:** `_test.go`, `testdata/`.
- **Name holders:** `keyed_element`, `field_declaration`, `method_spec`.
- **Type declarations:** `type_spec` with struct or interface bodies.
- **Ignored kinds:** `import_declaration`, `package_clause`, parameter lists.
- **Generated code:** the existing banner sniff already matches `// Code generated … DO NOT EDIT.` Add a fixture to prove it.

### Task 3.2: The `if err != nil` idiom

**Files:**
- Modify: `src/lang/go/profile.ts`, `src/cli.ts`

Suppress the error-return idiom only if Phase 1 shows it floods the report. It gets its own off switch, as `--include-go-idioms` (AGENTS.md §4b). It joins the config hash. The Omitted preamble names it as the mechanism, and counts only removed findings that would have reached a printed slot.

### Task 3.3: Go module graph

**Files:**
- Create: `src/lang/go/project.ts`

**Steps:**
1. Run `go list -deps -json ./...` and build `ImportDetail` per file.
2. `symbols` counts selector uses of the imported package in the file. `erased` is always 0. Go has no type-only imports.
3. `reexportsOf` returns empty. Go has no re-exports.
4. Record the Go version in the config hash and the report header.

**The cycle section changes meaning for Go.** The compiler forbids import cycles between packages. Files inside a package share one namespace, so file-level cycles do not exist either. The tangle section will be empty at every granularity. Decide in this task whether to:

- omit the section for Go and say why in one line, or
- replace it with a coupling measure, such as propagation cost, which `src/graph/metrics.ts` already computes.

Do not print an empty section with no explanation. A reader takes it as "no problem found".

---

## Phase 4: Python

### Task 4.1: Python profile

**Files:**
- Create: `src/lang/python/profile.ts`, `tests/fixtures/python-basic/`

Fill every method. Pass the contract test. Expected answers:

- **Test paths:** `test_*.py`, `*_test.py`, `tests/`, `conftest.py`.
- **Name holders:** `keyword_argument`, `pair` keys in dict literals, class-body assignments.
- **Literals:** `string` including f-string content, `integer`, `float`, `true`, `false`, `none`. Apply the keyword-position rule from `callsite.ts`: `None` as a keyword argument value is data. `None` inside an expression is not.
- **Type declarations:** classes decorated `@dataclass`, and classes deriving `TypedDict`, `NamedTuple`, `Protocol` or `BaseModel`.
- **Generated code:** `_pb2.py` banners. Confirm the existing sniff catches them.

### Task 4.2: Python import resolution

**Files:**
- Create: `src/lang/python/project.ts`, `src/lang/python/resolve.ts`

**Steps:**
1. Find import roots from `pyproject.toml`, a `src/` layout, or the repository root.
2. Resolve absolute and relative imports to repo-relative files. Handle `__init__.py` and namespace packages.
3. Resolve every import before any walk runs. `resolveImport` stays synchronous and throws on an unresolved specifier (AGENTS.md §2).
4. An import of a third-party package resolves to nothing and is not an edge.

### Task 4.3: Python edge kinds

**Files:**
- Modify: `src/lang/python/project.ts`

Python has three kinds of import, and they map onto existing fields:

| Python form | Fails at module init? | Maps to |
|---|---|---|
| Top-level `import x` | Yes | runtime edge |
| Inside `if TYPE_CHECKING:` | No, never executed | `erased`, as `import type` today |
| Inside a function body | No, deferred | **new field needed** |

The deferred case is new. It is a runtime dependency that cannot fail at init. Do not fold it into `erased`, or a reader is told the edge vanishes at runtime when it does not. Add a field, name it for what it holds, and print it only when it changes a number.

`reexportsOf` covers an `__init__.py` that only re-exports. The dissolve rule applies as written: dissolve only when the origin lives in another module.

---

## Out of scope

- Languages beyond Go and Python.
- Type information for Go or Python. tree-sitter has none. Any rule that needs a type stays TypeScript-only, and the profile says so.
- Cross-language duplication. Namespaced kinds make it impossible by construction.
- L3 MinHash for new languages. It inherits whatever L3 does for TypeScript.

## Risks

- **Silent gaps in a profile.** A missing name holder or literal kind does not error. It produces confident wrong output. The contract test in Task 0.3 is the main defense. Each new language needs its own adversarial fixture as well.
- **Idiom filters as tuning to one repository.** Base each filter on a language-wide convention, not on one sample. AGENTS.md §4 makes the same point about banners against filename lists.
- **Distribution weight.** Each grammar adds a WASM file per platform. Measure the artifact size in Task 2.1.
- **Toolchain drift.** A user's Go version changes the import graph. The config hash and the report header make that visible.
