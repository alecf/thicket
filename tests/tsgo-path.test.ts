import { describe, expect, it } from "vitest";
import { win32 } from "node:path";
import { version as pinnedVersion } from "typescript";
import { TSGO_ENV_VAR, resolveTsgoPath, tsgoVersion } from "../src/extract/tsgo-path.js";

/**
 * A compiled binary cannot use `typescript`'s own exe resolution: it reads a
 * `package.json` relative to `import.meta.url`, which inside the bundle is
 * `/$bunfs/root/cli`, so it fails with `ENOENT: /$bunfs/package.json`. These
 * tests pin the fallthrough that replaces it.
 *
 * The order matters more than it looks. Step 3 answering `undefined` is what
 * keeps `bun run underbrush` working from source -- there `execPath` is the Bun
 * binary, no sibling `tsgo/` exists, and stock resolution must be left alone.
 * An override rather than a fallthrough would break every developer command
 * and the determinism CI job, which runs from source deliberately.
 */

const noFiles = () => false;

describe("resolveTsgoPath", () => {
  it("prefers the explicit environment override", () => {
    const r = resolveTsgoPath({
      env: { [TSGO_ENV_VAR]: "/custom/tsc" },
      execPath: "/opt/underbrush/libexec/underbrush",
      platform: "darwin",
      exists: (p) => p === "/custom/tsc",
    });
    expect(r).toEqual({ path: "/custom/tsc", source: "env", searched: ["/custom/tsc"] });
  });

  it("throws rather than falling through when the override does not exist", () => {
    // An override that silently degrades to a different tsgo would change the
    // report while the reader believes they pinned one, so this is a bug and
    // not a missing file.
    expect(() =>
      resolveTsgoPath({
        env: { [TSGO_ENV_VAR]: "/gone/tsc" },
        execPath: "/opt/underbrush/libexec/underbrush",
        platform: "darwin",
        exists: noFiles,
      }),
    ).toThrow(/UNDERBRUSH_TSGO/);
  });

  it("finds the tsgo packaged beside the executable", () => {
    const r = resolveTsgoPath({
      env: {},
      execPath: "/opt/homebrew/Cellar/underbrush/0.1.0/libexec/underbrush",
      platform: "darwin",
      exists: (p) => p === "/opt/homebrew/Cellar/underbrush/0.1.0/libexec/tsgo/tsc",
    });
    expect(r.source).toBe("packaged");
    expect(r.path).toBe("/opt/homebrew/Cellar/underbrush/0.1.0/libexec/tsgo/tsc");
  });

  it("leaves resolution to typescript when nothing is packaged", () => {
    // Running from source: execPath is the Bun binary itself.
    const r = resolveTsgoPath({
      env: {},
      execPath: "/Users/x/.bun/bin/bun",
      platform: "darwin",
      exists: noFiles,
    });
    expect(r.path).toBeUndefined();
    expect(r.source).toBe("node_modules");
    expect(r.searched).toEqual(["/Users/x/.bun/bin/tsgo/tsc"]);
  });

  it("looks for tsc.exe beside the executable on Windows", () => {
    // `path: win32` is load-bearing. With the host's POSIX path module,
    // dirname("C:\\tools\\underbrush\\underbrush.exe") is "." and this asserts
    // nothing about where the sibling lookup landed -- the old suffix-only
    // assertion passed against the relative path "tsgo/tsc.exe".
    const r = resolveTsgoPath({
      env: {},
      execPath: "C:\\tools\\underbrush\\underbrush.exe",
      platform: "win32",
      exists: () => true,
      path: win32,
    });
    expect(r.path).toBe("C:\\tools\\underbrush\\tsgo\\tsc.exe");
  });
});

/**
 * The config hash keys the cache, so a tsgo whose identity is wrong is worse
 * than one that is unknown: a different compiler silently shares the bundled
 * compiler's hash and reads back a report it never produced (AGENTS.md §5).
 */
describe("tsgoVersion", () => {
  const io = (files: Record<string, string>) => ({
    readText: (p: string) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    },
    readBytes: (p: string) => Buffer.from(files[p] ?? ""),
    // Every entry in the directory holding the executable, which is where the
    // stdlib lives too.
    listDir: (dir: string) =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/"))
        .map((f) => f.slice(dir.length + 1)),
  });

  it("uses the bundled pin when typescript resolves tsgo itself", () => {
    // Nothing was overridden, so the compiler is the one the pinned
    // `typescript` package brings -- which is exactly the bundled version.
    const v = tsgoVersion({ path: undefined, source: "node_modules", searched: [] }, io({}));
    expect(v).toBe(pinnedVersion);
  });

  it("reads the version from the manifest beside the executable", () => {
    const v = tsgoVersion(
      { path: "/opt/underbrush/tsgo/tsc", source: "packaged", searched: [] },
      io({ "/opt/underbrush/tsgo/package.json": '{"version":"7.9.9-custom"}' }),
    );
    expect(v).toBe("7.9.9-custom");
  });

  it("does not trust a manifest an override brought with it", () => {
    // The sharp case: two different $UNDERBRUSH_TSGO compilers can each sit beside
    // a manifest claiming the same version -- rebuild a patched tsgo and the
    // version string does not move. Trusting it would hand both the same
    // configHash, and the warm cache would serve findings produced by the other
    // one. Only the PACKAGED manifest is trustworthy, because this repo's build
    // writes it and the executable from the same verified tarball.
    const manifest = '{"version":"7.1.0-dev.20260808.1"}';
    const first = tsgoVersion(
      { path: "/custom/tsc", source: "env", searched: [] },
      io({ "/custom/tsc": "original compiler", "/custom/package.json": manifest }),
    );
    const patched = tsgoVersion(
      { path: "/custom/tsc", source: "env", searched: [] },
      io({ "/custom/tsc": "patched compiler", "/custom/package.json": manifest }),
    );
    expect(first).not.toBe(patched);
    expect(first).not.toBe("7.1.0-dev.20260808.1");
  });

  it("identifies an unlabelled compiler by its bytes, never by the bundled pin", () => {
    // The bug this pins: falling back to the bundled version here would let a
    // DIFFERENT compiler share the bundled one's config hash.
    const v = tsgoVersion(
      { path: "/custom/tsc", source: "env", searched: [] },
      io({ "/custom/tsc": "a different compiler" }),
    );
    expect(v).not.toBe(pinnedVersion);
    expect(v).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("notices when only the stdlib beside the compiler changed", () => {
    // tsgo READS the sibling lib.*.d.ts files; edit one and type resolution --
    // and therefore the findings -- change while the executable is untouched.
    // An identity covering only the executable would hand both the same
    // configHash and let the warm cache answer for the other one.
    const identity = (libDts: string) =>
      tsgoVersion(
        { path: "/custom/tsc", source: "env", searched: [] },
        io({ "/custom/tsc": "same compiler", "/custom/lib.d.ts": libDts }),
      );
    expect(identity("declare var x: number;")).not.toBe(identity("declare var x: string;"));
  });

  it("gives two different unlabelled compilers two different identities", () => {
    const one = tsgoVersion(
      { path: "/a/tsc", source: "env", searched: [] },
      io({ "/a/tsc": "compiler one" }),
    );
    const two = tsgoVersion(
      { path: "/b/tsc", source: "env", searched: [] },
      io({ "/b/tsc": "compiler two" }),
    );
    expect(one).not.toBe(two);
  });

  it("is stable for the same bytes at a different path", () => {
    // Determinism: the identity is the compiler, not where it happens to sit.
    const here = tsgoVersion(
      { path: "/here/tsc", source: "env", searched: [] },
      io({ "/here/tsc": "same bytes" }),
    );
    const there = tsgoVersion(
      { path: "/there/tsc", source: "env", searched: [] },
      io({ "/there/tsc": "same bytes" }),
    );
    expect(here).toBe(there);
  });
});
