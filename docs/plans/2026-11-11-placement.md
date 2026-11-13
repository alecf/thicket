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
| `orderTotal`, exact copies | `src/invoice/total.ts` in round 1, new `src/shared.ts` in round 2 | The copies use nothing from `invoice/total.ts`, and the edge into it is in the 3-file ring. |
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

### Round 2: after the five changes

All five changes are in `prototypes/placement.ts`. A package is the nearest
directory with a `package.json`. One package can import another when its
`package.json` lists it or its files already import it. When copies span
packages with no package they can all import, the suggestion is "a shared
package is needed", and it names no file.

The generated-file check found a gap in thicket itself. On Public 2, 1,355 of
the 1,451 copies in printed findings were in `*.gen.ts` API clients. Those
files carry no generator banner, so thicket analyzes them. The prototype now
skips a finding when every copy is generated, which removed 24 of Public 2's
49 findings. The report needs its own fix, which is outside this plan.

143 findings were judged: 79 from round 1 and 64 new. A second judge re-rated
29 of them, and 68 of 68 ratings agreed within one point.

| Arm | Round 1 | Round 2 |
|---|---|---|
| Suggestion | 44 of 80 (55%) | 78 of 143 (55%) |
| First copy | 20 of 79 (25%) | 33 of 143 (23%) |
| First shared import | 25 of 44 (57%) | 36 of 69 (52%) |

The suggestion still misses the 70% bar. It is 59% on the findings judges
would extract. It ties the first shared import: 16 better, 10 tied, 15 worse.

By kind of suggestion:

| Suggested home | Yes or acceptable |
|---|---|
| A copy's own file | 14 of 32 |
| A file the copies import and use | 22 of 36 |
| A dependency | 4 of 13 |
| A new file | 17 of 32, none rated yes |
| No file: a shared package is needed | 20 of 29, none rated yes |
| The common base class | 1 of 1 |

The changes fixed what they targeted. New files went from 3 of 14 at a
workspace root to 17 of 32 inside a package. What remains is not a graph
problem. Judges want a new, purpose-named file beside the copies, in a
directory such as `layouts-shared/` or `applied-filters/`. The prototype
offers a file the code happens to import, such as `removable-chip.tsx` or a
skeleton component, and judges call it unrelated. Choosing a home by meaning
needs more than the import graph.

#### The warning works where the suggestion does not

The same judgments measure the opposite claim: that a home is wrong. Every
rated home carries the prototype's verdict.

| Home | Rated no |
|---|---|
| Flagged: it creates or grows a cycle | 35 of 38 (92%) |
| Flagged: a user's package cannot import it | 63 of 72 (88%) |
| Not flagged | 101 of 193 (52%) |

The flag fires often. The first copy's own file, which is the obvious home, is
flagged for 87 of 171 findings.

Copies across packages with no shared package are also a ranking signal.
Judges would leave 23 of the 29 findings that got "a shared package is
needed". Often the copies are separate on purpose, such as extensions that are
bundled on their own.

#### Decision

Phase 1 ships the warning, not the suggestion.

- Under a finding, name the copies' own files that are unsafe, and say why:
  `- **not in:** extensions/a/x.ts (creates a cycle with …)`.
- When the copies span packages with no package they can all import, say
  that, and name the packages.
- Name a home only when it is the copies' common base class. That case was
  rated yes once in one try, so it needs more data before it ships.
- Test the package signal separately as a ranking input for duplication
  findings. It belongs to the ranker's judged evaluation, not to this plan.

Cuts are still untested. The four repositories proposed 1 cut in total.

### Round 3: a directory for a new file

Judges in round 2 wanted a new, purpose-named file. thicket cannot name it,
but it can say which directory the file belongs in. Round 3 asks whether
that directory is worth printing:

```
- **extract into:** a new file under `src/features/x/` (name of your choosing)
```

The directory is the deepest one that holds every copy, inside a package
every copy's package can import. A new file there must close no cycle.

A line that is always true scores well for being vague. So two controls
stand beside it, and each judge sees all three in a hashed order:

- **Vague:** "a new file in a shared location of your choosing".
- **Unrelated directory:** a new file in a directory of the same package that
  no copy sits under. It is just as safe, and it is picked by a hash of the
  finding id.

The judge rates each line yes, acceptable or no. `yes` means the line is right
and narrows the choice beyond what the judge would do anyway.

The bar, set before judging:

1. The computed directory is rated yes or acceptable at least 70% of the time.
2. Its `yes` rate beats the vague control's by at least 15 points.
3. Its yes-or-acceptable rate beats the unrelated directory's by at least 15
   points.

If it misses any of the three, the report keeps only `do not extract into:`.

#### Results

101 findings were judged, with an unrelated control on 76 of them. A second
judge re-rated 19 findings, and 56 of 57 ratings agreed exactly.

| Line | Yes or acceptable | Yes |
|---|---|---|
| Computed directory | 73 of 101 (72%) | 45 of 101 (45%) |
| Vague | 101 of 101 (100%) | 2 of 101 (2%) |
| Unrelated directory | 1 of 76 (1%) | 1 of 76 (1%) |

All three bars are met: 72% against 70, 43 points over the vague line on
`yes`, and 70 points over the unrelated directory. The vague line scored
exactly as a true but empty claim should: acceptable every time, and almost
never `yes`.

The failures share one cause. Split by where the directory came from:

| Directory | Yes or acceptable | Yes |
|---|---|---|
| Copies in one package: their deepest common directory | 56 of 56 (100%) | 38 of 56 (68%) |
| Copies across packages: a host package picked from the graph | 17 of 45 (38%) | 7 of 45 (16%) |

A host package is often the wrong kind of package. Judges rejected a types
package for runtime code, a constants package for functions, a data package
for a React component, and a server app for a shared type.

This split was found after the bar was set, so it is not preregistered. It
only removes the weak case, so the line that ships is narrower than the line
that passed.

#### Decision

The report prints `extract into: a new file under <dir>/, with a name of your
choosing` only when every copy is in one package, and never for the
repository root. When copies span packages, it prints `across packages:` or
nothing. Neither line appears on findings in the test section, which no round
judged.

## Cuts at file granularity

The module report proposed 1 cut across the four repositories. The tangles
are there, but they are large. No single edge leaves less than two thirds of
them standing. With `--granularity file`, each report reaches the 40-tangle
cap, and 129 of those 160 tangles have a cut.
`THICKET_GRANULARITY=file` runs the prototype on them.

### The tie rule picked the wrong edge

51 of the 129 cuts were on tangles with no runtime cycle. In each, the
chooser cut a runtime edge, because a runtime edge won every tie. The usual
shape is a parent that imports a child component, and a child that imports a
props type back. So the move line said to move the child component. Its best
home was the file it was already in.

The fix is in `suggestCuts`. A runtime edge wins a tie only when the tangle
has a runtime cycle. Otherwise the type-only edge wins. After the fix, 5 cuts
on such tangles still cut a runtime edge. In each, several type-only edges
close the cycle, so one runtime edge breaks more of it.

### Helpers decide whether a move frees the cycle

| | Public 1 | Public 2 | Public 3 | Public 4 | All |
|---|---|---|---|---|---|
| Cuts | 30 | 37 | 28 | 34 | 129 |
| Cannot be placed | 13 | 1 | 4 | 0 | 18 |
| Placed | 17 | 36 | 24 | 34 | 111 |
| Best home frees the cycle, before the fix | | | | | 43 of 108 |
| Best home frees the cycle, after the fix | 8 | 22 | 8 | 21 | 59 |
| Does not free it, and needs a helper beside it | 9 | 14 | 16 | 13 | 52 |

Every placed cut that does not free its cycle moves a symbol that uses a
helper declared beside it. No cut that frees its cycle needs one. The
prototype moves the named symbols and leaves the helpers. So the new home
imports the old file, and the edge it was meant to remove comes back.

For a cut, the helpers must move too, unless something else in the old file
uses them. That is the next prototype change. Judging the move lines waits
for it. Most cuts that cannot be placed go through a barrel `index.ts`.

### Round 4: judging the move lines, preregistered

This section was committed before any judge saw a packet.

**Items.** Every placed file-level cut from the four repositories, after the
prototype moved helpers: 111 cuts. Each item shows the cycle's cut edge, the
declarations that move, the helpers that move with them, and the code.

**Guidance lines.** Each item has up to three lines, in a hashed order. Each
line names only a destination.

- **computed**: the prototype's best home.
- **importer**: the file on the `from` side of the cut. This is the plan's
  control. It is left out when it is the same file as the computed home.
- **vague**: "a file of your choosing that does not import" the old file.
  This is true for every cut and names nothing.

**Judges.** Sonnet, blind, with hashed labels. Eight items per packet. A second
judge rates a fifth of the packets again.

**Bar.** All three must hold.

1. The computed home is rated yes or acceptable at least 70% of the time.
2. Its yes rate beats the vague line's yes rate by at least 15 points.
3. On items with an importer line, its yes-or-acceptable rate beats the
   importer's by at least 15 points.

If the bar is met, the report gains a `move to:` line under each cut. If it is
missed, the report names the helpers that must move and does not name a home.

### Round 4 results

Sonnet judges rated all 111 items. A second judge re-rated 3 packets: 54 of
61 ratings matched exactly, and all 61 were within one point.

| Line | Rated good | Rated yes |
|---|---|---|
| computed | 78/111 (70%) | 33/111 (30%) |
| vague | 97/111 (87%) | 0/111 (0%) |
| importer | 11/70 (16%) | 1/70 (1%) |

All three bars are met. Bar 1 is met by 0.3 points, which is inside the noise.

Split after the fact:

| Items | Computed rated good |
|---|---|
| No helpers move | 54/64 (84%) |
| Helpers move too | 24/47 (51%) |
| Home is a user of the code | 66/83 (80%) |
| Home is a file the code depends on | 6/18 (33%) |
| Home is a new file | 3/6 (50%) |
| Judge says the fix is worth doing | 48/56 (86%) |

Most misses share one cause. The judge names a different, smaller move that
breaks the cycle. Examples:

- Two type-only edges point at `client.ts`. Both import one logger interface.
  No single edge breaks the cycle, so thicket cuts the runtime edge and moves
  a 400-line class. Moving the interface removes both type edges at once.
- A 674-line model class moves to break an edge that one `Pick<>` crosses.
- A component moves where one constant on another edge would do.

The cut search scores edges one at a time, and a tie goes to the fewest
files. It never asks how much code a cut moves. A move can remove several
edges into one file at once, when they all import the same declaration. So
the unit to search is a move: a declaration and its helpers. Its cost is the
code it moves. The same search can break the large module tangles, where no
single edge helps (option 2).

Two smaller findings:

- **Dependency homes are weak.** Judges rejected a vendored file, a generic
  utility, and a file on another layer.
- **The placeholder name `moved.ts`** drew complaints. Name the new file after
  the first declaration, or leave the name to the reader as extraction does.

### The move search

The prototype now searches moves, not edges. A candidate is one declaration
that a tangle file imports from another, or every declaration on one edge,
with its helpers. The second kind is what an edge cut moves. A move removes
every edge whose imports all move. Candidates rank by the largest cycle left,
then the largest runtime cycle left, then the lines moved. An import is
erased when it says `import type`, or when it names an interface or a type
alias. A re-export edge is kept unless the file only re-exports, because the
adapter reports re-exports only for such files.

| | Public 1 | Public 2 | Public 3 | Public 4 | All |
|---|---|---|---|---|---|
| File tangles | 40 | 40 | 40 | 40 | 160 |
| Fixed by an edge cut | 30 | 37 | 28 | 34 | 129 |
| Fixed by a move | 17 | 34 | 31 | 32 | 114 |
| Only a move | 2 | 2 | 6 | 3 | 13 |
| Only an edge cut | 15 | 5 | 3 | 5 | 28 |

Where both have a placed move, they pick the same one 65 times in 95. On the
cases round 4 judges flagged, the search picks the move the judge asked for:
`GatewayClientLogger` (6 lines) where the edge cut moved 371, and
`WorkflowContext` (5 lines) where it moved 40. It also refuses two cycles
through recursive components, where judges said no move helps and the edge
search proposed one. Most edge-only fixes cut through a barrel, which has no
declaration to move.

### Round 5: judging the move search, preregistered

This section was committed before any judge saw a packet.

**Pairwise.** The 30 tangles where the two searches move different code. A
judge sees both fixes, in a hashed order, each with what moves and where.
The judge picks the better fix, or says they are equal.

**Destinations.** Every search move whose symbols differ from a round 4
item, judged as in round 4 with the computed, vague and importer lines. The
65 identical moves keep their round 4 ratings, because the same symbols get
the same home.

**Bar.** All must hold.

1. Pairwise: judges prefer the search's fix in at least two thirds of the
   items where they state a preference.
2. Destinations, round 4 and round 5 ratings together: the computed home is
   rated yes or acceptable at least 70% of the time, its yes rate beats the
   vague line's by 15 points, and its good rate beats the importer's by 15.
3. Refusals: on the round 4 items whose tangle the search leaves unfixed, the
   computed home's good rate is below its rate on the rest. This checks that
   the search refuses the weak fixes and not the strong ones.

If all hold, the core's cut search becomes a move search, and the report
gains a `move to:` line. If bar 1 misses, keep the edge search.

### Round 5 results

All three bars are met. Two are met by a few points.

**Pairwise**, 30 tangles where the two searches move different code:

| | Count |
|---|---|
| Judge prefers the move search | 19 |
| Judge prefers the edge cut | 8 |
| Equal | 3 |
| Search preferred, of decided | 19/27 (70%), against a bar of 67% |
| Second judge agrees on the preferred fix | 8 of 8 |

Judges said the search's move breaks the cycle in 18 of 30, and the edge
cut's in 13 of 30. Of the 10 search moves judged not to break it, 8 leave a
2- to 6-file cycle. The search allows that under the same two-thirds rule as
the cut search, and it reports the cycle left. The judges read "breaks the
cycle" as breaking all of it. One was a prototype bug: a `const` and an
`interface` shared a name, and only the `const` moved. That is fixed.

**Destinations**, 114 search moves (63 rated in round 4, 51 in round 5):

| Line | Rated good | Rated yes |
|---|---|---|
| computed | 81/114 (71%) | 32/114 (28%) |
| vague | 114/114 (100%) | 8/114 (7%) |
| importer | 12/76 (16%) | 2/76 (3%) |

A second judge matched 41 of 44 round 5 ratings exactly.

**Refusals.** On round 4 items whose tangle the search leaves unfixed, the
computed home was rated good 7 of 16 times (44%). On the rest it was rated
good 71 of 95 times (75%). The search refuses mostly the weak fixes.

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

Round 2 changed the scope. The suggestion did not clear the bar, and the
warning did. So steps 3 and 4 print what to avoid, as the round 2 decision
says. They do not print a home. Steps 1, 2, 5, 6 and 7 stand as written.

**Built.** The check needs no bindings, because each copy's file already
imports what its own copy uses. `src/graph/packages.ts` finds packages.
`src/graph/placement.ts` checks each copy's file, at most 24 per finding. The
report prints `do not extract into:` or `across packages:`. The JSON gets an
`avoid` field. `--no-placement` turns it off and joins the config hash. On
Public 3, the 21,279-file repository, the check adds about 5 seconds of setup
and 45 ms of checks. That is inside the run-to-run noise. Step 7, judging the
shipped output, is still to do.

Cuts (`move to:`) are not built. The four repositories gave 1 cut in total.

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

### Moves in the core

The move search and the `move to:` line now run in the core, for tangles whose
members are files. There is no off switch. Both replace a suggestion and hide
nothing (AGENTS.md §4b). A module tangle keeps the edge search. The edge search
also runs when no move breaks a file tangle.

- `src/extract/symbols.ts` reads each file's bindings, declaration spans and
  identifier uses. `Project.symbolsOf` memoizes it.
- `src/graph/moves.ts` holds the search and the home ranking.
- Dissolves apply first. On the four repositories, 4 tangles the prototype
  moved are fixed by a dissolve alone, or by a smaller move after it.
- The search adds no measurable time. One repository ran in 28.9 s on main and
  28.5 s to 28.8 s on the branch.

The home ranking changed. The prototype scored a new file as part of a
neighbour's module, so most new files looked unsafe and lost. Without that
artifact, a new file won 40 of 45 judged moves, often in a directory high above
the code. The core now prefers an existing file that is just as safe. That
keeps the judged pick on 34 of 45. On the other 11, two blind judges rated the
new pick good 6 and 7 times, and the prototype's pick good 2 times and once.
Across all four repositories the core picked an existing file every time.

Of the 101 tangles where both searches found a fix, the edge cut left a smaller
tangle 8 times. Five of those were judged in round 5. Judges preferred the edge
cut once, the move twice, and rated two equal. The move keeps priority.

A tangle of directories with no fix now prints a line pointing at
`--granularity file`. Next is a move search for those tangles. A move counts
there only when the home is in another directory, so the search has to score
homes while it searches. It needs its own judged round.

### Round 6: judging the shipped output, preregistered

This section was committed before any judge saw a packet. Rounds 1 to 5
judged prototype output. This round judges the lines the core prints, copied
verbatim from the report, on the same four public repositories.

**Extraction lines.** Every production or type finding whose shipped report
prints `do not extract into:`, `extract into:` or `across packages:`, at the
default granularity. At most 15 per repository, picked by a hash of the
finding id. The judge sees the copies, an excerpt and the shipped lines. The
judge rates each `do not extract into:` entry as right or wrong to avoid,
`extract into:` as yes, acceptable or no, and `across packages:` as true or
false.

**Move lines.** Tangles whose shipped report at file granularity prints a
`suggested move:`. At most 10 per repository, picked the same way. The judge
sees the tangle, the moved code and the shipped lines, plus a vague control:
"a file of your choosing that does not import the owner". The judge rates
whether `leaves:` is true of the move, and rates each home as yes,
acceptable or no.

Sonnet judges, about 10 items per packet. A second judge re-rates two
packets, to check agreement.

**Bar.** All must hold.

1. `do not extract into:` entries are rated right at least 80% of the time.
   The prototype's flagged homes were rated wrong 88% of the time.
2. `extract into:` is rated yes or acceptable at least 90% of the time. The
   prototype's was 56 of 56.
3. `across packages:` is rated true at least 80% of the time.
4. `move to:` is rated yes or acceptable at least 70% of the time, and its yes
   rate beats the vague line's by 15 points. These are the round 5 bars.
5. `leaves:` is rated true at least 80% of the time.

Any bug a judge's reasoning exposes gets fixed, whether or not a bar holds.
A missed bar means finding why before the next release, and re-judging the
items that failed.

### Round 6 results

All five bars held. 100 items: 60 findings and 40 moves, in 10 packets. A
second judge re-rated two packets and agreed on 37 of 39 ratings.

| Bar | Result | Needed |
|---|---|---|
| `do not extract into:` entries rated right | 51 of 53, 96% | 80% |
| `extract into:` rated yes or acceptable | 24 of 24 | 90% |
| `across packages:` rated true | 17 of 17 | 80% |
| `move to:` rated yes or acceptable | 36 of 40, 90% | 70% |
| `move to:` yes rate against the vague line | 32% against 8% | 15 points |
| `leaves:` rated true | 38 of 40, 95% | 80% |

The judges' reasons exposed two bugs. Both are fixed.

- **`leaves:` measured a new file, not the home.** The search scores a move
  against a new file. The home can be an existing file that already holds what
  the code needs, and then less is left. Both false `leaves:` lines said 2
  files were left where nothing was. The home ranking now reports the cycle
  left at the home it picks.
- **Barrels were picked as homes.** Two of the four rejected homes were files
  that only re-export. Code there makes every forwarded file a dependency. A
  file that only forwards is no longer a candidate.

Not fixed, each seen once:

- A home in a vendored file marked "DO NOT modify, COPIED from". It carries
  no generator banner, so the scan misses it.
- A home in another package that lacks the code's external dependency.
- Two `do not extract into:` entries rated wrong. One named a cycle the judge
  could not find. The other gave a package reason the judge read as false,
  where a workspace package already depends on the other.

## Out of scope

- **Naming the new file.** The report names a directory and a placeholder.
- **Moving the helpers a copy needs.** The report names them. The reader moves
  them.
- **Splitting a module by its importers** (idea 7 in `docs/ideas.md`). It uses
  the same bindings and may reuse this search later.
