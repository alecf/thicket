# Compiling thicket to a binary, and shipping it

*2026-09-11*

## The constraint everything else follows from

thicket analyzes through `typescript/unstable/async`, which **spawns a native
`tsgo` child process**. Three measured facts:

| | |
|---|---|
| `tsc` (the tsgo executable) | 23.8 MB, native, per-platform |
| sibling `lib/*.d.ts` | 3.9 MB, ~110 files, **mandatory** |
| bun-compiled thicket | 62–83 MB depending on target |

The declaration files are not optional. Stripping them does not degrade
analysis, it panics the compiler before it answers anything:

```
panic: bundled: /…/lib.d.ts does not exist; this executable may be misplaced
```

So a single self-contained file was never available for free. `bun build
--compile` *does* produce a working bundle — it compiles in under a second —
but running it fails immediately:

```
thicket: analysis failed: ENOENT: no such file or directory, open '/$bunfs/package.json'
```

`typescript` finds tsgo by reading its own `package.json` relative to
`import.meta.url`, which inside a bundle is `file:///$bunfs/root/cli`: a virtual
path with no filesystem under it. The error names a file the user does not have,
under a directory that does not exist.

`API({ tsserverPath })` is a sanctioned override in the client, so the fix is
available; the only question was where the ~28 MB payload lives.

## Decisions

### The shipping unit is a directory

Rejected: embedding the payload and extracting to `~/.cache` on first run. It
buys a single-file download at the cost of cache-invalidation logic,
concurrent-run atomicity, and first-run latency — and Homebrew, npm, apt and nix
all model a directory natively. Shipping the compiler alongside also *pins* it,
which suits a tool whose output is contractually a pure function of
`(source, config, version)`.

Layout is flat so a formula can `libexec.install Dir["*"]` and symlink:

```
thicket            the CLI binary
tsgo/tsc           the native compiler
tsgo/lib.*.d.ts    its standard library
tsgo/package.json  read at runtime for the version
```

### Resolution is a fallthrough

`src/extract/tsgo-path.ts`:

1. `$THICKET_TSGO` — explicit override; **throws** if it points nowhere, because
   an override that silently degrades to a different compiler changes the report
   while the reader believes they pinned one.
2. `dirname(process.execPath)/tsgo/tsc` — the packaged layout.
3. `undefined` — meaning *let `typescript` resolve it as it always has*.

Step 3 is the one that matters day to day. From source, `process.execPath` is
the Bun binary, no sibling `tsgo/` exists, and stock resolution is untouched — so
`bun run thicket` and the determinism CI job are unaffected. An override rather
than a fallthrough would have broken both.

`process.execPath` rather than `import.meta.url` for two reasons: the latter is
virtual inside a bundle, and the former resolves *through* a symlink to the real
file, which is the only reason `bin/thicket → ../libexec/thicket` works.

### The tsgo version joins the config hash

A different compiler parses and resolves differently, so it changes the finding
set. The cache is keyed on the config hash (AGENTS.md §5), so omitting it would
let a warm cache serve a report produced by a compiler the reader cannot see.
The build drops `tsgo/package.json` beside the executable precisely so this is a
file read rather than a `tsc --version` subprocess.

Cost: the golden report's hash moved once, `c3a4de98 → 66fac093`. The diff is
that single line.

### `dist/` is replaced, not supplemented

The `tsc -p tsconfig.json` step only ever emitted `dist/`. `tsconfig.test.json`
already typechecks `src/**` with `noEmit`, and `package.json` declared no
`exports` — only `bin`. So no type safety and no public surface went with it.

A bundled JS fallback survives in the npm thin package for platforms the binary
matrix does not cover.

## Distribution

One ubuntu runner builds everything: each platform's tsgo is a plain registry
tarball, fetchable from any host. All four targets in **17 seconds**, verified
from a Mac.

| target | binary | tarball |
|---|---|---|
| darwin-arm64 | 64.6 MB | 35.2 MB |
| darwin-x64 | 71.4 MB | 38.7 MB |
| linux-x64 | 83.2 MB | 46.5 MB |
| linux-arm64 | 83.2 MB | 45.6 MB |

**Homebrew** — a custom tap (`alecf/homebrew-thicket`); homebrew-core will not
take an unknown 0.1.0. The formula is *generated* from `dist-bin/checksums.txt`
rather than kept as a template with holes: it must name four URLs and four
sha256s matching bytes the build just produced, and a template is the restated
shape AGENTS.md warns about — it agrees with whatever it was last edited to say
while the artifacts move underneath it.

**GitHub Releases** — the substrate the tap pulls from. Four tarballs, a
`checksums.txt`, and the formula.

**npm** — the shape `typescript` itself uses: a thin `thicket` whose
`optionalDependencies` are per-platform packages gated by `os`/`cpu`, so exactly
one installs. Each platform package *is* the tarball layout, so `tsgo-path.ts`
resolves it with no npm-specific code path. `typescript` is an **optional peer**,
not a dependency — only the JS fallback needs it, and depending on it would tax
every install with the 28 MB of tsgo it drags behind it.

## What testing caught

Three bugs, all of which exit 0 — the dangerous kind.

1. **The launcher `await import`ed the fallback.** `cli.ts` runs `main()` only
   when it is the entry point, so the import succeeded, ran nothing, and exited
   0 having printed not one byte. It is spawned now.
2. **`xxhash-wasm` was marked external** alongside `typescript`. Nothing installs
   it beside the thin package, so the fallback died importing it. Only
   `typescript` is external, and only because it must find its own platform tsgo
   in a real `node_modules`.
3. **The `/$bunfs` failure itself**, which no amount of green CI would have
   surfaced, because building is not running.

Hence the `package` CI job: extract the tarball into a Homebrew-shaped prefix,
invoke it through the `bin/` symlink **from outside the checkout**, and require
byte-identical output to `bun run thicket`. Running it from outside is the
point — inside, a stray `node_modules` satisfies the resolution the packaged
layout is supposed to satisfy alone, and the job passes while the artifact is
broken for everyone.

Four execution paths now produce byte-identical reports on the sample fixture:
`bun src/cli.ts`, the compiled binary through a symlink, the npm platform
binary, and the JS fallback under plain node.

## Open

- **macOS notarization.** Bun ad-hoc signs its output (`adhoc, linker-signed`),
  which is enough to execute. Homebrew strips the quarantine xattr; a raw
  `curl` of a release tarball does not, so a direct download may need
  `xattr -d com.apple.quarantine`. Notarizing needs a paid Developer ID.
- **Windows.** `bun-windows-x64` and a win32 tsgo both exist; the JS fallback
  covers it meanwhile. Not built because Homebrew does not want it and nobody
  has asked.
- **Size.** ~90 MB installed is the floor while the compiler ships with the
  tool. `--minify` and `--bytecode` are untried.
