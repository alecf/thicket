import { describe, expect, it } from "vitest";
import { clusterFragments, type Cluster } from "../src/fingerprint/cluster.js";
import { attachNear as attachNearWith } from "../src/fingerprint/near.js";
import { isTestMajority, rankClusters } from "../src/report/rank.js";
import type { ShapedFragment } from "../src/fingerprint/shape.js";
import { isNear, sketchOf } from "../src/fingerprint/sketch.js";

/** A pseudo-random L1-like stream; the same seed gives the same stream. */
function stream(n: number, seed: number): string[] {
  const kinds = ["CallExpression", "Id:a", "(", ")", "PropertyAccessExpression", "Block", "ReturnStatement", "Id:b"];
  const out: string[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out.push(kinds[(s >>> 16) % kinds.length]!);
  }
  return out;
}

/** `base` with a short run inserted: a near copy of it. */
const edited = (base: string[], seed: number) => [...base.slice(0, 150), ...stream(6, seed), ...base.slice(150)];

const BASE = stream(300, 1);
const OTHER = stream(300, 2);

let at = 0;
function frag(file: string, tokens: string[], shape: string, over: Partial<ShapedFragment> = {}): ShapedFragment {
  const start = (at += 1000);
  return {
    filePath: file,
    kind: "Block",
    nodeCount: 100,
    start,
    end: start + 500,
    line: start,
    endLine: start + 20,
    parentId: 1,
    literalShare: 0.1,
    l0: shape,
    l1: shape,
    sketch: sketchOf(tokens)!,
    ...over,
  };
}

const ids = (cs: readonly Cluster[]) => cs.map((c) => c.id);

/** The pass as run.ts wires it: in rank order, with the section split's test rule. */
const attachNear = (clusters: readonly Cluster[], frags: readonly ShapedFragment[]) =>
  attachNearWith(clusters, frags, {
    order: rankClusters(clusters).map((r) => r.cluster),
    isTestFinding: isTestMajority,
  });
const nearFiles = (c: Cluster | undefined) => (c?.near ?? []).map((o) => o.filePath);

describe("attachNear", () => {
  it("gives a finding the near copies of its shape, and leaves its exact copies alone", () => {
    const frags = [
      frag("a.ts", BASE, "base"),
      frag("b.ts", BASE, "base"),
      frag("c.ts", edited(BASE, 7), "edited"),
      frag("d.ts", OTHER, "other"),
    ];
    const [base] = attachNear(clusterFragments(frags), frags);
    expect(base!.id).toBe("base");
    expect(base!.occurrences.map((o) => o.filePath)).toEqual(["a.ts", "b.ts"]);
    expect(nearFiles(base)).toEqual(["c.ts"]);
    expect(base!.near![0]!.similarity).toBeGreaterThanOrEqual(0.8);
    expect(base!.near![0]!.similarity).toBeLessThan(1);
  });

  it("finds the near copy of a medium fragment that leaves most bins empty", () => {
    // 70 tokens fill about half of the 128 bins, so every band holds an empty
    // one. Lookup that skipped such bands found no candidate for a real
    // 57-node finding whose near copies were 0.92 to 0.98 alike.
    const medium = stream(70, 21);
    const near = [...medium.slice(0, 35), ...stream(2, 9), ...medium.slice(35)];
    const empty = [...sketchOf(medium)!].filter((v) => v === 0xffff).length;
    expect(empty).toBeGreaterThan(40);
    const frags = [frag("a.ts", medium, "m"), frag("b.ts", medium, "m"), frag("c.ts", near, "n")];
    expect(nearFiles(attachNear(clusterFragments(frags), frags)[0])).toEqual(["c.ts"]);
  });

  it("never takes a fragment inside or around one of its own copies", () => {
    // PRD §2.5's fifth hazard: a fragment beside its own parent scores ~0.99.
    const a = frag("a.ts", BASE, "base");
    const inside = frag("a.ts", edited(BASE, 7), "inner", { start: a.start + 10, end: a.end - 10 });
    const frags = [a, frag("b.ts", BASE, "base"), inside];
    const [base] = attachNear(clusterFragments(frags), frags);
    expect(base!.near).toBeUndefined();
  });

  it("never takes a nested finding's copy that sits inside one of its own copies", () => {
    // Found on a real report. Each copy's initializer was itself a finding
    // that subsume kept, because it also occurs alone. A near copy that IS
    // another finding's copy skipped the overlap check, so the finding listed
    // its own bodies as near copies and folded the inner finding away.
    const a = frag("a.ts", BASE, "outer");
    const b = frag("b.ts", BASE, "outer");
    const inner = (outer: ShapedFragment) =>
      frag(outer.filePath, edited(BASE, 7), "inner", { start: outer.start + 10, end: outer.end - 10 });
    const frags = [a, b, inner(a), inner(b), frag("c.ts", edited(BASE, 7), "inner")];
    const out = attachNear(clusterFragments(frags), frags);
    // Neither finding takes the other's copies, because each copy of one
    // contains or sits inside a copy of the other. Both survive.
    expect(ids(out).sort()).toEqual(["inner", "outer"]);
    expect(out.every((c) => c.near === undefined)).toBe(true);
  });

  it("folds a smaller finding of a near shape into the larger one", () => {
    const frags = [
      frag("a.ts", BASE, "base"),
      frag("b.ts", BASE, "base"),
      frag("c.ts", BASE, "base"),
      frag("d.ts", edited(BASE, 7), "edited"),
      frag("e.ts", edited(BASE, 7), "edited"),
    ];
    const out = attachNear(clusterFragments(frags), frags);
    expect(ids(out)).toEqual(["base"]);
    expect(nearFiles(out[0])).toEqual(["d.ts", "e.ts"]);
  });

  it("folds a near finding whole, before any fragment that encloses its copies", () => {
    // Found on a real report. Each copy of a near finding sat inside a larger
    // fragment that was near too. Taken in size order, the larger fragments
    // came first, so the near finding kept its copies, listed this one's
    // enclosing code as near copies of its own, and the report printed both.
    // Each enclosing fragment is a shape of its own, as on the real report.
    const enclosing = (inner: ShapedFragment, seed: number) =>
      frag(inner.filePath, edited(BASE, seed), `outer${seed}`, {
        start: inner.start - 5,
        end: inner.end + 5,
        nodeCount: 110,
      });
    const b1 = frag("d.ts", edited(BASE, 7), "near");
    const b2 = frag("e.ts", edited(BASE, 7), "near");
    const frags = [
      frag("a.ts", BASE, "base"),
      frag("b.ts", BASE, "base"),
      frag("c.ts", BASE, "base"),
      b1,
      b2,
      enclosing(b1, 8),
      enclosing(b2, 9),
    ];
    const out = attachNear(clusterFragments(frags), frags);
    expect(ids(out)).toEqual(["base"]);
    const near = out[0]!.near!;
    expect(near.map((o) => [o.filePath, o.start])).toEqual([
      ["d.ts", b1.start],
      ["e.ts", b2.start],
    ]);
  });

  it("never folds a finding it visited earlier", () => {
    // Folding runs from larger to smaller. Here `base` takes the enclosing
    // finding's copies, which leaves `near` beside it. `near` is near `base`
    // too, and once folded `base` away and kept every copy for itself.
    const enclosing = (inner: ShapedFragment) =>
      frag(inner.filePath, edited(BASE, 8), "outer", { start: inner.start - 5, end: inner.end + 5, nodeCount: 110 });
    const b1 = frag("d.ts", edited(BASE, 7), "near");
    const b2 = frag("e.ts", edited(BASE, 7), "near");
    const frags = [frag("a.ts", BASE, "base"), frag("b.ts", BASE, "base"), frag("c.ts", BASE, "base"), b1, b2, enclosing(b1), enclosing(b2)];
    const out = attachNear(clusterFragments(frags), frags);
    expect(ids(out)).toContain("base");
    expect(out.find((c) => c.id === "base")!.occurrences.map((o) => o.filePath)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("visits findings in rank order, whatever order they arrive in", () => {
    // `subsume` does not return clusters in rank order. On a real report a
    // 3-copy finding was visited first, folded in a 34-copy finding of nearly
    // its shape that ranked third, and was not printed itself. The report
    // lost its third-best finding.
    const frags = [
      frag("a.ts", edited(BASE, 7), "small", { nodeCount: 120 }),
      frag("b.ts", edited(BASE, 7), "small", { nodeCount: 120 }),
      ...["c", "d", "e", "f", "g"].map((n) => frag(`${n}.ts`, BASE, "big")),
    ];
    const clusters = clusterFragments(frags);
    expect(attachNear([...clusters].reverse(), frags).map((c) => c.id)).toEqual(["big"]);
  });

  it("folds by rank, not by mass", () => {
    // Mass is nodes × (copies − 1). The score weighs size and count by level,
    // so a 9-copy L0 finding outranks a 10-copy L1 finding of more mass. In
    // mass order the L0 finding was folded into the L1 one, and printed only
    // as near copies under a finding that scored half as much.
    const l1 = Array.from({ length: 10 }, (_, i) => frag(`x${i}.ts`, BASE, "x", { l0: `x-${i}` }));
    const l0 = Array.from({ length: 9 }, (_, i) => frag(`y${i}.ts`, edited(BASE, 7), "y"));
    const frags = [...l1, ...l0];
    const clusters = clusterFragments(frags);
    const byId = new Map(clusters.map((c) => [c.id, c]));
    // The premise: the L1 finding has more mass, the L0 finding ranks higher.
    expect(byId.get("x")!.level).toBe("L1");
    expect(byId.get("y")!.level).toBe("L0");
    expect(byId.get("x")!.mass).toBeGreaterThan(byId.get("y")!.mass);
    expect(rankClusters(clusters)[0]!.cluster.id).toBe("y");

    const out = attachNear(clusters, frags);
    expect(ids(out)).toEqual(["y"]);
    expect(out[0]!.near).toHaveLength(10);
  });

  it("gives no near copies to a finding whose copies are mostly tests", () => {
    // Judges rated 0 of 6 such near copies worth sharing: two tests with one
    // harness and different assertions look near, and are different tests.
    const frags = [
      frag("a.test.ts", BASE, "base"),
      frag("b.test.ts", BASE, "base"),
      frag("src/c.ts", edited(BASE, 7), "edited"),
    ];
    expect(attachNear(clusterFragments(frags), frags)[0]!.near).toBeUndefined();
  });

  it("takes no near copy from a test file", () => {
    const frags = [frag("a.ts", BASE, "base"), frag("b.ts", BASE, "base"), frag("c.test.ts", edited(BASE, 7), "edited")];
    expect(attachNear(clusterFragments(frags), frags)[0]!.near).toBeUndefined();
  });

  it("does not chain: a near copy of a near copy is not a near copy", () => {
    // Union-find over the near graph put 26,318 of 65,150 shapes of a real
    // repository into one group at 0.8. A finding takes only what is near
    // ITSELF.
    const a = BASE;
    const b = [...a.slice(0, 100), ...stream(55, 11), ...a.slice(100)];
    const c = [...b.slice(0, 220), ...stream(55, 12), ...b.slice(220)];
    const frags = [frag("a1.ts", a, "a"), frag("a2.ts", a, "a"), frag("a3.ts", a, "a"), frag("b.ts", b, "b"), frag("c1.ts", c, "c"), frag("c2.ts", c, "c")];
    const sa = sketchOf(a)!;
    const sc = sketchOf(c)!;
    // The premise: a~b and b~c hold, and a~c does not.
    expect(isNear(sa, sketchOf(b)!)).toBe(true);
    expect(isNear(sketchOf(b)!, sc)).toBe(true);
    expect(isNear(sa, sc)).toBe(false);

    const out = attachNear(clusterFragments(frags), frags);
    expect(nearFiles(out.find((x) => x.id === "a"))).toEqual(["b.ts"]);
    expect(out.find((x) => x.id === "c")).toBeDefined();
  });

  it("is the same whatever order the fragments arrive in", () => {
    const frags = [
      frag("a.ts", BASE, "base"),
      frag("b.ts", BASE, "base"),
      frag("c.ts", edited(BASE, 7), "e1"),
      frag("d.ts", edited(BASE, 8), "e2"),
      frag("e.ts", OTHER, "other"),
      frag("f.ts", OTHER, "other"),
    ];
    const forward = attachNear(clusterFragments(frags), frags);
    const reversed = [...frags].reverse();
    expect(attachNear(clusterFragments(reversed), reversed)).toEqual(forward);
  });

  it("gives no near copies to a finding whose content is mostly literals", () => {
    // Same gate as L1: matching shape says nothing when the values ARE the
    // content. Judges rated every near copy above that share as not worth it.
    const frags = [
      frag("a.ts", BASE, "base", { literalShare: 0.5 }),
      frag("b.ts", BASE, "base", { literalShare: 0.5 }),
      frag("c.ts", edited(BASE, 7), "edited"),
    ];
    const [base] = attachNear(clusterFragments(frags), frags);
    expect(base!.near).toBeUndefined();
  });

  it.each(["PropertyAssignment", "ObjectLiteralExpression", "PropertySignature"])(
    "gives no near copies to a %s, which is one data entry beside another",
    (kind) => {
      // Judges rated 0 of 38 such near copies worth sharing, across two
      // repositories and every similarity band.
      const frags = [
        frag("a.ts", BASE, "base", { kind }),
        frag("b.ts", BASE, "base", { kind }),
        frag("c.ts", edited(BASE, 7), "edited", { kind }),
      ];
      expect(attachNear(clusterFragments(frags), frags)[0]!.near).toBeUndefined();
    },
  );

  it("gives no near copies to a shape under the size floor", () => {
    // Under 25 nodes, judges rated 1 of 21 near copies worth sharing.
    const frags = [
      frag("a.ts", BASE, "base", { nodeCount: 24 }),
      frag("b.ts", BASE, "base", { nodeCount: 24 }),
      frag("c.ts", edited(BASE, 7), "edited", { nodeCount: 24 }),
    ];
    expect(attachNear(clusterFragments(frags), frags)[0]!.near).toBeUndefined();
  });

  it("takes a near copy that contains another finding's copy", () => {
    // Exact findings nest: a function's finding and its loop's finding are
    // both printed. Refusing a near function because its loop is a finding
    // hid the near copy in every real case like it.
    const loop = stream(80, 5);
    const g = frag("g.ts", edited(BASE, 7), "edited");
    const frags = [
      frag("a.ts", BASE, "base"),
      frag("b.ts", BASE, "base"),
      g,
      frag("g.ts", loop, "loop", { start: g.start + 5, end: g.start + 100 }),
      frag("h.ts", loop, "loop"),
    ];
    const out = attachNear(clusterFragments(frags), frags);
    expect(nearFiles(out.find((c) => c.id === "base"))).toEqual(["g.ts"]);
    expect(ids(out)).toContain("loop");
  });
});
