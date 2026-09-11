import { describe, expect, it } from "vitest";
import { TSGO_ENV_VAR, resolveTsgoPath } from "../src/extract/tsgo-path.js";

/**
 * A compiled binary cannot use `typescript`'s own exe resolution: it reads a
 * `package.json` relative to `import.meta.url`, which inside the bundle is
 * `/$bunfs/root/cli`, so it fails with `ENOENT: /$bunfs/package.json`. These
 * tests pin the fallthrough that replaces it.
 *
 * The order matters more than it looks. Step 3 answering `undefined` is what
 * keeps `bun run thicket` working from source -- there `execPath` is the Bun
 * binary, no sibling `tsgo/` exists, and stock resolution must be left alone.
 * An override rather than a fallthrough would break every developer command
 * and the determinism CI job, which runs from source deliberately.
 */

const noFiles = () => false;

describe("resolveTsgoPath", () => {
  it("prefers the explicit environment override", () => {
    const r = resolveTsgoPath({
      env: { [TSGO_ENV_VAR]: "/custom/tsc" },
      execPath: "/opt/thicket/libexec/thicket",
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
        execPath: "/opt/thicket/libexec/thicket",
        platform: "darwin",
        exists: noFiles,
      }),
    ).toThrow(/THICKET_TSGO/);
  });

  it("finds the tsgo packaged beside the executable", () => {
    const r = resolveTsgoPath({
      env: {},
      execPath: "/opt/homebrew/Cellar/thicket/0.1.0/libexec/thicket",
      platform: "darwin",
      exists: (p) => p === "/opt/homebrew/Cellar/thicket/0.1.0/libexec/tsgo/tsc",
    });
    expect(r.source).toBe("packaged");
    expect(r.path).toBe("/opt/homebrew/Cellar/thicket/0.1.0/libexec/tsgo/tsc");
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

  it("looks for tsc.exe on Windows", () => {
    const r = resolveTsgoPath({
      env: {},
      execPath: "C:\\tools\\thicket\\thicket.exe",
      platform: "win32",
      exists: () => true,
    });
    expect(r.path?.endsWith("tsc.exe")).toBe(true);
  });
});
