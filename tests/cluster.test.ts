import { describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { clusterFragments, findDuplication } from "../src/fingerprint/cluster.js";
import type { ShapedFragment } from "../src/fingerprint/shape.js";
import { fixtureConfig } from "./helpers.js";

describe("findDuplication", () => {
  it("finds the exact clone between alpha.ts and beta.ts at L0", async () => {
    const project = await openProject(fixtureConfig());
    const clusters = await findDuplication(project, { minNodes: 15 });
    const l0 = clusters.filter((c) => c.level === "L0");
    const spanning = l0.filter((c) => {
      const files = new Set(c.occurrences.map((o) => o.filePath));
      return files.has("src/alpha.ts") && files.has("src/beta.ts");
    });
    expect(spanning.length).toBeGreaterThan(0);
  });

  it("groups all three normalize bodies at L1 but only two at L0", async () => {
    // normalizeAlpha (alpha.ts), normalizeExact (beta.ts) are byte-identical.
    // normalizeBeta (beta.ts) is the same code alpha-renamed. So L0 sees a pair
    // and L1 sees a triple -- that difference IS the value L1 adds.
    const project = await openProject(fixtureConfig());
    const clusters = await findDuplication(project, { minNodes: 15 });
    const maxL0 = Math.max(
      ...clusters.filter((c) => c.level === "L0").map((c) => c.occurrences.length),
    );
    const l1Triples = clusters.filter((c) => c.level === "L1" && c.occurrences.length >= 3);
    expect(maxL0).toBe(2);
    expect(l1Triples.length).toBeGreaterThan(0);
    const files = new Set(l1Triples.flatMap((c) => c.occurrences.map((o) => o.filePath)));
    expect(files.has("src/alpha.ts")).toBe(true);
    expect(files.has("src/beta.ts")).toBe(true);
  });

  it("computes mass as size x (copies - 1)", async () => {
    const project = await openProject(fixtureConfig());
    const clusters = await findDuplication(project, { minNodes: 15 });
    expect(clusters.length).toBeGreaterThan(0); // guard against vacuous pass
    for (const c of clusters) {
      expect(c.mass).toBe(c.nodeCount * (c.occurrences.length - 1));
    }
  });

  it("returns clusters in a deterministic order across separate project loads", async () => {
    // Re-open the project rather than reusing one instance: this must be stable
    // across processes, not merely across two calls sharing cached state.
    const a = await findDuplication(await openProject(fixtureConfig()), { minNodes: 15 });
    const b = await findDuplication(await openProject(fixtureConfig()), { minNodes: 15 });
    expect(a.map((c) => `${c.id}:${c.level}:${c.mass}`)).toEqual(
      b.map((c) => `${c.id}:${c.level}:${c.mass}`),
    );
  });

  it("carries a 1-based line number on every occurrence", async () => {
    const project = await openProject(fixtureConfig());
    const clusters = await findDuplication(project, { minNodes: 15 });
    expect(clusters.length).toBeGreaterThan(0); // guard against vacuous pass
    for (const c of clusters) {
      for (const o of c.occurrences) {
        const text = project.getSourceFile(o.filePath)!.text;
        expect(o.line).toBe(text.slice(0, o.start).split("\n").length);
      }
    }
  });

  it("never reports a cluster with fewer than two occurrences", async () => {
    const project = await openProject(fixtureConfig());
    for (const c of await findDuplication(project, { minNodes: 15 })) {
      expect(c.occurrences.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("clusterFragments: L1 must not match on erased literals alone", () => {
  const shaped = (over: Partial<ShapedFragment>): ShapedFragment => ({
    filePath: "src/a.ts",
    kind: "ObjectLiteralExpression",
    nodeCount: 20,
    start: 0,
    end: 100,
    line: 1,
    endLine: 6,
    parentId: -1,
    literalShare: 0,
    l0: "l0",
    l1: "l1",
    ...over,
  });

  it("does not cluster literal-dense fragments that differ only in their data", () => {
    // L1 drops literal VALUES, so `{ oura: "Oura Ring", whoop: "WHOOP" }` and
    // `{ title: "Test", message: "Please wait" }` normalize to the same shape.
    // On a real application that clustered a 5-entry label map with 428 other
    // small string maps and put it at the top of the report. These fragments
    // are mostly their literals, so "same shape, different data" is not a
    // finding -- it is the definition of two different constants.
    const clusters = clusterFragments([
      shaped({ filePath: "src/labels.ts", l0: "labels", l1: "same-shape", literalShare: 0.5 }),
      shaped({ filePath: "src/toast.ts", l0: "toast", l1: "same-shape", literalShare: 0.5 }),
    ]);
    expect(clusters).toEqual([]);
  });

  it("still clusters code that differs only in its identifiers", () => {
    // The case L1 exists for: same logic, renamed variables. Low literal
    // share, so it is unaffected -- without this the suppression would be
    // deleting the level rather than sharpening it.
    const clusters = clusterFragments([
      shaped({ filePath: "src/a.ts", kind: "Block", l0: "a", l1: "same-shape", literalShare: 0.06 }),
      shaped({ filePath: "src/b.ts", kind: "Block", l0: "b", l1: "same-shape", literalShare: 0.06 }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.level).toBe("L1");
  });

  it("still reports literal-dense fragments that are byte-identical", () => {
    // L0 is untouched: two identical copies of the same table are real
    // duplication whatever their literal density.
    const clusters = clusterFragments([
      shaped({ filePath: "src/a.ts", l0: "same", l1: "same-shape", literalShare: 0.9 }),
      shaped({ filePath: "src/b.ts", l0: "same", l1: "same-shape", literalShare: 0.9 }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.level).toBe("L0");
  });
});
