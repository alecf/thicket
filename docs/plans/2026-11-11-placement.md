# Placement: where shared code should live

## Goal

thicket tells a reader what to consolidate. It does not say where the result
should go. Two places in the report leave that question open:

1. **A duplication finding.** "These 3 copies are the same" leaves the reader
   to pick a file for the shared version.
2. **A suggested cut.** "Remove `invoice/total.ts → reports/rows.ts`" leaves
   the reader to decide where `formatMoney` goes.

Both are one question. Given the files that will use some code and the files
that code needs, which file can hold it without creating an import cycle?
This plan answers that question once and uses the answer in both places.

This is step 8 of the PRD §12 roadmap, "the dup × tangle join", made
general. PRD §7.4 describes the case where the copies sit inside a cycle.
The same search covers copies that sit outside one.

## What already exists

- **`FindingContext.sharedImports`** in `src/report/context.ts` lists the files
  every copy imports, if they are distinctive to the cluster. Its comment calls
  them "where an extraction would go". It does not check for cycles.
- **The cut chooser** in `src/run.ts` picks the edge whose removal leaves the
  smallest tangle. It names the edge and the import sites. It does not say
  where the symbols go.
- **The adapter** collects the names each import binds, in
  `bindingCountsBySpecifier`. `importDetailsOf` keeps only the counts.
- **Tarjan SCC** in `src/graph/metrics.ts`, and the module map from
  `buildModuleGraph`.

## The search

The prototype is `prototypes/placement.ts`. It works in four steps.

1. **Users and dependencies.** For an extraction, the users are the files that
   hold a copy. The dependencies are the files whose bindings the copies use.
   They come from the identifiers inside each copy, matched against the file's
   import bindings. For a cut, every symbol on the cut edge moves together. The
   users are every file that imports one of them, plus the owner if it still
   calls them.
2. **Candidate homes.**
   - **shared**: a file in `sharedImports`, or the file a shim there forwards
     to.
   - **dependency**: a file the code already needs.
   - **user**: one of the files that holds a copy, or imports the symbol.
   - **new**: a new file in the users' deepest common directory.
3. **Edges after the move.** Each user imports the home. The home imports each
   dependency. A user drops an import when every binding it takes from that
   file is code that moves.
4. **Ranking.** In order:
   1. **Safe first.** A home is unsafe if any file or module is newly in a
      cycle, or is in a larger cycle than before. Both file and module
      graphs are checked.
   2. **No misfits.** Runtime code does not go in a file that declares only
      types. A type does not go in a file of runtime code.
   3. **Most freed.** Modules, then files, that are no longer in any cycle.
   4. **Fewest new edges inside a cycle.** An edge between two files already in
      one cycle does not grow it, but it adds one more strand to cut later.
   5. **Fewest new dependencies between existing modules.** A new file is its
      own module, or joins its directory's module, so it adds none of these.
   6. Then the kind of home in the order above, then the fewest added edges,
      then the path.

### Known limits of the prototype

- Identifiers are matched by name. A local that shadows an import makes a
  dependency look real when it is not. A property access with the same name
  as an import does the same.
- A copy that uses a helper declared beside it is recorded, not solved. The
  real extraction moves the helper too, or imports it.
- A cut that crosses through a namespace import or a re-export has no single
  declaration to move. The prototype reports it as unplaced.
- A new file is named `shared.ts`, or after the moved symbol. A good name is
  the reader's call.

## Phase 0 results so far

### Tour sample

`site/tour/sample` has 3 production findings and 1 cut.

| Item | Suggested home | Why |
|---|---|---|
| `orderTotal`, exact copies | `src/invoice/total.ts` | `orders/total.ts` already imports it. No new edge. |
| `orderTotal` and its renamed copies | new `src/shared.ts` | Every existing file would add a new module dependency, such as `cart → invoice`. |
| `LineItem` and `CartLine` | new `src/shared.ts` | Either types file would make the other domain depend on it. |
| Cut `invoice/total.ts → reports/rows.ts` | `formatMoney` moves to `src/invoice/total.ts`, its only user | The ring of 3 files is gone. |

### Fixtures

- **`tests/fixtures/census`.** Moving `formatInvoiceId` into `src/order.ts`, its
  only user, removes the 2-file cycle. A new file was correctly flagged unsafe
  for the duplicated function. That code needs `order.ts`, which also holds a
  copy, so the new file and `order.ts` would import each other.
- **`tests/fixtures/tangle`.** Moving `beta1`, `beta2` and `beta3` one at a time
  freed nothing, because `alpha` still imported the other two. Moving every
  symbol on the cut together frees a module. The prototype now does that.

### thicket's own source

40 analyzed files, 2 findings. Each pick is safe. One finding is 5 copies of a
"push onto a list in a map" block, spread over `fingerprint/` and `report/`.
Before `sharedImports` was used, the prototype picked `src/order.ts`, because
every copy's file imports it for `compareStrings`. The copies do not use it.
Now it picks `fingerprint/cluster.ts`, which is safe by the graph. A person
would likely write a small utility file instead. That is the main open question
below.

## Phase 0: judge it on real repositories

Run the prototype on the two large private samples:

```bash
bun prototypes/placement.ts /path/to/repo /tmp/placement-out
```

It writes `placements.jsonl`: one line per finding or cut, with the code, the
users, the dependencies, the suggestion, the controls, and five alternatives.

### What to measure without judges

- **How often the naive home is unsafe.** The naive home is the first copy's
  file. If it is almost never unsafe, the cycle check is not what makes
  placement useful, and the feature rests on the misfit and dependency rules
  alone.
- **How often the best home frees a cycle.** This is PRD §7.4's claim. If it is
  near zero, the join is rarer in practice than the PRD expects.
- **How often a copy uses a helper beside it.** If it is common, the extraction
  is larger than the finding says, and the report should name the helper.
- **How many cuts cannot be placed**, because they cross a re-export or a
  namespace import.

### Judging

Use blind subagent judges, as for near copies.

- **The question.** "An agent must extract this code. Here is where thicket
  suggests putting it, and what it would import. Would you put the shared code
  there? Answer yes, acceptable, or no. If no, say where."
- **Hidden key.** Each item shows one home. It is either the suggestion or a
  control, at random. The judge does not know which.
- **Controls.**
  - **First copy**: the first copy's file.
  - **First shared import**: the first file in `sharedImports`, which is what a
    reader of today's report would reach for.
  - **For cuts, the importer**: the module on the `from` side of the cut.
- **Two orderings.** Ordering A is the one above. Ordering B prefers a new file
  over a user's file when the code needs no imports. The "push onto a list"
  finding is the case that separates them. Judge both, and keep the one judges
  prefer.
- **Sample size.** 40 items per sample, per arm. A second judge rates a fifth of
  them again.

### Bar

- The suggestion is rated yes or acceptable at least 70% of the time. That is
  the bar near copies met.
- It beats each control by at least 15 points.
- No suggested home recreates a cycle. This rule needs no judge. A test can
  check it on every fixture.

If the suggestion clears the bar for cuts but not for extractions, ship it for
cuts only. The cut case has a clearer right answer, because the move has to
remove an edge.

## Phase 1: in the core

Only if Phase 0 clears the bar.

1. **Adapter.** Add `bindingsOf(file)`, which returns each import binding's
   local name, exported name, target and type-only flag. The data already
   exists in `bindingCountsBySpecifier`. Keep it inside `src/extract/`
   (AGENTS.md §2).
2. **Placement module.** `src/graph/placement.ts`, with the search above. It
   takes the file edges, the module map and the bindings, and returns ranked
   homes. It has unit tests on hand-written graphs, including a case where
   every home but a new file is unsafe.
3. **Duplication findings.** A new line under each finding:
   `- **extract to:** src/shared.ts (new file; adds no cycle)`. The JSON gets a
   `home` field.
4. **Cuts.** A new line under each cut:
   `- **move to:** formatMoney → src/invoice/total.ts (its only user)`. The
   JSON gets a `move` field.
5. **Off switch.** `--no-placement` (AGENTS.md §4b). The setting joins the
   config hash, because it changes the report.
6. **Determinism.** Every candidate list is sorted with `compareStrings`, and
   every tie is broken by path. Ordering data follows `ORDERING_PROBE`.
7. **Judge the shipped output** on the same samples, against the Phase 0
   numbers.

## Out of scope

- **Naming the new file.** The report names a directory and a placeholder.
- **Moving the helpers a copy needs.** The report names them. The reader moves
  them.
- **Splitting a module by its importers** (idea 7 in `docs/ideas.md`). It uses
  the same bindings and may reuse this search later.
