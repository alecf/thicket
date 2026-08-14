# How to read a thicket report

You are an agent that has been handed a file called `thicket.md` (or similar) and
asked to clean something up. This page explains what is in that file, what each
field means, and — the part that matters most — how to tell a finding worth
acting on from one that merely scored well.

thicket reports **candidates**. It does not judge and it does not edit. Deciding
what to do is your job, and this guide exists so you can decide well.

---

## The shape of the report

```
# thicket report
thicket 0.1.0 · config 97d8d00b · 5798 files / 1533990 LOC · granularity: dir:3 (52 modules)

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
> - `apps/mobile` — 192 files — `--config apps/mobile/tsconfig.json`
```

**Read this before you trust any number.** A run covering 3% of a monorepo will
happily report zero cycles and a low propagation cost, both of which are
artifacts of the missing 97%. Each line names the argument that closes the gap.
If you see this block, consider asking for a rerun with those configs before
acting.

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
surviving definition costs a signature and a brace. It is the number findings
are ranked on.

Note what this implies: **a 6-line shape repeated 231 times outranks a 30-line
clone repeated twice, and that is correct.** Do not dismiss a finding for having
small copies.

### `L0` / `L1` — the level

- **`L0`** — the copies are identical once formatting is normalized.
- **`L1`** — identifier names are also ignored, so copies may differ in what
  things are called.

This decides cluster membership, so it decides whether the location list is
complete. An `L0` finding lists the copies of one *exact* shape; near-variants
that differ by a renamed symbol or an inserted line are **separate findings**.
If one exists, it is linked as `see also`.

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

thicket will **not** suggest a cut that is type-only (it changes nothing that
runs) or a cut for a tangle no file-level cycle underlies (there is nothing to
break).

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
