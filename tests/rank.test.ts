import { describe, expect, it } from "vitest";
import { isTestPath, rankClusters, subsume } from "../src/report/rank.js";
import type { Cluster } from "../src/fingerprint/cluster.js";

const occ = (filePath: string, start: number, end: number, line = 1) => ({
  filePath,
  start,
  end,
  line,
});

const cluster = (over: Partial<Cluster>): Cluster => ({
  id: "x",
  level: "L0",
  kind: "Block",
  nodeCount: 10,
  occurrences: [occ("src/a.ts", 0, 5), occ("src/b.ts", 0, 5)],
  mass: 10,
  ...over,
});

describe("isTestPath", () => {
  it("recognizes common test conventions", () => {
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("src/a.spec.tsx")).toBe(true);
    expect(isTestPath("tests/a.ts")).toBe(true);
    expect(isTestPath("src/__tests__/a.ts")).toBe(true);
    expect(isTestPath("src/attest.ts")).toBe(false);
    expect(isTestPath("src/latest/a.ts")).toBe(false); // must not match "test" inside a word
  });
});

describe("rankClusters", () => {
  it("ranks higher mass first", () => {
    const ranked = rankClusters([
      cluster({ id: "lo", mass: 10 }),
      cluster({ id: "hi", mass: 100 }),
    ]);
    expect(ranked[0]!.cluster.id).toBe("hi");
  });

  it("ranks cross-directory duplication above intra-file", () => {
    const cross = cluster({ id: "cross", mass: 50 });
    const intra = cluster({
      id: "intra",
      mass: 50,
      occurrences: [occ("src/a.ts", 0, 5), occ("src/a.ts", 9, 14)],
    });
    const ranked = rankClusters([intra, cross]);
    expect(ranked[0]!.cluster.id).toBe("cross");
  });

  it("uses real module membership when given a module map", () => {
    // Same two files. With a module map that puts them in DIFFERENT modules the
    // cluster must outrank the identical one whose files share a module.
    const a = cluster({ id: "aaa", mass: 50 });
    const b = cluster({ id: "bbb", mass: 50 });
    const split = { "src/a.ts": "core", "src/b.ts": "ui" };
    const same = { "src/a.ts": "core", "src/b.ts": "core" };
    const scoreSplit = rankClusters([a], split)[0]!.score;
    const scoreSame = rankClusters([b], same)[0]!.score;
    expect(scoreSplit).toBeGreaterThan(scoreSame);
  });

  it("down-weights all-test clusters but not mixed ones", () => {
    const allTest = cluster({
      id: "test",
      mass: 50,
      occurrences: [occ("src/a.test.ts", 0, 5), occ("src/b.test.ts", 0, 5)],
    });
    const mixed = cluster({
      id: "mixed",
      mass: 50,
      occurrences: [occ("src/a.test.ts", 0, 5), occ("src/b.ts", 0, 5)],
    });
    const ranked = rankClusters([allTest, mixed]);
    expect(ranked[0]!.cluster.id).toBe("mixed");
    expect(ranked.find((r) => r.cluster.id === "test")!.tag).toBe("test");
    expect(ranked.find((r) => r.cluster.id === "mixed")!.tag).toBe("mixed");
  });

  it("tags a cluster with no test occurrences as source", () => {
    expect(rankClusters([cluster({})])[0]!.tag).toBe("source");
  });

  it("breaks score ties deterministically by id", () => {
    const ranked = rankClusters([cluster({ id: "bbb" }), cluster({ id: "aaa" })]);
    expect(ranked.map((r) => r.cluster.id)).toEqual(["aaa", "bbb"]);
  });

  it("does not mutate the input array", () => {
    const input = [cluster({ id: "bbb" }), cluster({ id: "aaa" })];
    rankClusters(input);
    expect(input.map((c) => c.id)).toEqual(["bbb", "aaa"]);
  });
});

describe("subsume", () => {
  it("drops a child cluster covering the same occurrence set as its parent", () => {
    const parent = cluster({
      id: "parent",
      nodeCount: 20,
      occurrences: [occ("src/a.ts", 0, 100), occ("src/b.ts", 0, 100)],
    });
    const child = cluster({
      id: "child",
      nodeCount: 18,
      occurrences: [occ("src/a.ts", 5, 95), occ("src/b.ts", 5, 95)],
    });
    expect(subsume([parent, child]).map((c) => c.id)).toEqual(["parent"]);
  });

  it("keeps clusters that cover different files", () => {
    const a = cluster({ id: "a" });
    const b = cluster({
      id: "b",
      occurrences: [occ("src/c.ts", 0, 5), occ("src/d.ts", 0, 5)],
    });
    expect(subsume([a, b])).toHaveLength(2);
  });

  it("keeps a cluster with MORE occurrences than the larger one", () => {
    // An L1 triple must survive alongside the L0 pair nested inside it: they
    // are different findings, not the same finding twice.
    const pair = cluster({
      id: "pair",
      nodeCount: 20,
      occurrences: [occ("src/a.ts", 0, 100), occ("src/b.ts", 0, 100)],
    });
    const triple = cluster({
      id: "triple",
      level: "L1",
      nodeCount: 18,
      occurrences: [occ("src/a.ts", 5, 95), occ("src/b.ts", 5, 95), occ("src/c.ts", 0, 90)],
    });
    expect(
      subsume([pair, triple])
        .map((c) => c.id)
        .sort(),
    ).toEqual(["pair", "triple"]);
  });

  it("is deterministic regardless of input order", () => {
    const a = cluster({
      id: "aaa",
      nodeCount: 20,
      occurrences: [occ("src/a.ts", 0, 100), occ("src/b.ts", 0, 100)],
    });
    const b = cluster({
      id: "bbb",
      nodeCount: 18,
      occurrences: [occ("src/a.ts", 5, 95), occ("src/b.ts", 5, 95)],
    });
    expect(subsume([a, b]).map((c) => c.id)).toEqual(subsume([b, a]).map((c) => c.id));
  });

  it("does not mutate the input array", () => {
    const input = [
      cluster({ id: "aaa", nodeCount: 10 }),
      cluster({ id: "bbb", nodeCount: 20, occurrences: [occ("src/z.ts", 0, 5), occ("src/y.ts", 0, 5)] }),
    ];
    subsume(input);
    expect(input.map((c) => c.id)).toEqual(["aaa", "bbb"]);
  });
});
