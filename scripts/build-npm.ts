/**
 * Assembles the npm side of distribution from the directories build-binary.ts
 * already produced.
 *
 * Shape is the one `typescript` itself uses, and for the same reason: a thin
 * package whose optionalDependencies are per-platform packages gated by
 * `os`/`cpu`, so npm installs exactly one of them. Each platform package is
 * byte-for-byte the tarball layout -- binary beside its tsgo -- which means
 * `tsgo-path.ts` resolves it through `process.execPath` with no npm-specific
 * code path to keep working.
 *
 * The JS fallback exists for the platforms that matrix does not cover
 * (Windows, and anything unusual). It needs `typescript` on disk, which is
 * declared as an OPTIONAL peer rather than a dependency on purpose: making it
 * a dependency would tax every install with 28MB of tsgo that the binary path
 * never touches.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binRoot = join(repoRoot, "dist-bin");
const outRoot = join(repoRoot, "dist-npm");

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  description: string;
  dependencies: Record<string, string>;
};
const VERSION = pkg.version;
const SCOPE = "@thicket";

const PLATFORMS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
] as const;

const REPOSITORY = { type: "git", url: "git+https://github.com/alecf/thicket.git" };

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

// ---- per-platform packages ------------------------------------------------

const optionalDependencies: Record<string, string> = {};
for (const { platform, arch } of PLATFORMS) {
  const source = join(binRoot, `thicket-${VERSION}-${platform}-${arch}`);
  if (!existsSync(source)) {
    throw new Error(`missing ${source}. Run \`bun run build:all\` first.`);
  }
  const name = `${SCOPE}/thicket-${platform}-${arch}`;
  const dest = join(outRoot, `thicket-${platform}-${arch}`);
  mkdirSync(dest, { recursive: true });
  cpSync(join(source, "thicket"), join(dest, "thicket"));
  cpSync(join(source, "tsgo"), join(dest, "tsgo"), { recursive: true });
  cpSync(join(repoRoot, "LICENSE"), join(dest, "LICENSE"));
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify(
      {
        name,
        version: VERSION,
        description: `${pkg.description} -- ${platform}-${arch} binary.`,
        license: "MIT",
        repository: REPOSITORY,
        // npm skips a package whose os/cpu do not match the host, which is
        // what makes exactly one of these install.
        os: [platform],
        cpu: [arch],
        // The Linux binaries are glibc-linked. npm's os/cpu matching alone
        // would install them on Alpine; `libc` is honoured by npm >=10 and
        // skips them there. Older clients still install it, which is why the
        // launcher also falls back when the binary will not start.
        ...(platform === "linux" ? { libc: ["glibc"] } : {}),
        files: ["thicket", "tsgo", "LICENSE"],
      },
      null,
      2,
    ) + "\n",
  );
  optionalDependencies[name] = VERSION;
  process.stdout.write(`  ${name}\n`);
}

// ---- the thin package -----------------------------------------------------

const thin = join(outRoot, "thicket");
mkdirSync(join(thin, "bin"), { recursive: true });

// `typescript` stays external so the fallback uses the one npm resolved rather
// than a second copy frozen into this bundle -- a bundled compiler could not
// find its own platform tsgo anyway.
const build = spawnSync(
  "bun",
  [
    "build",
    "src/cli.ts",
    "--target=node",
    // Only `typescript` stays external, and only because it must resolve its
    // own platform tsgo from a real node_modules. Everything else -- xxhash's
    // wasm included -- is bundled, or the fallback dies importing it.
    "--external",
    "typescript",
    "--outfile",
    join(thin, "fallback.js"),
  ],
  { cwd: repoRoot, stdio: "inherit" },
);
if (build.status !== 0) throw new Error("failed to bundle the node fallback");

writeFileSync(
  join(thin, "bin", "thicket.js"),
  `#!/usr/bin/env node
/**
 * Runs the per-platform binary npm installed, or explains why it could not.
 *
 * The binary sits beside its own tsgo inside the platform package, so it needs
 * no arguments or environment from here -- it locates tsgo from its own
 * process.execPath.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = \`${SCOPE}/thicket-\${process.platform}-\${process.arch}\`;
const exeName = process.platform === "win32" ? "thicket.exe" : "thicket";

function run(command, args) {
  const r = spawnSync(command, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  process.exit(r.status ?? 1);
}

let exe;
try {
  exe = join(dirname(require.resolve(pkg + "/package.json")), exeName);
} catch {
  exe = undefined; // no platform package for this os/cpu
}

let binaryFailed = false;
if (exe) {
  const r = spawnSync(exe, process.argv.slice(2), { stdio: "inherit" });
  // A binary that RAN and exited non-zero is thicket's own exit code, and must
  // be passed through untouched.
  if (!r.error) process.exit(r.status ?? 1);
  // A binary that could not START is a different thing: npm's os/cpu matching
  // installs this package on musl hosts like Alpine, where the glibc-linked
  // executable fails at the dynamic loader. Crashing there would strand a user
  // the JS fallback could have served, so fall through to it.
  binaryFailed = true;
  console.error(
    \`thicket: the prebuilt binary would not start (\${r.error.code ?? r.error.message}); \` +
      \`falling back to the JavaScript implementation.\`,
  );
}

// No binary for this platform. The bundled JS does the same work under the
// host node, but it needs the \`typescript\` package -- an optional peer, so
// that the common path is not taxed with a 28MB compiler it never runs.
try {
  require.resolve("typescript/package.json");
} catch {
  // Saying "no prebuilt binary" when one WAS installed and merely refused to
  // start -- the musl case -- sends the reader to the wrong problem entirely.
  console.error(
    (binaryFailed
      ? \`thicket: the prebuilt binary for \${process.platform}-\${process.arch} would not run, and the\\n\`
      : \`thicket: no prebuilt binary for \${process.platform}-\${process.arch}, and the\\n\`) +
      \`JavaScript fallback needs the 'typescript' package. Install it with:\\n\\n\` +
      \`  npm install typescript@${pkg.dependencies.typescript}\\n\`,
  );
  process.exit(1);
}

// Spawned rather than imported: cli.ts runs main() only when it is the entry
// point, so importing it here would exit 0 having printed nothing at all.
run(process.execPath, [
  join(dirname(fileURLToPath(import.meta.url)), "..", "fallback.js"),
  ...process.argv.slice(2),
]);
`,
);

cpSync(join(repoRoot, "README.md"), join(thin, "README.md"));
cpSync(join(repoRoot, "LICENSE"), join(thin, "LICENSE"));

writeFileSync(
  join(thin, "package.json"),
  JSON.stringify(
    {
      name: "thicket",
      version: VERSION,
      description: pkg.description,
      license: "MIT",
      repository: REPOSITORY,
      type: "module",
      bin: { thicket: "./bin/thicket.js" },
      files: ["bin", "fallback.js", "README.md", "LICENSE"],
      engines: { node: ">=24" },
      optionalDependencies,
      // Optional rather than a dependency: only the JS fallback needs it, and
      // installing it would drag tsgo in behind it for every user who already
      // got a binary.
      peerDependencies: { typescript: pkg.dependencies.typescript },
      peerDependenciesMeta: { typescript: { optional: true } },
    },
    null,
    2,
  ) + "\n",
);

process.stdout.write(`  thicket (thin, fallback + ${Object.keys(optionalDependencies).length} optional deps)\n`);
process.stdout.write(`\nnpm packages staged in dist-npm/\n`);
