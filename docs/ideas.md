# Ideas for new findings

This is a list of candidate findings beyond duplication and import cycles. Each
entry says what it reports, what existing data it reuses, and how to tell
whether it is worth shipping. None of them is built.

AGENTS.md §4 sets the bar. Ranking is the product, and the report already has
more candidates than slots. A new finding earns a place only when judges prefer
it to what it would displace, or when it gets its own section because it is a
different kind of work.

## How every idea is evaluated

Each idea goes through the same four steps. This is the process the near-copy
work used (`docs/plans/2026-11-04-near-miss.md`).

1. **Prototype outside `src/`.** Write a script in `prototypes/` that runs the
   real extraction code under Bun. It writes candidates as judging samples. It
   changes nothing in the report.
2. **Run it on at least two real repositories.** Use the anonymized samples
   from the PRD. One small repository hides problems that scale exposes.
   Union-find over near pairs looked fine on small inputs and put 26,318
   shapes in one group
   on Sample D.
3. **Judge blind.** A subagent judge gets a neutral brief, the code, and the
   candidate. It does not see which candidates are controls, or what the
   prototype scored. Mix in controls that should fail. A second judge rates a
   fifth of the items again, and the two should agree within one point.
4. **Judge the shipped output again.** The prototype for near copies measured
   70% useful. Judging the real pipeline found five bugs the prototype could not
   show.

Each entry below names the question the judge answers, the controls, and the
bar to pass. Two more rules apply to all of them:

- **Check showing and scoring separately.** A signal can be worth printing and
  not worth ranking on. Near copies are printed and do not move the score.
- **Every opinion gets its own off switch** (AGENTS.md §4b). Anything that
  changes the finding set also joins the config hash.

## Placement: where shared code should live

Two ideas share one search, so they share one plan:
`docs/plans/2026-11-11-placement.md`.

### 1. Where to put an extracted duplicate

A finding says "these copies are the same". It does not say where the shared
version should go. The import graph can answer that.

- **What it reports.** A home for the extracted code, which every copy's file
  can import without creating a cycle. The report prefers a file the copies
  already import. When no existing file works, it names a new file in the
  copies' common directory.
- **What it reuses.** Printed findings, `FindingContext.sharedImports`, the
  file import graph, and Tarjan SCC from `src/graph/metrics.ts`.
- **What is new.** It needs the imports each copy uses, which is narrower than
  the imports of its file. That comes from the identifiers in the copy and the
  file's import bindings.
- **Why it matters.** A naive extraction can deepen a cycle. In the tour sample,
  `orders/total.ts` already imports `invoice/total.ts`. So putting `orderTotal`
  in either file is not neutral.
- **PRD link.** PRD §7.4, "the join", is the same idea for the case where the
  copies are in a cycle. Step 8 of the PRD §12 roadmap names it as the next
  feature.
- **Judge question.** "An agent must extract this finding. Here is the home
  thicket suggests. Would you put the shared code there? Answer yes, acceptable,
  or no, and say where you would put it instead."
- **Controls.** Homes chosen by a naive rule: the first copy's file, or the
  alphabetically first shared import.
- **Bar.** The suggestion beats both controls, and at least 70% of suggestions
  rate yes or acceptable.

### 2. Move a symbol instead of cutting an edge

A suggested cut today names the edge to remove. The reader still has to decide
where the symbol goes.

- **What it reports.** For the symbols on a suggested cut, a module they can
  move to that leaves no cycle. For the tour sample this is "move
  `formatMoney` from `reports/rows.ts` to a new file that both files import."
- **What it reuses.** The cut chooser in `src/run.ts`, `ModuleEdge`, and the
  search from idea 1. The users are the files importing the symbol. The
  dependencies are what the symbol's declaration uses.
- **Judge question.** The same as idea 1, asked about a cut.
- **Controls.** "Move it to the importer's module", which is the obvious answer
  and often wrong.
- **Bar.** The same as idea 1. Also, no suggested move may recreate any cycle.
  A test can check that rule mechanically.

## Duplication, read more closely

### 3. A copy that has a fix the others lack

A near copy that differs by one inserted guard is often a bug fix that reached
one copy. The tour's `reportTotal` is this shape: it adds
`if (row.qty === 0) continue;`.

- **What it reports.** Flags a near copy whose difference from its finding is
  an inserted guard, early return, null check, or `try`. Names the copies that
  lack it.
- **What it reuses.** Sketches, `attachNear` in `src/fingerprint/near.ts`, and
  the per-copy comparison in `src/report/variation.ts`. The new part classifies
  the difference.
- **Judge question.** "Does the extra code in this copy fix a problem the other
  copies still have?" Answer yes, no, or can't tell.
- **Controls.** Near copies whose difference is not a guard, and pairs where the
  guard is in the finding rather than the near copy.
- **Bar.** Judges answer yes for clearly more of the flagged copies than the
  controls. This flag points at a possible bug, so precision matters more than
  recall. Aim for 50% yes before printing it.

### 4. Near-identical types

Exact type duplication has its own section. A second interface often starts as
a copy with one optional field added, and an exact hash misses that.

- **What it reports.** Near copies on type findings, as near copies already
  appear on code findings.
- **What it reuses.** Sketches and `attachNear`. The type section is already
  computed.
- **Risk.** Phase 0 of the near-miss work found that `PropertySignature` near
  copies scored 0 of 38. A type made of property signatures may need a
  different gate than a code fragment does.
- **Judge question.** "Should these two types be one type, or one derived from
  the other?"
- **Controls.** Pairs of types from unrelated domains that happen to have the
  same field count.
- **Bar.** 70%, the same bar near copies of code met.

### 5. Repeated magic values

The L0 token stream keeps literal text. A string such as `"pending"` that
appears in 30 files across 8 modules is a missing constant or enum.

- **What it reports.** Literal values that repeat across modules, ranked by
  spread rather than by raw count.
- **What it reuses.** L0 token streams and the file-to-module map.
- **Risk.** Many repeated literals are harmless. Examples are `0`, `""`, HTTP
  status codes, and test data. The gates need to be measured.
- **Judge question.** "Should this value be one named constant?"
- **Controls.** Literals that repeat inside one module only.
- **Bar.** Judges prefer the top entries to the duplication findings they would
  displace. If they do not, it gets its own section with a small cap, or it is
  dropped.

### 6. Pass-through functions

A function whose whole body forwards to one call with the same arguments adds a
name and adds nothing else.

- **What it reports.** Wrappers that only forward, with their call counts.
- **What it reuses.** The `isBareCall` logic in `src/report/callsite.ts`
  already recognizes the shape at call sites.
- **Risk.** Some wrappers exist on purpose, at a package boundary or to narrow
  a type. This needs its own off switch.
- **Judge question.** "Would inlining this wrapper make the code simpler?"
- **Controls.** Wrappers that change a type or a default argument.
- **Bar.** 60% yes. Below that it adds reading work without adding value.

## Structure

### 7. Split a module by who uses which exports

A module with many importers sometimes serves several groups that use disjoint
sets of its exports. That is several modules sharing one file.

- **What it reports.** "`utils.ts`: 3 groups of importers use disjoint exports.
  Splitting it removes N edges." It also reports whether a cycle passes through
  the module.
- **What it reuses.** The import graph. The adapter already resolves every
  import site and collects binding names. `importDetailsOf` keeps only counts
  today, so it would need to return the names.
- **Judge question.** "Should this file be split along these lines?"
- **Controls.** Large modules whose importers overlap heavily.
- **Bar.** 60% yes, and each suggested split leaves no group importing from two
  of the new files.

### 8. Merge or extract between two modules

Two modules that import each other and share several duplication findings are
probably one concept split in two. This is PRD §7.4 from the module side.

- **What it reports.** The pair, the findings they share, and a choice between
  merging them and extracting the shared part. Idea 1 picks where the shared
  part goes.
- **What it reuses.** Cycles, findings, and the file-to-module map. Both facts
  are already computed. Nothing joins them yet.
- **Judge question.** "Is this one concept split in two?"
- **Controls.** Module pairs in a cycle that share no findings.
- **Bar.** 60% yes.

### 9. A template for files that repeat each other

The containment relation already notices sibling files that repeat the same
shapes. When that covers most of a directory, the finding is "these N files
should come from one base class or one generator".

- **What it reports.** A directory-level finding that replaces the per-shape
  findings it explains.
- **What it reuses.** The pass in `src/report/variants.ts` that links findings
  whose file sets nest.
- **Judge question.** "Should these files share a base or come from a
  generator?"
- **Controls.** Directories where only one shape repeats.
- **Bar.** Judges prefer the directory finding to the individual findings it
  replaces, in a side-by-side comparison.

### 10. Modules no test reaches

Follow import edges from every test file. A production module that no test
reaches, even through other modules, has no test coverage of any kind.

- **What it reports.** Untested modules, ranked by how many modules depend on
  them.
- **What it reuses.** The file-role rules that pick out tests, and the import
  graph.
- **Risk.** Reached is not tested. A module can be imported by a test and never
  run. This is a floor on what is untested, and the report must say so.
- **Judge question.** "Is the lack of tests here a real gap?"
- **Bar.** 60% yes on the top entries.

### 11. Hub modules

These are modules with both high fan-in and high fan-out. PRD §7.3 lists hubs,
hinges, and instability. `src/graph/metrics.ts` already computes propagation
cost.

- **Risk.** This is the idea most likely to be noise. Any large application has
  a few modules that everything touches, and most of them are fine.
- **Judge question.** "Should this module be split or narrowed?"
- **Bar.** Build it only if idea 7 does not already cover the useful cases.

## Already planned in the PRD

PRD §6 lists simplification checks, and step 9 of the §12 roadmap starts them
with always-same-argument parameters. They need the type checker across call
sites.
They are a different family from everything above, which reuses data thicket
already has. Those checks are constant conditions, parameters that always get
the same argument, optional parameters that are never undefined, dead exports,
and repeated guard conditions.

Dead exports need extra care. Public entry points make "nothing imports this"
a guess. So the check needs an off switch and a judged run before it ships.

## Considered and set aside

- **Co-change from git history.** It is a strong signal in published research.
  But the report must be a pure function of source, config, and version
  (AGENTS.md §1). Using git history would need a PRD decision and an opt-in
  flag.
- **Cyclomatic complexity and long functions.** These are cheap to compute and
  linters already report them. They fail the AGENTS.md §4 test: the ranker
  already discards good candidates, so a common metric does not earn a slot.
