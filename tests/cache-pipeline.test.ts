import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachePathFor, openCache } from "../src/cache/db.js";
import { openProject } from "../src/extract/ts-adapter.js";
import { findDuplication } from "../src/fingerprint/cluster.js";
import { runReport } from "../src/run.js";
import { fixtureRoot } from "./helpers.js";

const temps: string[] = [];

/**
 * Semicolon-free source, where a statement and its sole child expression have
 * *identical* start and end offsets. Both are real fragments, so a cache keyed
 * on the byte range silently keeps only one of them — on a 146-file test
 * repository that is 6% of all fragments, and it shows up only on the warm
 * path. The sample fixture is fully semicolon'd and never exercises it.
 */
const ASI_SOURCE = `export const totals: number[] = []

export function accumulate(rows: number[][]): void {
  for (const row of rows) {
    let sum = 0
    for (const value of row) {
      sum = sum + value * 2 - 1
    }
    totals.push(sum)
  }
}

export function accumulateAgain(rows: number[][]): void {
  for (const row of rows) {
    let sum = 0
    for (const value of row) {
      sum = sum + value * 2 - 1
    }
    totals.push(sum)
  }
}
`;

/** A throwaway copy of the sample fixture, so tests may edit and delete files. */
function scratchProject(): { root: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "thicket-proj-"));
  temps.push(root);
  // Skip any `.thicket/` the suite left in the fixture: copying one in would
  // hand a "cold" run a warm cache, and hide exactly what these tests check.
  cpSync(fixtureRoot(), root, {
    recursive: true,
    filter: (src) => !src.split(sep).includes(".thicket"),
  });
  writeFileSync(join(root, "src/asi.ts"), ASI_SOURCE);
  return { root, config: join(root, "tsconfig.json") };
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

const MIN_NODES = 8;

async function clustersWithCache(config: string, cachePath: string | undefined) {
  const project = await openProject(config);
  const cache = cachePath === undefined ? null : openCache(cachePath, "cfg-1");
  try {
    return await findDuplication(project, { minNodes: MIN_NODES, cache });
  } finally {
    cache?.close();
    project.close();
  }
}

describe("cached duplication analysis", () => {
  it("produces findings identical to the uncached analysis", async () => {
    const { root, config } = scratchProject();
    const cachePath = join(root, "cache.db");

    const uncached = await clustersWithCache(config, undefined);
    const cold = await clustersWithCache(config, cachePath); // populates
    const warm = await clustersWithCache(config, cachePath); // reads back

    // Not a smoke test: if these differ the cache has changed the answer,
    // which is worse than having no cache at all.
    expect(cold).toEqual(uncached);
    expect(warm).toEqual(uncached);
    // Order too — `id` ties are broken by insertion order via a stable sort.
    expect(warm.map((c) => `${c.id}:${c.level}:${c.mass}`)).toEqual(
      uncached.map((c) => `${c.id}:${c.level}:${c.mass}`),
    );
    expect(uncached.length).toBeGreaterThan(0);

    // Guard against the test passing because the warm run quietly re-walked
    // everything: every file must be a cache hit, which is the exact predicate
    // `findDuplication` branches on.
    const project = await openProject(config);
    const cache = openCache(cachePath, "cfg-1")!;
    const hits = project.files().filter((f) => cache.isUnchanged(f.path, f.contentHash));
    expect(hits.length).toBe(project.files().length);
    expect(hits.length).toBeGreaterThan(1);
    // ...and the byte-range collision the ASI file creates really is present.
    const ranges = cache.fragmentsOf("src/asi.ts").map((f) => `${f.start}:${f.end}`);
    expect(ranges.length).toBeGreaterThan(new Set(ranges).size);
    cache.close();
    project.close();
  });

  it("re-analyzes only the file that changed, and gets the same answer", async () => {
    const { root, config } = scratchProject();
    const cachePath = join(root, "cache.db");
    await clustersWithCache(config, cachePath);

    writeFileSync(
      join(root, "src/gamma.ts"),
      readFileSync(join(root, "src/gamma.ts"), "utf8") +
        "\nexport function added(a: number, b: number): number {\n  return a * b + a - b;\n}\n",
    );

    const warm = await clustersWithCache(config, cachePath);
    const cold = await clustersWithCache(config, join(root, "fresh.db"));
    expect(warm).toEqual(cold);
  });

  it("does not let a deleted file haunt later runs", async () => {
    const { root, config } = scratchProject();
    const cachePath = join(root, "cache.db");
    const before = await clustersWithCache(config, cachePath);
    rmSync(join(root, "src/beta.ts"));

    const warm = await clustersWithCache(config, cachePath);
    const cold = await clustersWithCache(config, join(root, "fresh.db"));
    expect(warm).toEqual(cold);
    expect(warm).not.toEqual(before);
    expect(JSON.stringify(warm)).not.toContain("beta.ts");
  });
});

describe("runReport with the cache", () => {
  it("emits a byte-identical report cold and warm", async () => {
    const { root, config } = scratchProject();
    const cold = await runReport({ config, minNodes: MIN_NODES });
    expect(existsSync(cachePathFor(root))).toBe(true);
    const warm = await runReport({ config, minNodes: MIN_NODES });

    expect(warm.markdown).toBe(cold.markdown);
    expect(warm.json).toEqual(cold.json);
  });

  it("matches the report produced with --no-cache", async () => {
    const cached = scratchProject();
    const plain = scratchProject();
    const withCache = await runReport({ config: cached.config, minNodes: MIN_NODES });
    await runReport({ config: cached.config, minNodes: MIN_NODES });
    const warm = await runReport({ config: cached.config, minNodes: MIN_NODES });
    const without = await runReport({ config: plain.config, minNodes: MIN_NODES, cache: false });

    expect(existsSync(cachePathFor(plain.root))).toBe(false);
    expect(withCache.markdown).toBe(without.markdown);
    expect(warm.markdown).toBe(without.markdown);
  });

  it("invalidates everything when a config knob changes", async () => {
    const { config } = scratchProject();
    await runReport({ config, minNodes: MIN_NODES });
    const warm = await runReport({ config, minNodes: 20 });
    const cold = await runReport({ config, minNodes: 20, cache: false });
    expect(warm.markdown).toBe(cold.markdown);
  });

  it("still produces a report when the cache file is garbage", async () => {
    const { root, config } = scratchProject();
    const expected = await runReport({ config, minNodes: MIN_NODES, cache: false });

    // Let a real run create .thicket/, then corrupt what it left behind.
    await runReport({ config, minNodes: MIN_NODES });
    writeFileSync(cachePathFor(root), "not a database\n".repeat(500));

    const recovered = await runReport({ config, minNodes: MIN_NODES });
    expect(recovered.markdown).toBe(expected.markdown);

    // ...and the recreated cache is usable on the next run.
    const warm = await runReport({ config, minNodes: MIN_NODES });
    expect(warm.markdown).toBe(expected.markdown);
  });
});
