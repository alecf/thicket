import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffReports, formatDiff, parseReport } from "../src/report/diff.js";
import { runReport, type ReportJson } from "../src/run.js";
import { fixtureRoot } from "./helpers.js";

/**
 * The shape `diffReports` consumes is the JSON sidecar's, so the fixture
 * builder produces that shape rather than a convenient invention. A helper
 * that made up its own field names would let the real sidecar drift away from
 * the differ without a test noticing.
 */
const report = (ids: string[], mass: number) => ({
  metrics: {
    duplicatedMass: mass,
    redundantByteFraction: 0.1,
    propagationCost: 0.3,
    cycleCount: 0,
    largestScc: 0,
  },
  duplication: ids.map((id) => ({ id })),
  cycles: [],
});

describe("diffReports", () => {
  it("identifies resolved and new findings", () => {
    const d = diffReports(report(["a", "b"], 100), report(["b", "c"], 80));
    expect(d.resolved).toEqual(["a"]);
    expect(d.added).toEqual(["c"]);
    expect(d.unchanged).toEqual(["b"]);
  });

  it("reports the mass delta as a percentage", () => {
    const d = diffReports(report(["a"], 100), report(["a"], 80));
    expect(d.massDeltaPct).toBeCloseTo(-20);
  });

  it("handles an empty before-report without dividing by zero", () => {
    const d = diffReports(report([], 0), report(["a"], 10));
    expect(Number.isFinite(d.massDeltaPct)).toBe(true);
  });

  it("calls no change no change when both reports are empty", () => {
    const d = diffReports(report([], 0), report([], 0));
    expect(d.massDeltaPct).toBe(0);
  });

  it("diffs cycle findings alongside duplication findings", () => {
    const before = { ...report(["a"], 10), cycles: [{ id: "THK-CYC-1" }] };
    const after = { ...report(["a"], 10), cycles: [] };
    const d = diffReports(before, after);
    expect(d.resolved).toEqual(["THK-CYC-1"]);
    expect(d.unchanged).toEqual(["a"]);
  });

  it("orders each list deterministically", () => {
    const d = diffReports(report(["b", "a", "C"], 10), report(["z", "A"], 10));
    expect(d.resolved).toEqual([...d.resolved].sort());
    expect(d.added).toEqual([...d.added].sort());
    expect(d.resolved).toEqual(["C", "a", "b"]);
  });

  it("carries every metric as a before/after pair", () => {
    const before = report(["a"], 100);
    const after = { ...report(["a"], 80), metrics: { ...report([], 80).metrics, propagationCost: 0.29 } };
    const d = diffReports(before, after);
    expect(d.metrics.propagationCost).toEqual({ before: 0.3, after: 0.29 });
    expect(d.metrics.duplicatedMass).toEqual({ before: 100, after: 80 });
  });
});

describe("formatDiff", () => {
  it("summarizes the diff in the shape the PRD specifies", () => {
    const before = report(["a", "b", "c", "d"], 100);
    const after = { ...report(["d", "e"], 88), metrics: { ...report([], 88).metrics, propagationCost: 0.29 } };
    const line = formatDiff(diffReports(before, after));
    expect(line).toContain("3 findings resolved");
    expect(line).toContain("1 new");
    expect(line).toContain("duplicated mass -12.0%");
    expect(line).toContain("propagation cost 0.30 -> 0.29");
  });

  it("says so plainly when nothing moved", () => {
    const line = formatDiff(diffReports(report(["a"], 10), report(["a"], 10)));
    expect(line).toContain("0 findings resolved");
    expect(line).toContain("0 new");
  });

  it("counts one finding in the singular", () => {
    const line = formatDiff(diffReports(report(["a", "b"], 10), report(["b"], 10)));
    expect(line).toContain("1 finding resolved");
  });
});

describe("parseReport", () => {
  it("accepts a real JSON sidecar", async () => {
    const { json } = await runReport({ config: join(fixtureRoot(), "tsconfig.json"), minNodes: 15, cache: false });
    const round = parseReport(JSON.parse(JSON.stringify(json)), "sidecar.json");
    expect(round.duplication.length).toBe(json.duplication.length);
  });

  it("rejects a file that is not a thicket report, naming it", () => {
    expect(() => parseReport({ hello: "world" }, "notes.json")).toThrow(/notes\.json/);
    expect(() => parseReport({ hello: "world" }, "notes.json")).toThrow(/thicket report/i);
  });

  it("rejects a report whose findings lack ids", () => {
    const broken = { ...report(["a"], 1), duplication: [{ score: 3 }] };
    expect(() => parseReport(broken, "broken.json")).toThrow(/broken\.json/);
  });
});

// ---------------------------------------------------------------------------
// The property the whole feature rests on.
//
// Every test above operates on hand-written id strings, so all of them would
// still pass if `findingId` were derived from a byte offset and every id
// churned on every edit. That is the difference between a harness measuring
// progress and a harness measuring noise, so it gets an end-to-end test
// against a real code move.
// ---------------------------------------------------------------------------

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** A throwaway copy of the sample fixture, so a test may rewrite its sources. */
function scratchProject(): { root: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "thicket-diff-"));
  temps.push(root);
  // Skip any `.thicket/` the suite left in the fixture: copying one in would
  // hand a "cold" run a warm cache.
  cpSync(fixtureRoot(), root, {
    recursive: true,
    filter: (src) => !src.split(sep).includes(".thicket"),
  });
  return { root, config: join(root, "tsconfig.json") };
}

const INSERTED_COMMENT = `/*
 * A comment block inserted above the functions. It changes every byte offset
 * and every line number below it, and none of the code.
 */
`;

/**
 * Rewrites a file so its top-level functions swap places with a comment block
 * and blank lines above them, and their text is otherwise byte-identical.
 *
 * The bodies are lifted out of the original source rather than retyped, so the
 * test cannot accidentally "move" code while also editing it — which would
 * make a changed id the correct answer and the assertion meaningless.
 */
function moveDeclarations(source: string): string {
  const first = source.indexOf("export function ");
  const head = source.slice(0, first);
  const bodies = source
    .slice(first)
    .split(/\n\n(?=export function )/)
    .map((b) => b.trimEnd());
  if (bodies.length !== 2) throw new Error(`expected two declarations, got ${bodies.length}`);
  return `${head.trimEnd()}\n\n\n${INSERTED_COMMENT}\n${bodies[1]}\n\n\n${bodies[0]}\n`;
}

async function reportOn(config: string): Promise<ReportJson> {
  return (await runReport({ config, minNodes: 15, cache: false })).json;
}

const dupIds = (json: ReportJson) => json.duplication.map((d) => d.id);

describe("finding ids across a real edit", () => {
  it("keeps every duplication id when the code only moves", async () => {
    const { root, config } = scratchProject();
    const beta = join(root, "src/beta.ts");
    const before = await reportOn(config);
    expect(before.duplication.length).toBeGreaterThan(0);

    const original = readFileSync(beta, "utf8");
    const moved = moveDeclarations(original);
    // The move must be real: same code, different bytes.
    expect(moved).not.toBe(original);
    for (const body of original.split(/\n\n(?=export function )/).slice(1)) {
      expect(moved).toContain(body.trimEnd());
    }
    writeFileSync(beta, moved);

    const after = await reportOn(config);

    // The positions really did shift...
    const positionsOf = (j: ReportJson) =>
      j.duplication.flatMap((d) =>
        d.occurrences
          .filter((o) => o.filePath === "src/beta.ts")
          .map((o) => `${o.line}:${o.start}-${o.end}`),
      );
    expect(positionsOf(after)).not.toEqual(positionsOf(before));

    // ...and the ids did not.
    expect(dupIds(after)).toEqual(dupIds(before));
    const d = diffReports(before, after);
    expect(d.resolved).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.unchanged.length).toBe(dupIds(before).length + before.cycles.length);
  });

  it("reports a genuinely deleted copy as resolved", async () => {
    // The negative control. Without it the test above passes just as happily
    // against a differ that answers "nothing changed" unconditionally.
    const { root, config } = scratchProject();
    const beta = join(root, "src/beta.ts");
    const before = await reportOn(config);

    const original = readFileSync(beta, "utf8");
    const bodies = original.split(/\n\n(?=export function )/);
    // Drop `normalizeExact` — the second copy of alpha.ts's function.
    writeFileSync(beta, bodies.slice(0, -1).join("\n\n").trimEnd() + "\n");

    const after = await reportOn(config);
    const d = diffReports(before, after);
    expect(d.resolved.length).toBeGreaterThan(0);
    expect(new Set(dupIds(after)).size).toBeLessThan(new Set(dupIds(before)).size);
    expect(d.massDeltaPct).toBeLessThan(0);
  });
});
