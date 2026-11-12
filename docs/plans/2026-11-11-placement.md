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

### Four public repositories

The prototype ran on four large public TypeScript repositories. They range
from mostly agent-written to 13 years of human history. They are Public 1 to
Public 4 here, with 3,119 to 15,883 TypeScript files each. They gave 195
duplication findings and 1 cut.

#### Measurements without judges

| | Public 1 | Public 2 | Public 3 | Public 4 | All |
|---|---|---|---|---|---|
| Findings | 50 | 49 | 51 | 45 | 195 |
| Naive home creates or grows a cycle | 5 | 0 | 8 | 17 | 30 (15%) |
| Best home is unsafe too | 1 | 0 | 2 | 4 | 7 |
| Best home frees a cycle | 0 | 0 | 0 | 0 | 0 |
| A copy uses a helper declared beside it | 18 | 20 | 29 | 22 | 89 (46%) |
| A copy needs two parallel files of one name | 4 | 3 | 5 | 4 | 16 |

- **The cycle check matters for 15% of findings.** The rate ranges from 0% to
  38% by repository.
- **PRD §7.4's join did not occur.** No extraction freed a cycle.
- **Helpers are common.** Nearly half the extractions are larger than the
  finding says. The report should name the helpers.
- **Cuts are rare.** The four reports proposed 1 cut in total. These
  repositories cannot judge idea 2.

The first run grouped modules with one depth for the whole tree. The report
picks a depth per workspace. That hid 13 of the 30 unsafe naive homes. The
prototype now groups modules exactly as the report does.

#### Blind judging

80 findings were judged, 20 per repository. Each was a finding whose
suggestion differed from at least one control. Each Sonnet judge saw two or
three candidate homes, labelled in a hashed order, and rated each one. A
second judge re-rated 16 findings. 35 of 35 ratings agreed within one point,
and 28 agreed exactly.

| Arm | Rated yes or acceptable |
|---|---|
| Suggestion | 44 of 80 (55%) |
| First copy | 20 of 79 (25%) |
| First shared import | 25 of 44 (57%) |

Against the bar:

- **70% yes or acceptable: missed.** 55%. It is 59% on the 37 findings the
  judges would extract.
- **15 points over the first copy: met.** 30 points.
- **15 points over the first shared import: missed.** On the 10 findings
  where the two differ, the suggestion won 4, tied 5 and lost 1.

#### Why suggestions failed

By kind of home:

| Suggested home | Yes or acceptable |
|---|---|
| New file at a workspace root, such as `packages/shared.ts` | 3 of 14 |
| A file the copies import | 25 of 38 |
| A copy's own file | 10 of 12 |
| A dependency | 2 of 8 |
| Another new file | 4 of 8 |

The reasons judges gave fall into five groups.

1. **A package is a boundary.** When copies sit in different packages, the
   common directory is the workspace root. A file there belongs to no package
   and nothing can import it. A copy's file in one package makes another
   package depend on it. Judges wanted an existing shared package that every
   user's package already depends on. Twice, that package already held a
   canonical copy.
2. **A shared import can be unrelated.** The copies import a file for other
   reasons, and the code does not use it. Judges rated those homes no.
3. **An edge already in a cycle.** Two copies already import `Connections.tsx`,
   and it imports them back. The prototype counts no new edge, so it calls the
   home safe. Judges called it a cycle. Moving more code across a cyclic edge
   entrenches the cycle.
4. **Generated files.** Twice the home was a `*.gen.ts` file that the banner
   scan did not mark.
5. **A common base class.** Copies that are methods on sibling services belong
   on their shared base class. The prototype never proposes it.

Separately, judges would leave 23 of the 80 findings alone. Examples are
extensions that are bundled on their own, fixtures for two schema versions,
and per-version generated clients. That is a ranking problem for duplication
findings, not a placement problem.

#### Next prototype changes

1. Treat a workspace package as a boundary. A home must be in a package that
   every user's package can already import. When none exists, say so and name
   no file.
2. Offer a shared import only when the code uses something from it.
3. Count an existing edge from a user into its own cycle as an edge inside a
   cycle.
4. Never place code in a generated file. Match `*.gen.ts` as well as banners.
5. Offer the copies' common base class when they are methods.

Then judge again on the same 80 findings, and on 20 new findings per
repository.

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
