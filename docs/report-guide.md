# How to read a thicket report

You are an agent that has been handed a file called `thicket.md` (or similar).
This page explains what is in that file, what each
field means, and — the part that matters most — how to tell a finding worth
acting on from one that merely scored well.

thicket reports **candidates**. It does not judge and it does not edit. Deciding
what to do is your job, and this guide exists so you can decide well.

## Your task

The report header may carry a **Task** line. Do that task.

With no Task line, do what the person asked. If nobody asked for anything,
do `triage`. Do not edit files you were not asked to edit.

### `triage`

Judge every finding. For each one, say whether it is worth acting on, and give
the reason. The rest of this guide explains how to decide. Do not edit any file.

Order your answer by what you would do first. If a person can answer, end by
asking which finding to fix. If you run non-interactively, stop after the
verdicts.

### `fix`

Fix one finding only. One finding per run keeps each change small enough to
review, and it keeps the re-run diff readable.

1. Judge the findings as in `triage`. Pick the one most worth fixing. It need not
   be the first one.
2. Fix it. Near-variants of the same shape are part of the same fix. Other
   findings are not.
3. Run the project's tests and its typecheck.
4. Re-run thicket with the same command, and check that the finding ID is gone.
   The report shows a config hash, not the flags. If you do not know the
   command, say so. A finding can disappear because a flag changed.
5. Leave the change uncommitted.

Report which finding you fixed, what changed, and how you verified it. Say
which findings you passed over, and why. If you could not run the tests, say
so first. An unverified change is not finished.

If no finding is worth fixing, change nothing and say why.

### `pr`

Do the `fix` task. Then create a branch, commit the change, and open a pull
request. Put the finding ID and your verification in the description.

Open the pull request only if the tests ran and passed. Otherwise stop with the
change uncommitted, and say what blocked you.

## This is not a lint report

Nothing in this file is a defect. The list is not a queue to empty.

thicket searched the whole program. It looked at every AST node above a size
threshold, twice: once as written, and once with the identifiers erased. That
can easily turn up tens of thousands of matches, and it printed the top few
dozen. The ranking is about how big a finding is and how contained it is. It
says nothing about whether the change is a good idea.

There is no grade, no threshold, and no exit code that means "too complex". The
rank score lives in the JSON sidecar, not in the Markdown, and it only orders
this list. A repository with eighteen thousand candidates is not failing
anything.

You get a report instead of a diff because the two halves of this job need
different tools. Searching is slow and expensive for you: two copies of a
helper sit in two files you would never open together, and reading the whole
tree costs the whole tree in tokens. Deciding is the part a search cannot do at
all. So a good outcome here is **a few findings fixed, and a reason given for
the ones you skipped**. Not a huge mechanical diff, and not an empty list.

This matters most for code that models wrote, which is where thicket usually
runs. An agent rewrites what it cannot see. The same shape spreads across files
that never appear in one diff, often with every name changed. That is what an
`L1` finding is. Expect real duplication, expect a lot of it, and expect a fair
share of it to be fine as it is.

---

## The shape of the report

```
# thicket report
thicket 0.1.0 · config 97d8d00b · 4000 files / 900000 LOC · granularity: dir:3 (52 modules)

## Summary                  — six numbers about the whole codebase
> ⚠ N files are outside …   — appears only when coverage is partial
## Duplication              — production code that repeats
## Module tangle            — dependency cycles between modules
## Duplication in tests     — the same, for test files, in its own section
## Omitted                  — what did not fit, and what it consists of
```

Sections appear only when they have content. Everything is sorted; two runs over
the same source produce byte-identical output, so you can diff report N against
report N+1 to see whether your work landed.

---

## The header and summary

| field | what it means |
|---|---|
| `config 97d8d00b` | Hash of the settings used. Two reports with different hashes were produced differently and are **not** comparable. |
| `granularity: dir:3 (52 modules)` | How files were grouped into "modules" for the tangle analysis — here, by the first 3 path segments. |
| `analyzed` | Source files inside the TypeScript program, and what fraction of the tree that is. |
| `duplicated mass` | Redundant AST nodes. Clusters overlap, so this **double-counts** — it is a trend number for comparing runs, not a fraction of anything. |
| `duplicated coverage` | Share of source bytes covered by at least one redundant occurrence. This is the honest "how much of the codebase repeats" number. |
| `propagation cost` | Fraction of module pairs connected by some dependency path. High means a change anywhere reaches far. |
| `dependency cycles` | Number of strongly connected components larger than one module. |
| `findings N of M` | How many candidates were printed against how many exist. `M` is usually large; see [Omitted](#omitted). |

### The scope warning

```
> ⚠ 466 source files are outside this program. Every number above is drawn from
> the 92.6% that is inside it.
> - `apps/mobile` — 192 files — untried: `--config apps/mobile/tsconfig.json`
> - `scripts` — 41 files
```

**Read this before you trust any number.** A run covering 3% of a monorepo will
happily report zero cycles and a low propagation cost, both of which are
artifacts of the missing 97%.

`untried:` lists the `tsconfig*.json` files in that directory the run has **not**
already opened — candidates to rerun with, in path order, not a ranking. A line
that ends at the file count, like `scripts` above, has nothing left to try **in
that directory**: it holds no tsconfig at all, or every config in it was already
loaded, or one was opened and found to cover none of these files. Whichever it
is, rerunning with a config from there is not the move, and the report says so
rather than repeating an instruction you have already followed.

That is **not** a claim that no flag anywhere closes the gap. A config elsewhere
in the tree may well cover those files — a repo-root `tsconfig.eslint.json`
whose `include` spans everything is the common case — and thicket cannot say
which one without loading it, so it does not guess.

---

## `## Duplication`

Each finding looks like this:

````
### THK-DUP-fc3124f7 · 19 copies × ~124 lines · ~2212 lines recoverable

L1 · `ClassDeclaration`

- **every copy imports:** `models/vitals/VitalObservation.ts` → `packages/models/src/wearables/VitalObservation.ts`
- **varies across copies:** `loincCode` (18), `unit` (13), `junctionKey` (19)
- **see also `THK-DUP-23e7a775`:** 81% the same shape, 5 more copies
- **directly imported by:** 5 files outside the cluster, and 17 files more through `models/vitals/index.ts`

```ts
export class BMIObservation extends VitalObservation {
  static readonly loincCode = "39156-5";
…
```

- **spread across 1 directory:** `models/member/vitals` ×19
- `models/member/vitals/BMIObservation.ts:35`
- … every other location
````

### The heading

`19 copies × ~124 lines · ~2212 lines recoverable`

`recoverable` is `(copies − 1) × (linesPerCopy − 1) − 2`: what a successful
extraction deletes, assuming each copy collapses to a one-line call and the
surviving definition costs a signature and a brace.

Findings are not ranked on it. The rank grows faster than linearly with the size
of one copy, and slower than linearly with the number of copies. A short shape
saves little per copy, and every copy still pays for an import and a call. So
two copies of a 100-line function outrank 50 copies of a 4-line shape.

A heading can read `5 copies + 7 near`. The near copies are listed under the
locations. They do not count toward the rank or toward `recoverable`.

Exact copies (`L0`) keep more weight per copy than renamed ones (`L1`). An exact
copy needs no parameters. So **a 6-line shape copied verbatim 231 times still
outranks a 30-line clone repeated twice, and that is correct.** Do not dismiss
an `L0` finding for having small copies.

### `L0` / `L1` — the level

- **`L0`** — the copies are identical once formatting is normalized.
- **`L1`** — identifier names are also ignored, so copies may differ in what
  things are called.

This decides cluster membership. An `L0` finding's copies are one *exact*
shape. A fragment of nearly the same shape, with a line or a field changed, is
listed as a **near copy** of the finding. A less similar variant is a separate
finding, linked as `see also`.

### `[test]` / `[mixed]`

The share of the cluster's copies that are test files. `[test]` is all of them,
`[mixed]` is some. A `[mixed]` finding inside `## Duplication in tests` means a
few **production** files are in there too — check before editing.

### The context lines

**`every copy imports:`** — repo files that every copy imports, excluding ones
the whole codebase imports. This is usually where the abstraction already lives.
An `a → b` arrow means `a` is a re-export shim and `b` is the real thing; look
at `b`.

**`same shape in other surroundings:`** — the same fragment nested differently
somewhere else. **This is the most under-rated line in the report.** It is where
a deduplicated version tends to already exist. On one real report, 115 copies of
a browser-API stub in tests were all dead code, because the identical block sat
in the project's configured test setup file behind one extra guard — and that
file was named on this line. The refactor was deletion, not extraction.

**`varies across copies:`** — the constants that parameterize the shape, with
how many distinct values each takes. `loincCode (18)` on a 19-copy finding means
two copies share a value, which is often a bug. This line is the parameter list
of the abstraction the finding is asking for.

**`see also THK-DUP-…:`** — another printed finding that is nearly this shape.
Handle both together or you will make a second pass.

**`all N of these files also carry THK-DUP-…:`** and **`THK-DUP-… lives only in
N of these files:`** — another printed finding whose files nest with this one's.
The two are different shapes in the same files, so one visit covers both. Read
the linked findings before you design anything. Several of them over one set of
sibling files usually means the files are parallel implementations of one
concept, and the abstraction is the concept, not any single shape.

**`declared once in each of N .role files:`** — the shape appears once per file,
and every file plays the same role. Storybook wants one `const meta` per
`*.stories.tsx`. This is usually a framework's API rather than duplication, and
deleting a copy deletes a story. thicket ranks these below duplication of the
same size. The line says `and twice in one of them` when a single file breaks
the pattern, because one exception does not stop it being a convention.

The role has to be a dotted suffix, so `page.tsx` and `route.ts` are not
matched. Reading a whole basename as a role would make every `types.ts` in a
repository one role. It is a weight, not a filter, so check before dismissing
the finding. `--no-file-conventions` turns the weight off.

**`directly imported by:`** — how many files outside the cluster reach into it.
This is your blast radius. `nothing outside the cluster` means you can rewrite
freely. Files reached through a re-export barrel are counted separately, because
the direct number alone understates it.

**`spread across N directories:`** — appears on findings touching more than a
dozen files. One directory means contained; sixty means it is a convention.

### The excerpt and the locations

The excerpt is ~60% of one copy, capped at ten lines, taken from the first
location in sorted order — so it is representative of the *shape*, not
necessarily of the majority. Every location is listed as `path:line,line`; the
report deliberately does not truncate them, because a location you cannot open
is not actionable.

### Near copies

```
**near copies** (the same shape with a line or a field changed):

- `examples/app/bedrock/page.tsx:7` · 87% the same shape
- `examples/app/page.tsx:6` · 92% the same shape
```

A near copy has nearly the shape of the finding's copies. Most differ by an
inserted line, a dropped field or an extra option. The level and `varies across
copies` describe the exact copies only.

Judges rated about three in four near copies worth covering with the finding's
abstraction. So **open each one before you include it.** Expect to add a
parameter or an option for the difference. A large test block is the usual
exception: two tests with the same harness and different assertions look near,
and a shared helper rarely covers both.

When a smaller finding is nearly the same shape as a larger one, thicket folds
it in. Its copies appear here as near copies, and it is not printed on its own.
`--no-near` turns near copies off.

---

## Is this duplication worth removing?

The honest answer is often no, and thicket cannot always tell. Use this:

**Ask what varies.** If the copies differ only in the *values* of the same
fields, they are one concept with a parameter list, and a base class or a
function absorbs them cleanly. If they differ in *field names* — one is
`{ labOrderId, memberId, practiceId }` and the next is `{ average, min, max }` —
they are different things that happen to share a syntax template, and the only
abstraction available is a generic that no future change will ever benefit from.
thicket down-ranks the second kind, but it is a weight, not a filter.

**Ask what fixing it buys.** The value of removing duplication is "fix it once,
fixed everywhere". If nothing can ever drift — because the copies are unrelated
expressions that merely look alike — you are trading readable local code for
indirection and gaining nothing.

**Ask whether it is already solved.** Check `same shape in other surroundings`
and `every copy imports` before designing anything.

**Ask whether the call is the extraction.** A fragment that is only a call to a
shared helper is correct reuse, not duplication. Nothing shorter can replace a
call. thicket leaves these out of the report and says how many it removed;
`--include-call-sites` shows them.

**Then say so.** If the answer is "not worth it", report that back rather than
producing a large mechanical diff. That is a useful result.

---

## `## Module tangle`

A **module** is a group of files (see `granularity` in the header). A tangle is a
strongly connected component: from any module in it you can reach every other by
following imports.

````
### THK-CYC-a41baf77 · SCC of 12 modules under `apps/web/`

```mermaid
flowchart LR
  actions -->|"1665 (102 type)"| lib
  lib -->|"910 (259 type)"| models
  …
```

- **file cycles:** 6 cross these modules (largest 77 files, including …)
- **dissolve `actions` → `app`:** all 45 imports pass through `app/api/errors.ts`
  to `lib/errors.ts`. Repointing the specifier removes the edge …
- **suggested cut:** `components` → `hooks` — 3 symbols in `…/Foo.tsx`
- **leaves:** after all of the above 11 of 12 modules still mutually dependent.
````

### The diagram

Arrows run **importer → imported**. The number is **import sites**: one per
symbol per importing file, with `export … from` re-exports counted. It is not a
count of distinct symbols — the same symbol imported in eight files counts eight
times — because it is a proxy for how many edits severing the edge would cost.

`12 type` means the whole edge is `import type` and is **erased at compile
time**: no module-init order to get wrong, no bundler cycle. `59 (4 type)` means
four of the fifty-nine bindings erase. An edge that is mostly type-only is often
one file away from vanishing entirely.

A shared path prefix is lifted into the heading (`under apps/web/`), so node
names in the chart are relative to it.

If the component is too large to chart, you get a member list and a line saying
so. The chart is never partially drawn — dropping arrows from a cycle can make
the remainder look acyclic.

### `file cycles:`

**Read this before doing anything else in this section.** A module SCC is a
statement about *directories*, and directories are a grouping thicket chose.

- *"none cross these modules, so nothing here is circular at runtime"* — no file
  imports its way back to itself across these boundaries. The tangle is layering
  drift, not a defect. There is no initialization hazard and no bundler cycle.
  It may still be worth tidying, but it is not urgent, and no cut will remove a
  cycle because there is no cycle.
- *"6 cross these modules (largest 77 files)"* — real cycles exist. Now it
  matters.

### `dissolve` vs `suggested cut`

These are different kinds of work and the report lists them in order of cost.

**A dissolve is free.** The imports crossing that edge are re-exported from
somewhere else, so the dependency is on the *origin*, not on the file named.
Repoint the specifier and the edge disappears — a re-export is the same binding,
so the program is unchanged. This is a find-and-replace. Do these first.

**A cut is a decision.** It means inverting a dependency, moving code, or
agreeing a layering. thicket names the cheapest edge that dissolves the most of
the component, and names the files carrying it, but it cannot know which
direction is architecturally right. Treat it as a starting point, not an
instruction — if the suggestion looks absurd (severing a component from its own
hooks, say), it probably is, and the real fix is nearby.

thicket will **not** suggest a cut for a tangle with no file-level cycle under
it, because there is nothing to break. It will not suggest one that leaves more
than two thirds of the tangle standing either. When every option fails that
test, it says so and names the best it rejected.

A type-only cut is **demoted, not banned**. A runtime edge wins any tie, because
only a runtime cycle can fail at module-init time. But a type-only edge that
breaks the cycle completely is still proposed, labelled `type-only`. Nothing
changes at runtime when you take it. What changes is that a reader no longer
has to understand both modules to understand either one.

### `leaves:`

What survives everything listed above. `nothing — this breaks the cycle
completely` is the good case. `11 of 12 modules still mutually dependent` means
the suggestion is a start and no more. `no single edge breaks this cycle` means
exactly that: every single-edge option was checked and none helps.

---

## `## Duplication in tests`

Identical in format, kept separate so test scaffolding cannot crowd out
production work, and given a much smaller share of the slots.

Do not skip it. Test duplication is sometimes deliberate — parallel
arrange/act/assert often reads better than a helper — but it is also where the
cheapest and safest wins live, because there is frequently no behaviour to
preserve. Before consolidating, check whether the project already has a shared
helper or a global setup file that makes the copies redundant.

---

## `## Omitted`

```
| category | candidates | shown |
| duplication | 8951 | 40 |
| duplication in tests | 9989 | 5 |
| module tangle | 2 | 2 |
```

Plus a histogram of candidates by recoverable lines, and a line about candidates
that repeat within a single file.

A further line appears when thicket dropped candidates that were only repeated
calls to shared code. Those would have been printed otherwise, so the count is
exact rather than an estimate. `--include-call-sites` brings them back.

Large omitted counts are normal and are not a backlog. Most of the tail is tiny
or is intra-file repetition, which is ranked down rather than excluded. The
histogram tells you which.

---

## Working with the report

**Cite finding IDs.** `THK-DUP-fc3124f7` is derived from content, not position,
so it survives the code being reformatted or moved. Say which finding you acted
on.

**Re-run and diff.** The report is a pure function of source, config and version.
Regenerate after your change and diff: findings that disappeared were resolved,
and the summary numbers show whether the whole moved.

**Verify before you edit.** Locations are exact, but the report is a static
analysis and cannot see intent. Open the files. Check whether a finding is dead
code, deliberate, or generated.

**Report what you did not do.** "Findings 2, 4 and 7 are not worth consolidating
because the copies share only a syntax template" is a better outcome than a
thousand-line diff that makes the code worse.

---

## Reporting a bad finding to thicket

Skip this section if the report header says **Private report**.

thicket improves when someone reports a finding that was wrong. The reason it
was wrong is often general. A rule that catches it would improve every report.
You know the reason at the end of your analysis, and nobody else will.

### When to file

File only after you finish the analysis and decide what is worth fixing.

File when a finding ranked high and was a bad suggestion. Some examples:

- The copies share a syntax template and not a concept.
- The duplication is a framework's required API.
- A suggested cut removes no cycle that matters.
- A field in the report was wrong or misleading.

Do not file when the finding was sound and the person chose not to act on it.

Do not file without a person to ask. If you run non-interactively, for example
under `claude -p`, file nothing. Say in your summary which finding looked worth
reporting, and why.

### Ask first

Filing an issue publishes text on GitHub. Deleting it later does not unpublish
it. So ask before you file, every time.

1. **Ask whether you may file an issue** at
   <https://github.com/alecf/thicket/issues>. Show the person the draft title and
   body first.
2. **Find out whether the analyzed repository is public.** Run
   `gh repo view --json visibility --jq .visibility` inside it. Treat it as
   private unless that prints `PUBLIC`. A repository with no GitHub remote is
   private. So is an internal repository, and a public fork of a private one.
3. **If it is public, ask what the issue may show.** Ask separately whether it
   may link to the repository, and whether it may quote or link the code. The
   person may agree to one and not the other.

### Check for an existing issue

Search before you file:

```bash
gh issue list --repo alecf/thicket --state all --search "<two or three keywords>"
```

If an issue already covers the same pattern, add your case as a comment. Ask
first, the same as for a new issue.

### What the issue says

Title it `Bad finding: <the pattern, in one line>`. Give the body four parts.

**What thicket reported.** Name the section, the level (`L0` or `L1`), the copy
count and the rank. Give the thicket version, which is the number after
`thicket` on the report's first line. List any flags the run used.

**Why the static analysis was wrong.** Name the property that thicket missed.
State it as a fact about the code: "every copy differs in its keys" or "each
file is required to export one `meta`". A reader must be able to check it
without the original repository.

**An example.** It must reproduce the same finding at the same level.

- If the repository is public and the person agreed, quote the code. Link it
  with a permalink to a commit SHA, not to a branch.
- Otherwise, write a small invented example with the same shape. Two or three
  short files are usually enough. If you can, run thicket on it and confirm
  that it reports the same finding.

**A proposed rule. Optional.** If you see a general test that would rank this
finding down, describe it. Name the syntax it inspects. Say what else it might
suppress by mistake. A rule that names one codebase's identifiers is not
general.

### What a private repository's issue must not contain

When the repository is private, or the person declined a link, the issue
contains none of these:

- the repository, organization, product or package names
- file paths or directory names
- identifiers, string literals, comments or domain terms from the code
- the report's summary table, file counts or line counts
- the finding ID, because it is a hash of private code

Rename everything in your example. Read the draft once more for leaks before
you show it to the person. If the problem cannot be shown without the private
code, do not file.

### Filing

```bash
gh issue create --repo alecf/thicket --title "Bad finding: …" --body-file issue.md
```

Write the body to a file first. A body passed on the command line breaks on
backticks. Give the person the issue URL when you are done.
