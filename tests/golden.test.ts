import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReport } from "../src/run.js";
import { fixtureConfig, fixtureRoot } from "./helpers.js";

/**
 * The report is contractually a pure function of (source content, config,
 * thicket version) — PRD §9.4. Every other test asserts a property of the
 * output; this one pins the output itself, which is the only way a change that
 * quietly reorders or reformats something shows up as a diff rather than as
 * phantom churn in somebody's loop three weeks later.
 *
 * Regenerate with `UPDATE_GOLDEN=1 npx vitest run tests/golden.test.ts`, then
 * READ the diff. A golden file that pins wrong output is worse than no golden
 * file, because it converts a bug into a requirement.
 */
const GOLDEN = new URL("./golden/sample-report.md", import.meta.url);

const OPTIONS = { config: fixtureConfig(), minNodes: 15 } as const;

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

/**
 * A copy of the sample fixture at a fresh absolute path.
 *
 * Used for the warm-cache runs so they cannot race the rest of the suite over
 * `tests/fixtures/sample/.thicket`, and it doubles as a check that the report
 * does not depend on where the project sits on disk: the same bytes must come
 * out of a directory with a random name in it.
 */
function scratchProject(): { root: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "thicket-golden-"));
  temps.push(root);
  cpSync(fixtureRoot(), root, {
    recursive: true,
    filter: (src) => !src.split(sep).includes(".thicket"),
  });
  return { root, config: join(root, "tsconfig.json") };
}

describe("golden report", () => {
  it("matches the committed golden file", async () => {
    const { markdown } = await runReport({ ...OPTIONS, cache: false });

    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(GOLDEN, markdown);
      // Deliberately a failure, not a silent pass. A CI job with UPDATE_GOLDEN
      // set in its environment would otherwise go green while comparing the
      // output to itself — the golden file's entire value gone, with no signal
      // that it happened.
      expect.fail(
        "UPDATE_GOLDEN was set: the golden file has been regenerated. " +
          "Read the diff, then re-run without the flag to actually compare.",
      );
    }

    expect(markdown).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("does not vary with file iteration order", async () => {
    const runs = await Promise.all([
      runReport({ ...OPTIONS, cache: false }),
      runReport({ ...OPTIONS, cache: false }),
      runReport({ ...OPTIONS, cache: false }),
    ]);
    expect(new Set(runs.map((r) => r.markdown)).size).toBe(1);
  });

  it("produces the same bytes cold and warm", async () => {
    // AGENTS.md §5: the cache is an optimization and may never change the
    // answer. `cache-pipeline.test.ts` proves that on the cluster lists; here
    // it costs one extra run to keep proving it on the exact bytes a harness
    // reads, against a file that is checked in and therefore reviewable.
    const golden = readFileSync(GOLDEN, "utf8");
    const { config } = scratchProject();

    const cold = await runReport({ ...OPTIONS, config, cache: false });
    const primed = await runReport({ ...OPTIONS, config, cache: true }); // writes
    const warm = await runReport({ ...OPTIONS, config, cache: true }); // reads back

    expect(cold.markdown).toBe(golden);
    expect(primed.markdown).toBe(golden);
    expect(warm.markdown).toBe(golden);
  });

  it("is the report the README claims it is", async () => {
    // The README prints this report and says "prints exactly this". That claim
    // rots the first time the format changes, and a tool whose entire thesis
    // is deterministic output cannot afford documentation that lies about it.
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    // The outer fence must be longer than the ```ts fences the report itself
    // now contains, so this matches a run of at least four backticks and
    // requires the closing run to be the same one.
    const example = readme.match(/(`{4,})markdown\n(# thicket report\n[\s\S]*?)\1/);
    expect(example).not.toBeNull();
    expect(example![2]).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("holds the golden file to the invariants the report claims", async () => {
    // Guards against a regenerated golden pinning output that is merely
    // stable. Each of these is a property the report is supposed to have, so
    // a `UPDATE_GOLDEN` run that captured a broken report still fails here.
    const golden = readFileSync(GOLDEN, "utf8");
    const { json } = await runReport({ ...OPTIONS, cache: false });

    expect(golden.startsWith("# thicket report\n")).toBe(true);
    expect(golden.endsWith("\n")).toBe(true);
    expect(golden).not.toContain("\r\n"); // CI compares Linux and macOS bytes
    expect(golden).not.toMatch(/^\//m); // no absolute paths
    expect(golden).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates
    expect(golden).not.toMatch(/\bms\b|\bseconds?\b/); // no durations

    // Every finding id in the golden is one the run actually produced...
    const ids = new Set([...json.duplication.map((d) => d.id), ...json.cycles.map((c) => c.id)]);
    const printed = golden.match(/THK-[A-Z]{3}-[0-9a-f]{8}/g) ?? [];
    expect(printed.length).toBeGreaterThan(0);
    for (const id of printed) expect(ids.has(id)).toBe(true);

    // ...and the "N of M" line is honest about how many it printed.
    const shown = golden.match(/\| findings \| (\d+) of (\d+) shown \|/);
    expect(shown).not.toBeNull();
    expect(Number(shown![1])).toBe(printed.length);
    expect(Number(shown![2])).toBe(json.totalFindings);
  });
});
