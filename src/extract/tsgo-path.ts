import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { version as pinnedTypeScriptVersion } from "typescript";
import { compareStrings } from "../order.js";

/**
 * Escape hatch for pointing thicket at a different tsgo build. It changes the
 * finding set, so `tsgoVersion()` folds the answer into the config hash --
 * otherwise a warm cache would serve a report produced by a compiler the
 * reader cannot see (AGENTS.md §4b, §5).
 */
export const TSGO_ENV_VAR = "THICKET_TSGO";

/** Where the tsgo executable came from. */
export type TsgoSource = "env" | "packaged" | "node_modules";

export interface TsgoResolution {
  /**
   * Absolute path to the tsgo executable, or `undefined` to mean "let the
   * `typescript` package resolve it as it normally would".
   */
  path: string | undefined;
  source: TsgoSource;
  /** Every location tried, in order, for the error message. */
  searched: string[];
}

/**
 * Pure so the fallthrough can be tested without a filesystem or a real
 * compiled binary; `resolveTsgo()` below supplies the real world.
 */
export function resolveTsgoPath(opts: {
  env: Record<string, string | undefined>;
  execPath: string;
  platform: string;
  exists: (p: string) => boolean;
  /**
   * Injectable because the host's `path` is POSIX here and Windows there, so a
   * win32 case asserted against POSIX `dirname` proves nothing: `dirname` of a
   * backslash path returns ".", and the sibling lookup silently becomes a
   * relative one that still ends in "tsc.exe".
   */
  path?: { dirname: (p: string) => string; join: (...parts: string[]) => string };
}): TsgoResolution {
  const { env, execPath, platform, exists } = opts;
  const { dirname: dirOf, join: joinOf } = opts.path ?? { dirname, join };
  // The published bin is named `tsc` even though it is tsgo: the name comes
  // from the owning package (`typescript`), not from what the binary is.
  const binName = platform === "win32" ? "tsc.exe" : "tsc";

  const override = env[TSGO_ENV_VAR];
  if (override) {
    if (!exists(override)) {
      throw new Error(
        `${TSGO_ENV_VAR} is set to ${override}, which does not exist. ` +
          `Unset it to use the tsgo thicket ships with.`,
      );
    }
    return { path: override, source: "env", searched: [override] };
  }

  // The packaged layout: libexec/thicket beside libexec/tsgo/tsc. `execPath`
  // is used rather than `import.meta.url` because inside a compiled binary the
  // latter is `file:///$bunfs/root/cli` -- a virtual path with no filesystem
  // under it. `execPath` also resolves THROUGH the Homebrew `bin/` symlink to
  // the real `libexec/` location, which is what makes the symlink work.
  const packaged = joinOf(dirOf(execPath), "tsgo", binName);
  if (exists(packaged)) {
    return { path: packaged, source: "packaged", searched: [packaged] };
  }

  // Running from source, or from npm with a real node_modules: `typescript`
  // finds its own platform package. Answering `undefined` rather than a guess
  // is deliberate -- see tests/tsgo-path.test.ts.
  return { path: undefined, source: "node_modules", searched: [packaged] };
}

/** The same decision, against the real process and filesystem. */
export function resolveTsgo(): TsgoResolution {
  return resolveTsgoPath({
    env: process.env,
    execPath: process.execPath,
    platform: process.platform,
    exists: existsSync,
  });
}

/** Injectable so the identity rules can be tested without a real compiler. */
export interface TsgoIo {
  readText: (path: string) => string;
  readBytes: (path: string) => Buffer;
  /** Entry names directly inside `dir`. */
  listDir: (dir: string) => string[];
}

const defaultIo: TsgoIo = {
  readText: (p) => readFileSync(p, "utf8"),
  readBytes: (p) => readFileSync(p),
  listDir: (d) => readdirSync(d),
};

/** The `version` beside the executable, if there is a trustworthy one. */
function versionBeside(exe: string, io: TsgoIo): string | undefined {
  try {
    const parsed: unknown = JSON.parse(io.readText(join(dirname(exe), "package.json")));
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const v = (parsed as { version: unknown }).version;
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    // No manifest, or an unreadable one. Handled by the caller, which must not
    // paper over it -- see below.
  }
  return undefined;
}

/**
 * The identity of the tsgo the report was produced with.
 *
 * Part of the report's identity for the same reason `VERSION` is: a different
 * compiler parses and resolves differently, so two reports that share a config
 * hash must have been produced by the same one. The cache is keyed on that
 * hash (AGENTS.md §5), which is what makes a WRONG answer here worse than an
 * unknown one -- a different compiler would share the bundled compiler's hash
 * and read back a report it never produced.
 *
 * So the bundled pin is used only when `typescript` resolved tsgo itself, where
 * it is correct by construction. An overridden or packaged compiler is
 * identified by the manifest the build drops beside it, and failing that by its
 * own bytes -- content-addressed, like everything else here, so it is stable
 * across machines and paths but differs the moment the compiler does.
 */
export function tsgoVersion(
  resolution: TsgoResolution = resolveTsgo(),
  io: TsgoIo = defaultIo,
): string {
  // `typescript` resolved its own platform package, which is pinned exactly by
  // package.json -- so the bundled version IS the compiler's version.
  if (!resolution.path) return pinnedTypeScriptVersion;

  // The manifest is trusted for the PACKAGED compiler only, where
  // scripts/build-binary.ts writes it and the executable out of the same
  // integrity-checked tarball, so the two cannot disagree.
  //
  // An override's manifest is not evidence of anything: rebuild a patched tsgo
  // and its version string does not move, so two different compilers would
  // present the same version, share a configHash, and let the warm cache serve
  // findings the other one produced.
  if (resolution.source === "packaged") {
    const labelled = versionBeside(resolution.path, io);
    if (labelled) return labelled;
  }

  // An unlabelled compiler. Borrowing `pinnedTypeScriptVersion` here would be
  // the cache bug described above, so hash what is actually going to run --
  // the executable AND the stdlib beside it, because tsgo reads those
  // lib.*.d.ts files and editing one changes type resolution, and therefore
  // the findings, without touching the binary.
  const dir = dirname(resolution.path);
  const digest = createHash("sha256");
  // Sorted so the identity is a property of the payload and not of readdir
  // order, which is a filesystem detail that differs between machines.
  for (const entry of [...io.listDir(dir)].sort(compareStrings)) {
    digest.update(entry).update("\u0000");
    try {
      digest.update(io.readBytes(join(dir, entry)));
    } catch {
      // A directory or unreadable entry still contributes its name above.
    }
  }
  return `sha256:${digest.digest("hex").slice(0, 16)}`;
}
