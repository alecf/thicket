import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_SCHEMA_VERSION, cachePathFor, clearCache, openCache } from "../src/cache/db.js";
import type { ShapedFragment } from "../src/fingerprint/shape.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "thicket-cache-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

const frag = (over: Partial<ShapedFragment> = {}): ShapedFragment => ({
  filePath: "a.ts",
  kind: "Block",
  nodeCount: 20,
  start: 0,
  end: 10,
  line: 1,
  l0: "l0-hash",
  l1: "l1-hash",
  ...over,
});

describe("openCache", () => {
  it("round-trips a file's fragments with both hashes on one row", () => {
    const cache = openCache(join(tempDir(), "cache.db"), "config-1")!;
    const rows = [frag(), frag({ start: 20, end: 30, line: 3, l0: "other", l1: "l1-hash" })];
    cache.replaceFile("a.ts", "h1", rows);

    expect(cache.fragmentsOf("a.ts")).toEqual(rows);
    cache.close();
  });

  it("preserves the emission order of a file's fragments", () => {
    const cache = openCache(join(tempDir(), "cache.db"), "config-1")!;
    // Post-order emission: a child is emitted before its parent, so the list
    // is NOT sorted by start. Reading it back sorted would reorder clusters.
    const rows = [
      frag({ start: 10, end: 40, l0: "inner" }),
      frag({ start: 0, end: 50, l0: "outer" }),
    ];
    cache.replaceFile("a.ts", "h1", rows);

    expect(cache.fragmentsOf("a.ts").map((f) => f.l0)).toEqual(["inner", "outer"]);
    cache.close();
  });

  it("keeps two fragments that share a byte range", () => {
    // Real and common: with ASI, `const x = f(1,2,3)` gives a VariableStatement
    // and a VariableDeclarationList with identical (start, end). Keyed on the
    // byte range one of them would silently vanish from the cached run.
    const cache = openCache(join(tempDir(), "cache.db"), "config-1")!;
    const rows = [
      frag({ kind: "VariableDeclarationList", start: 0, end: 30, l0: "inner" }),
      frag({ kind: "VariableStatement", start: 0, end: 30, l0: "outer" }),
    ];
    cache.replaceFile("a.ts", "h1", rows);

    expect(cache.fragmentsOf("a.ts")).toEqual(rows);
    cache.close();
  });

  it("reports a file as unchanged only when its content hash matches", () => {
    const cache = openCache(join(tempDir(), "cache.db"), "config-1")!;
    cache.replaceFile("a.ts", "h1", [frag()]);

    expect(cache.isUnchanged("a.ts", "h1")).toBe(true);
    expect(cache.isUnchanged("a.ts", "h2")).toBe(false);
    expect(cache.isUnchanged("b.ts", "h1")).toBe(false);
    cache.close();
  });

  it("replaces a file's rows rather than accumulating them", () => {
    const cache = openCache(join(tempDir(), "cache.db"), "config-1")!;
    cache.replaceFile("a.ts", "h1", [frag(), frag({ start: 20, end: 30 })]);
    cache.replaceFile("a.ts", "h2", [frag({ l0: "fresh" })]);

    expect(cache.fragmentsOf("a.ts")).toEqual([frag({ l0: "fresh" })]);
    expect(cache.isUnchanged("a.ts", "h1")).toBe(false);
    cache.close();
  });

  it("treats every file as changed when the config hash differs", () => {
    const path = join(tempDir(), "cache.db");
    const cache = openCache(path, "config-1")!;
    cache.replaceFile("a.ts", "h1", [frag()]);
    cache.close();

    const other = openCache(path, "config-2")!;
    expect(other.isUnchanged("a.ts", "h1")).toBe(false);
    expect(other.fragmentsOf("a.ts")).toEqual([]);
    other.close();
  });

  it("purges files that are no longer part of the project", () => {
    const cache = openCache(join(tempDir(), "cache.db"), "config-1")!;
    cache.replaceFile("a.ts", "h1", [frag()]);
    cache.replaceFile("gone.ts", "h2", [frag({ filePath: "gone.ts" })]);

    expect(cache.purgeExcept(["a.ts"])).toBe(1);
    expect(cache.isUnchanged("gone.ts", "h2")).toBe(false);
    expect(cache.fragmentsOf("gone.ts")).toEqual([]);
    expect(cache.isUnchanged("a.ts", "h1")).toBe(true);
    cache.close();
  });

  it("rebuilds from scratch when the stored schema version is not ours", () => {
    const path = join(tempDir(), "cache.db");
    const cache = openCache(path, "config-1")!;
    cache.replaceFile("a.ts", "h1", [frag()]);
    cache.close();
    // Stand in for a cache written by a future thicket whose row format we
    // cannot read. Poked directly, because nothing in the API can produce it.
    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(CACHE_SCHEMA_VERSION + 1),
    );
    db.close();

    const reopened = openCache(path, "config-1")!;
    expect(reopened.isUnchanged("a.ts", "h1")).toBe(false);
    // ...and it is usable afterwards, not merely empty.
    reopened.replaceFile("a.ts", "h1", [frag()]);
    expect(reopened.fragmentsOf("a.ts")).toEqual([frag()]);
    reopened.close();
  });

  it("recreates a corrupt database instead of throwing", () => {
    const path = join(tempDir(), "cache.db");
    writeFileSync(path, "this is not a sqlite database, not even close\n".repeat(64));

    const cache = openCache(path, "config-1");
    expect(cache).not.toBeNull();
    cache!.replaceFile("a.ts", "h1", [frag()]);
    expect(cache!.fragmentsOf("a.ts")).toEqual([frag()]);
    cache!.close();
    expect(readFileSync(path).subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  it("returns null rather than throwing when the cache cannot be created at all", () => {
    // The db path is a directory: unopenable, and no amount of deleting helps.
    const dir = tempDir();
    expect(openCache(dir, "config-1")).toBeNull();
  });

  it("survives a second process holding the same database", () => {
    const path = join(tempDir(), "cache.db");
    const a = openCache(path, "config-1")!;
    const b = openCache(path, "config-1")!;
    a.replaceFile("a.ts", "h1", [frag()]);
    b.replaceFile("b.ts", "h2", [frag({ filePath: "b.ts" })]);
    expect(b.isUnchanged("a.ts", "h1")).toBe(true);
    expect(a.isUnchanged("b.ts", "h2")).toBe(true);
    a.close();
    b.close();
  });
});

describe("clearCache", () => {
  it("removes the cache file and its sidecars, and is a no-op when absent", () => {
    const root = tempDir();
    const path = cachePathFor(root);
    const cache = openCache(path, "config-1")!;
    cache.replaceFile("a.ts", "h1", [frag()]);
    cache.close();

    expect(clearCache(root)).toBe(true);
    expect(clearCache(root)).toBe(false);
  });
});
