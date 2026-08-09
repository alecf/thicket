# Prototypes

Exploratory scripts written while researching the PRD (`../docs/PRD.md`). They are
**not** the implementation — they are the evidence behind its decisions, kept
because each one already implements an algorithm the real code needs.

Run them from the root of a TypeScript repo, passing tsconfig paths:

```bash
cd /path/to/some-typescript-repo
node ~/projects/thicket/prototypes/ladder.mjs \
  "$PWD/packages/client/tsconfig.json" \
  "$PWD/packages/server/tsconfig.json" \
  "$PWD/packages/shared/tsconfig.json"
```

They require `typescript@next` resolvable from the working directory.

| Script | What it demonstrates | PRD section |
|---|---|---|
| `probe.mjs` | TS 7.1 API access: load program, walk ASTs, resolve call signatures | §2.1, §2.2 |
| `scale.mjs` | Raw traversal throughput (2.87M nodes/sec) | §2.2 |
| `fingerprint.mjs` | Structural Merkle hashing; kind filtering; duplicate grouping | §5.1, §5.2 |
| `ladder.mjs` | Full L0/L1/L3 ladder, MinHash+LSH, ancestor–descendant exclusion | §2.5, §5.3 |
| `granularity.mjs` | Exact module resolution, adaptive granularity data, Tarjan SCC | §2.6, §7 |

## Known deviations from the PRD

These scripts predate some decisions and should not be copied verbatim:

- They use **SHA-256**; the implementation uses xxhash64 (§3).
- `ladder.mjs` still computes **L2 as a reported level**; the PRD demotes it to an
  internal token stream (§2.5).
- No caching, no incremental re-analysis, no ranking, no report emission.
- Granularity is enumerated for comparison rather than **selected adaptively** (§7.1).

## Hazards they encode

Each of these was a silently-wrong result before it was a fix. See PRD §2.4.

- `forEachChild` aborts on a truthy callback return — callbacks must not leak values.
- `declaration.path` is case-canonicalized; `getSourceFileNames()` is not.
- A file in N tsconfig projects is visited N times; dedupe by content.
- Directory depth must be measured after stripping the common prefix.
- Fuzzy matching must exclude ancestor–descendant pairs (77% of candidates).
