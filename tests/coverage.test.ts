import { describe, expect, it } from "vitest";
import type { Cluster, Occurrence } from "../src/fingerprint/cluster.js";
import { redundantByteFraction } from "../src/report/coverage.js";

function occ(filePath: string, start: number, end: number): Occurrence {
  // Coverage is a byte measure; the line and parent fields exist on the type
  // for the ranker and play no part here.
  return { filePath, start, end, line: 1, endLine: 1, parentId: 0 };
}

function cluster(occurrences: Occurrence[]): Cluster {
  const nodeCount = 10;
  return {
    id: `c${occurrences[0]!.start}`,
    level: "L0",
    kind: "Block",
    nodeCount,
    occurrences,
    mass: nodeCount * (occurrences.length - 1),
  };
}

describe("redundantByteFraction", () => {
  it("counts every occurrence but the first as redundant", () => {
    // 3 copies of 100 bytes: 200 bytes are removable, not 300.
    const c = cluster([occ("a.ts", 0, 100), occ("a.ts", 200, 300), occ("a.ts", 400, 500)]);
    expect(redundantByteFraction([c], 1000)).toBeCloseTo(0.2);
  });

  it("is zero for a cluster of one occurrence", () => {
    expect(redundantByteFraction([cluster([occ("a.ts", 0, 100)])], 1000)).toBe(0);
  });

  it("unions overlapping clusters instead of adding them", () => {
    // The classic double count: an L1 triple whose members contain an L0 pair,
    // plus a Block nested inside its own FunctionDeclaration. Summing the
    // per-cluster masses counts the same bytes three times.
    const outer = cluster([occ("a.ts", 0, 100), occ("a.ts", 200, 300)]);
    const inner = cluster([occ("a.ts", 10, 50), occ("a.ts", 210, 250)]);
    // Only [200,300) is redundant in both; the inner cluster adds nothing.
    expect(redundantByteFraction([outer, inner], 1000)).toBeCloseTo(0.1);
  });

  it("merges partially overlapping ranges exactly once", () => {
    const a = cluster([occ("a.ts", 0, 10), occ("a.ts", 100, 200)]);
    const b = cluster([occ("a.ts", 0, 10), occ("a.ts", 150, 250)]);
    // Union of [100,200) and [150,250) is [100,250) = 150 bytes.
    expect(redundantByteFraction([a, b], 1000)).toBeCloseTo(0.15);
  });

  it("keeps identical ranges in different files apart", () => {
    const a = cluster([occ("a.ts", 0, 100), occ("b.ts", 0, 100)]);
    const b = cluster([occ("a.ts", 0, 100), occ("c.ts", 0, 100)]);
    // b.ts[0,100) and c.ts[0,100) — 200 bytes, not 100.
    expect(redundantByteFraction([a, b], 1000)).toBeCloseTo(0.2);
  });

  it("never exceeds 1, where the mass figure exceeds 100%", () => {
    // 40 nested clusters over one 100-byte file. Mass sums to far more than
    // the file contains; coverage cannot exceed the file.
    const clusters = Array.from({ length: 40 }, (_, i) =>
      cluster([occ("a.ts", 0, 100 - i), occ("a.ts", 0, 100 - i)]),
    );
    const fraction = redundantByteFraction(clusters, 100);
    expect(fraction).toBeLessThanOrEqual(1);
    expect(fraction).toBeCloseTo(1);
  });

  it("is 0 for no clusters and for an empty corpus", () => {
    expect(redundantByteFraction([], 1000)).toBe(0);
    expect(redundantByteFraction([cluster([occ("a.ts", 0, 10)])], 0)).toBe(0);
  });

  it("does not depend on the order clusters or occurrences arrive in", () => {
    const a = cluster([occ("a.ts", 200, 300), occ("a.ts", 0, 100)]);
    const b = cluster([occ("a.ts", 0, 100), occ("a.ts", 200, 300)]);
    expect(redundantByteFraction([a], 1000)).toBe(redundantByteFraction([b], 1000));
  });
});
