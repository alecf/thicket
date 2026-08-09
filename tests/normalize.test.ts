import { beforeAll, describe, expect, it } from "vitest";
import { initHash } from "../src/hash.js";
import { alphaRename, normalizeL0, normalizeL1 } from "../src/fingerprint/normalize.js";
import { openProject } from "../src/extract/ts-adapter.js";
import { extractFragments } from "../src/fingerprint/fragments.js";
import { fixtureConfig } from "./helpers.js";

beforeAll(async () => {
  await initHash();
});

describe("alphaRename", () => {
  it("renumbers identifiers by first appearance within the fragment", () => {
    expect(alphaRename(["Id:foo", "Id:bar", "Id:foo"])).toEqual(["Id#0", "Id#1", "Id#0"]);
  });

  it("gives identical output to structurally identical fragments with different names", () => {
    expect(alphaRename(["Id:a", "Id:b"])).toEqual(alphaRename(["Id:x", "Id:y"]));
  });

  it("leaves non-identifier tokens untouched", () => {
    expect(alphaRename(["Block", "(", "Id:z", ")"])).toEqual(["Block", "(", "Id#0", ")"]);
  });

  it("distinguishes different reuse patterns", () => {
    // a,b,a is not the same shape as a,b,b -- renaming must preserve which
    // occurrences co-refer, or unrelated code collapses together.
    expect(alphaRename(["Id:a", "Id:b", "Id:a"])).not.toEqual(
      alphaRename(["Id:a", "Id:b", "Id:b"]),
    );
  });
});

describe("normalization levels", () => {
  it("L0-equal implies L1-equal", () => {
    const a = ["Id:foo", "NumericLiteral:1"];
    const b = ["Id:foo", "NumericLiteral:1"];
    expect(normalizeL0(a)).toBe(normalizeL0(b));
    expect(normalizeL1(a)).toBe(normalizeL1(b));
  });

  it("L1 groups renamed variants that L0 separates", () => {
    const a = ["Id:foo", "Id:bar"];
    const b = ["Id:baz", "Id:qux"];
    expect(normalizeL0(a)).not.toBe(normalizeL0(b));
    expect(normalizeL1(a)).toBe(normalizeL1(b));
  });

  it("on real code, L1 coarsens L0 and never splits an L0 cluster", async () => {
    // The regression test for a bug that actually happened: alpha-renaming
    // scoped per-FILE gives two identical fragments different indices
    // depending on what preceded them in their file. See PRD §2.5.
    //
    // The invariant is stated as "L1 never splits an L0 cluster", NOT as
    // "L1 never reports fewer clusters than L0". The latter is not a theorem
    // and does not detect the bug -- both directions were measured on this
    // fixture at minNodes 10:
    //
    //   correct (per-fragment)  L0=17 L1=15 clusters, 0 splits
    //   buggy   (per-file)      L0=17 L1=18 clusters, 17 splits
    //
    // L1 counts FEWER clusters when correct because coarsening MERGES: the
    // `const dx = p.x - ORIGIN.x` and `const dy = p.y - ORIGIN.y` clusters are
    // distinct under L0 and one cluster under L1. Collapsing two classes of
    // size >= 2 into one lowers the count while strictly generalizing, so a
    // count comparison fails on correct code and passes on the bug -- exactly
    // backwards. Splitting, by contrast, is impossible for any coarsening:
    // identical L0 token streams yield identical L1 token streams, so
    // L0-equal must imply L1-equal. That is what the bug violates, on every
    // single cluster.
    const project = await openProject(fixtureConfig());
    const byL0 = new Map<string, string[]>();
    const byL1 = new Map<string, string[]>();
    for (const file of project.files()) {
      for (const f of extractFragments(file, { minNodes: 10 })) {
        const k0 = normalizeL0(f.tokensL0);
        const k1 = normalizeL1(f.tokensL1);
        (byL0.get(k0) ?? byL0.set(k0, []).get(k0)!).push(k1);
        (byL1.get(k1) ?? byL1.set(k1, []).get(k1)!).push(k0);
      }
    }

    // No L0 cluster may straddle two L1 clusters.
    for (const [k0, l1Keys] of byL0) {
      expect(new Set(l1Keys).size, `L0 cluster ${k0} split across L1 keys`).toBe(1);
    }

    // And L1 must cover at least as many fragments as L0 does.
    const covered = (m: Map<string, string[]>) =>
      [...m.values()].filter((v) => v.length > 1).reduce((n, v) => n + v.length, 0);
    expect(covered(byL1)).toBeGreaterThanOrEqual(covered(byL0));
    expect(covered(byL0)).toBeGreaterThan(0); // guard against a vacuous pass
  });
});
