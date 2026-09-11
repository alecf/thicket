/**
 * Compiles thicket to a self-contained directory per platform, and tars it.
 *
 * The binary is not self-contained on its own and cannot be made so: analysis
 * runs through `typescript/unstable/async`, which spawns a NATIVE tsgo child
 * process. That executable is 24MB, is per-platform, and refuses to start
 * without the ~110 `lib.*.d.ts` files beside it -- it panics with "this
 * executable may be misplaced" rather than degrading. So the shipping unit is
 * a directory, and `src/extract/tsgo-path.ts` finds tsgo relative to
 * `process.execPath` at runtime.
 *
 * Every platform's tsgo is a plain registry tarball, so one host builds the
 * whole matrix -- no per-OS runners.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(repoRoot, "dist-bin");
const cacheRoot = join(repoRoot, ".build-cache", "tsgo");

interface Target {
  /** Bun's --target triple. */
  bunTarget: string;
  /** node's process.platform, which names the tsgo package. */
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
}

const TARGETS: Target[] = [
  { bunTarget: "bun-darwin-arm64", platform: "darwin", arch: "arm64" },
  { bunTarget: "bun-darwin-x64", platform: "darwin", arch: "x64" },
  { bunTarget: "bun-linux-x64", platform: "linux", arch: "x64" },
  { bunTarget: "bun-linux-arm64", platform: "linux", arch: "arm64" },
];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const pkg = readJson(join(repoRoot, "package.json"));
const VERSION = String(pkg.version);

/**
 * The tsgo version is whatever `typescript` is pinned to. AGENTS.md §2 pins it
 * exactly rather than with a caret, and this reads that pin rather than
 * restating it -- a second copy of the version would drift, and the drift
 * would ship a compiler that does not match the one the tests ran against.
 */
const TS_VERSION = (() => {
  const deps = pkg.dependencies as Record<string, string> | undefined;
  const v = deps?.typescript;
  if (!v) throw new Error("package.json has no `typescript` dependency to pin tsgo to");
  if (!/^\d/.test(v)) {
    throw new Error(`typescript must be pinned exactly, not a range (found ${v}) -- AGENTS.md §2`);
  }
  return v;
})();

function run(cmd: string, args: string[], cwd = repoRoot): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status ?? "by signal " + r.signal}`);
  }
}

function human(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Everything a packaged tsgo cannot start without: the executable, the manifest
 * `tsgoVersion()` reads, and the stdlib whose absence is a panic rather than a
 * degraded run.
 */
function isCompleteTsgo(dir: string): boolean {
  return (
    existsSync(join(dir, "lib", "tsc")) &&
    existsSync(join(dir, "lib", "lib.d.ts")) &&
    existsSync(join(dir, "package.json"))
  );
}

/**
 * Downloads and unpacks one platform's tsgo, verifying the registry's own
 * integrity digest. Cached, because the payload is 28MB per platform and a
 * four-target build would otherwise refetch 112MB on every run.
 */
async function fetchTsgo(target: Target): Promise<string> {
  const name = `typescript-${target.platform}-${target.arch}`;
  const dest = join(cacheRoot, `${name}-${TS_VERSION}`);
  // A cache hit must mean the whole payload, not just the executable. tsgo
  // panics rather than degrading when its stdlib is missing, so an extraction
  // interrupted after `tsc` landed would otherwise be trusted forever and ship
  // an artifact that dies on first run.
  if (isCompleteTsgo(dest)) return join(dest, "lib");

  // Percent-encoded, which is the form the registry API documents for a scoped
  // name. registry.npmjs.org accepts the bare `@scope/name` too -- that is what
  // this used and it worked -- but stricter mirrors and proxies do not.
  const metaUrl = `https://registry.npmjs.org/@typescript%2f${name}/${TS_VERSION}`;
  const meta = (await (await fetch(metaUrl)).json()) as {
    dist?: { tarball?: string; integrity?: string };
  };
  const tarball = meta.dist?.tarball;
  if (!tarball) throw new Error(`no tarball for @typescript/${name}@${TS_VERSION}`);

  process.stdout.write(`  fetching @typescript/${name}@${TS_VERSION}\n`);
  const bytes = Buffer.from(await (await fetch(tarball)).arrayBuffer());

  // Checking the registry's digest is the difference between pinning a version
  // and pinning the bytes that version resolved to. Deliberately fail-CLOSED:
  // this is a 24MB native executable that ships to users, so absent or
  // unrecognized integrity metadata is a refusal, not a skipped check.
  const integrity = meta.dist?.integrity;
  if (!integrity?.startsWith("sha512-")) {
    throw new Error(
      `@typescript/${name}@${TS_VERSION} has no sha512 integrity metadata ` +
        `(got ${integrity ?? "none"}). Refusing to ship an unverified executable.`,
    );
  }
  const actual = createHash("sha512").update(bytes).digest("base64");
  if (actual !== integrity.slice("sha512-".length)) {
    throw new Error(`integrity mismatch for @typescript/${name}@${TS_VERSION}`);
  }

  // Extract to a staging directory and rename it into place. The rename is
  // atomic within a filesystem, so the cache only ever contains a payload that
  // finished extracting -- a build killed mid-tar leaves the staging directory
  // behind and the next run redownloads rather than trusting a half-tree.
  const staging = `${dest}.incoming-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const tgz = join(staging, "package.tgz");
    writeFileSync(tgz, bytes);
    // --strip-components=1 drops npm's "package/" wrapper directory.
    run("tar", ["-xzf", tgz, "--strip-components=1", "-C", staging], staging);
    rmSync(tgz, { force: true });
    if (!isCompleteTsgo(staging)) {
      throw new Error(`@typescript/${name}@${TS_VERSION} unpacked without a complete tsgo`);
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return join(dest, "lib");
}

/** True when this tar understands the GNU flags that make output reproducible. */
function tarIsGnu(): boolean {
  const r = spawnSync("tar", ["--version"], { encoding: "utf8" });
  return (r.stdout ?? "").includes("GNU tar");
}

async function buildTarget(target: Target): Promise<{ tarball: string; sha256: string }> {
  const dirName = `thicket-${VERSION}-${target.platform}-${target.arch}`;
  const stage = join(outRoot, dirName);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  process.stdout.write(`\n${dirName}\n`);
  run("bun", [
    "build",
    "--compile",
    `--target=${target.bunTarget}`,
    "src/cli.ts",
    "--outfile",
    join(stage, "thicket"),
  ]);

  const tsgoLib = await fetchTsgo(target);
  const tsgoOut = join(stage, "tsgo");
  mkdirSync(tsgoOut, { recursive: true });
  // The executable is published as `tsc` even though it is tsgo: the name
  // comes from the owning package, not from what the binary is. Copied under
  // that same name so `tsgo-path.ts` looks for exactly one thing.
  for (const entry of readdirSync(tsgoLib)) {
    cpSync(join(tsgoLib, entry), join(tsgoOut, entry));
  }
  chmodSync(join(tsgoOut, "tsc"), 0o755);
  // Read at runtime by `tsgoVersion()` so the compiler's identity can join the
  // config hash without spawning `tsc --version`.
  cpSync(join(dirname(tsgoLib), "package.json"), join(tsgoOut, "package.json"));

  for (const doc of ["LICENSE", "README.md"]) {
    if (existsSync(join(repoRoot, doc))) cpSync(join(repoRoot, doc), join(stage, doc));
  }

  const tarball = `${dirName}.tar.gz`;
  const reproducible = tarIsGnu()
    ? ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner"]
    : [];
  run("tar", ["-czf", tarball, ...reproducible, "-C", outRoot, dirName], outRoot);

  const tarPath = join(outRoot, tarball);
  const sha256 = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
  const binSize = statSync(join(stage, "thicket")).size;
  process.stdout.write(
    `  binary ${human(binSize)} + tsgo ${human(
      statSync(join(tsgoOut, "tsc")).size,
    )} -> ${tarball} ${human(statSync(tarPath).size)}\n`,
  );
  return { tarball, sha256 };
}

const requested = process.argv.slice(2);
const hostTriple = `bun-${process.platform}-${process.arch}`;
const selected = requested.includes("--all")
  ? TARGETS
  : requested.length > 0
    ? TARGETS.filter((t) => requested.includes(t.bunTarget) || requested.includes(t.platform))
    : TARGETS.filter((t) => t.bunTarget === hostTriple);

if (selected.length === 0) {
  throw new Error(
    `no targets matched ${requested.join(" ") || hostTriple}. ` +
      `Known: ${TARGETS.map((t) => t.bunTarget).join(", ")}, or --all`,
  );
}

mkdirSync(outRoot, { recursive: true });
const checksums: string[] = [];
for (const target of selected) {
  const { tarball, sha256 } = await buildTarget(target);
  checksums.push(`${sha256}  ${tarball}`);
}
// Sorted for the same reason every other collection in this repo is: two runs
// over the same inputs must produce byte-identical output.
checksums.sort();
writeFileSync(join(outRoot, "checksums.txt"), checksums.join("\n") + "\n");
process.stdout.write(`\n${checksums.length} artifact(s) in dist-bin/\n`);
