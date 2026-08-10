import { describe, expect, it } from "vitest";
import { isTestPath, rankClusters, subsume } from "../src/report/rank.js";
import type { Cluster } from "../src/fingerprint/cluster.js";

/**
 * `lines` is the span of one copy and `parentId` identifies the AST node the
 * copy hangs off, which is how a data table is told apart from a missing
 * abstraction. Both default to values that make an occurrence look like
 * ordinary scattered code.
 */
let nextParent = 0;
const occ = (filePath: string, start: number, end: number, line = 1, lines = 8, parentId = -1) => ({
  filePath,
  start,
  end,
  line,
  endLine: line + lines - 1,
  parentId: parentId === -1 ? nextParent++ : parentId,
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

describe("rankClusters: intra-file repetition", () => {
  // Reproduces the real-repository case that motivated the copy cap. A config
  // data table is not extractable; a function duplicated across route files is.
  const dataTable = cluster({
    id: "table",
    level: "L1",
    kind: "PropertyAssignment",
    nodeCount: 21,
    occurrences: Array.from({ length: 99 }, (_, i) => occ("src/config.ts", i * 100, i * 100 + 90, i + 1)),
    mass: 21 * 98,
  });
  const sharedFn = cluster({
    id: "fn",
    level: "L1",
    kind: "FunctionDeclaration",
    nodeCount: 109,
    occurrences: Array.from({ length: 8 }, (_, i) => occ(`src/routes/r${i}.tsx`, 0, 500, 10)),
    mass: 109 * 7,
  });

  it("ranks a cross-file duplicated function above a large intra-file data table", () => {
    // Raw mass endorses the table (2058 deletable nodes vs 763), so this only
    // holds because repetition within one file is capped.
    const ranked = rankClusters([dataTable, sharedFn]);
    expect(ranked[0]!.cluster.id).toBe("fn");
  });

  it("still scores intra-file duplication above zero rather than excluding it", () => {
    // Intra-file is 70-84% of all candidates; suppressing it entirely would
    // empty the report of repeated handlers and markup. PRD §5.4 ranks it
    // lowest, not out.
    expect(rankClusters([dataTable])[0]!.score).toBeGreaterThan(0);
  });

  it("does not cap repetition that is spread across many files", () => {
    // 20 copies over 20 files is under the 10-per-file ceiling, so raising the
    // count must still raise the score.
    const twenty = cluster({
      id: "wide20",
      occurrences: Array.from({ length: 20 }, (_, i) => occ(`src/f${i}.ts`, 0, 5)),
    });
    const ten = cluster({
      id: "wide10",
      occurrences: Array.from({ length: 10 }, (_, i) => occ(`src/f${i}.ts`, 0, 5)),
    });
    expect(rankClusters([ten, twenty])[0]!.cluster.id).toBe("wide20");
  });

  it("ignores copies beyond the per-file ceiling", () => {
    const at = cluster({
      id: "at",
      occurrences: Array.from({ length: 10 }, (_, i) => occ("src/one.ts", i * 10, i * 10 + 5)),
    });
    const over = cluster({
      id: "over",
      occurrences: Array.from({ length: 60 }, (_, i) => occ("src/one.ts", i * 10, i * 10 + 5)),
    });
    // Same shape, same file, 6x the copies -- identical score once capped.
    expect(rankClusters([at])[0]!.score).toBe(rankClusters([over])[0]!.score);
  });
});

describe("rankClusters: size is what makes a duplication worth fixing", () => {
  it("weighs one more copy the same as one more line", () => {
    // Size and count each enter the score exactly once. The previous formula
    // had count in twice -- `(copies - 1)` multiplied again by
    // `log2(1 + copies)` -- and size once, which inverted the judgement the
    // report exists to support: on a real repository 25 copies of a 4-line
    // block outscored a 22-line function duplicated across two packages by
    // 8.5x, and the finding most obviously worth acting on ranked 28th.
    //
    // Held at equal spread and equal parentage, so only the trade this
    // asserts is in play.
    const at = (copies: number, lines: number) =>
      rankClusters([
        cluster({
          id: "c",
          occurrences: Array.from({ length: copies }, (_, i) => occ(`src/f${i}.ts`, 0, 500, 1, lines)),
        }),
      ])[0]!.score;
    // (copies - 1) x (lines - 1): 4 copies of 7 lines and 7 copies of 4 lines
    // both recover 18 lines, so neither dimension may dominate the other.
    expect(at(4, 7)).toBe(at(7, 4));
  });

  it("scores a one-line shape at zero however often it repeats", () => {
    // Extracting a single line replaces each copy with a call of the same
    // length and adds a definition: the refactor is a strict loss. A score
    // above zero here is the report spending a slot to lose the reader lines.
    const oneLiner = cluster({
      id: "one",
      occurrences: Array.from({ length: 40 }, (_, i) => occ(`src/f${i}.ts`, 0, 60, 3, 1)),
    });
    expect(rankClusters([oneLiner])[0]!.score).toBe(0);
  });

  it("grows with the size of the duplicated fragment", () => {
    const at = (lines: number) =>
      rankClusters([
        cluster({
          id: "c",
          occurrences: [occ("src/a.ts", 0, 500, 1, lines), occ("src/b.ts", 0, 500, 1, lines)],
        }),
      ])[0]!.score;
    expect(at(20)).toBeGreaterThan(at(10));
    expect(at(10)).toBeGreaterThan(at(5));
  });
});

describe("rankClusters: data tables versus missing abstractions", () => {
  // PRD §5.4 records this as the ranker's known blind spot: "a 40-node object
  // literal repeated 15 times and a 40-node code block repeated 15 times are
  // identical in every feature the ranker has. Separating them needs a new
  // signal -- occurrences being consecutive siblings under one
  // ObjectLiteralExpression -- not a new weight."
  //
  // `parentId` is that signal. On the repository that motivated it, ten of the
  // top forty findings were entries of a single biomarker config table.
  const shared = (over: Partial<Cluster>) =>
    cluster({ nodeCount: 40, ...over });

  it("ranks scattered duplication above the same shape inside one literal", () => {
    // Both clusters span the SAME two files with the SAME copy count and the
    // same span, so `spread` and size are held constant and the only thing
    // separating them is whether the copies hang off one parent node. Letting
    // the table sit in a single file instead would make this pass on the
    // spread multiplier alone, with the sibling signal deleted.
    const layout = (parentPerFile: boolean) =>
      Array.from({ length: 16 }, (_, i) => {
        const file = i < 8 ? "src/config.ts" : "src/other-config.ts";
        return occ(file, i * 400, i * 400 + 350, i * 12 + 1, 11, parentPerFile ? (i < 8 ? 7 : 9) : -1);
      });
    // Ids chosen so the TABLE wins the `id asc` tie-break. Held equal on every
    // other feature, an unweighted ranker scores these identically and the tie
    // decides -- so with ids the other way round this passes with the sibling
    // signal deleted.
    const table = shared({ id: "aaa-table", kind: "PropertyAssignment", occurrences: layout(true) });
    const scattered = shared({ id: "zzz-scattered", occurrences: layout(false) });
    expect(rankClusters([table, scattered])[0]!.cluster.id).toBe("zzz-scattered");
  });

  it("still reports a data table rather than discarding it", () => {
    // Down-weighted, not excluded -- the same rule intra-file repetition gets.
    // A table that is genuinely 15 copies of real logic is still a finding.
    const table = shared({
      id: "table",
      occurrences: Array.from({ length: 15 }, (_, i) =>
        occ("src/config.ts", i * 400, i * 400 + 350, i * 12 + 1, 11, 7),
      ),
    });
    expect(rankClusters([table])[0]!.score).toBeGreaterThan(0);
  });

  it("does not penalize copies that merely share a file", () => {
    // Two repeated handlers in one module are not a data table. The signal is
    // a shared PARENT NODE, and keying it on the file instead would sweep up
    // every legitimate intra-file repetition.
    const sameParent = shared({
      id: "same",
      occurrences: Array.from({ length: 6 }, (_, i) => occ("src/a.ts", i * 400, i * 400 + 350, i * 12 + 1, 11, 3)),
    });
    const sameFile = shared({
      id: "spread",
      occurrences: Array.from({ length: 6 }, (_, i) => occ("src/a.ts", i * 400, i * 400 + 350, i * 12 + 1, 11)),
    });
    expect(rankClusters([sameParent, sameFile])[0]!.cluster.id).toBe("spread");
  });
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

  it("weights a mixed cluster by how much of it is really source", () => {
    // The `[mixed]` tag exempted a cluster from the test down-weight entirely,
    // so 429 copies of `vi.mock` scaffolding earned full weight because a
    // couple of source files happened to share the shape. The top four
    // findings of a real application were all test setup.
    //
    // A cluster that is 95% test files is a test cluster whatever the tag
    // says, and one that is half source is the case PRD §2.7 wants surfaced:
    // production logic reimplemented inside a test. Weight follows the source
    // fraction rather than switching on a three-way tag.
    const withSourceShare = (sourceCount: number, testCount: number) =>
      rankClusters([
        cluster({
          id: "c",
          occurrences: [
            ...Array.from({ length: sourceCount }, (_, i) => occ(`src/s${i}.ts`, 0, 300, 1, 9)),
            ...Array.from({ length: testCount }, (_, i) => occ(`src/t${i}.test.ts`, 0, 300, 1, 9)),
          ],
        }),
      ])[0]!;

    const barelyMixed = withSourceShare(1, 19);
    const evenlyMixed = withSourceShare(10, 10);
    expect(barelyMixed.tag).toBe("mixed");
    expect(evenlyMixed.tag).toBe("mixed");
    // Same copy count and same span: only the source share differs.
    expect(evenlyMixed.score).toBeGreaterThan(barelyMixed.score);
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

  it("drops a child that mostly overlaps a larger cluster, not only one that matches exactly", () => {
    // Requiring an EXACT occurrence-set match let one region of source occupy
    // seven of the top eleven slots on a real application: the same repeated
    // test-setup block reported as a Block of 120 copies, an ExpressionStatement
    // of 135, an IfStatement of 115, and the L1 variants of each. The counts
    // differ slightly -- a few files have one extra statement -- so nothing
    // subsumed anything, and six slots went to restatements of one finding.
    const parent = cluster({
      id: "parent",
      nodeCount: 60,
      occurrences: Array.from({ length: 12 }, (_, i) => occ(`src/f${i}.ts`, 0, 400, 1, 15)),
    });
    const child = cluster({
      id: "child",
      nodeCount: 40,
      occurrences: [
        // Eleven of thirteen sit inside a `parent` occurrence...
        ...Array.from({ length: 11 }, (_, i) => occ(`src/f${i}.ts`, 50, 300, 3, 9)),
        // ...and two are somewhere else entirely.
        occ("src/other.ts", 0, 250, 1, 9),
        occ("src/elsewhere.ts", 0, 250, 1, 9),
      ],
    });
    expect(subsume([parent, child]).map((c) => c.id)).toEqual(["parent"]);
  });

  it("keeps a cluster that merely brushes a larger one", () => {
    // The complement: partial overlap is not the same finding. Without this
    // bound, "mostly contained" collapses genuinely distinct duplication.
    const parent = cluster({
      id: "parent",
      nodeCount: 60,
      occurrences: Array.from({ length: 10 }, (_, i) => occ(`src/f${i}.ts`, 0, 400, 1, 15)),
    });
    const child = cluster({
      id: "child",
      nodeCount: 40,
      occurrences: [
        ...Array.from({ length: 3 }, (_, i) => occ(`src/f${i}.ts`, 50, 300, 3, 9)),
        ...Array.from({ length: 7 }, (_, i) => occ(`src/g${i}.ts`, 0, 250, 1, 9)),
      ],
    });
    expect(subsume([parent, child]).map((c) => c.id).sort()).toEqual(["child", "parent"]);
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
