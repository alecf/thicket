import { describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { findDuplication } from "../src/fingerprint/cluster.js";
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

  it("never reports a cluster with fewer than two occurrences", async () => {
    const project = await openProject(fixtureConfig());
    for (const c of await findDuplication(project, { minNodes: 15 })) {
      expect(c.occurrences.length).toBeGreaterThanOrEqual(2);
    }
  });
});
