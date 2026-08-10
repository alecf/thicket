import { describe, expect, it } from "vitest";
import { runReport } from "../src/run.js";
import {
  emptyConfig,
  fixtureConfig,
  importsFixtureConfig,
  tangleConfig,
  testSplitConfig,
  typeOnlyConfig,
} from "./helpers.js";

describe("runReport", () => {
  it("produces a report naming the fixture's known duplication", async () => {
    const { markdown } = await runReport({ config: fixtureConfig(), minNodes: 15 });
    expect(markdown).toContain("# thicket report");
    expect(markdown).toContain("src/alpha.ts");
    expect(markdown).toContain("src/beta.ts");
  });

  it("reports the known alpha<->gamma cycle", async () => {
    const { json } = await runReport({
      config: fixtureConfig(),
      minNodes: 15,
      granularity: "file",
    });
    expect(json.cycles.length).toBeGreaterThan(0);
  });

  it("carries the SCC's real edges, and only those, on every cycle", async () => {
    // The chart is only worth drawing if what it draws is a cycle. Asserting
    // that the edges exist is not enough -- a filter that dropped half of them
    // would still pass that -- so this reconstructs reachability from the
    // edges alone and requires every member to reach every other.
    const { json } = await runReport({
      config: fixtureConfig(),
      minNodes: 15,
      granularity: "file",
    });
    expect(json.cycles.length).toBeGreaterThan(0);

    for (const cycle of json.cycles) {
      expect(cycle.edges.length).toBeGreaterThan(0);
      const members = new Set(cycle.modules);
      for (const e of cycle.edges) {
        expect(members.has(e.from)).toBe(true);
        expect(members.has(e.to)).toBe(true);
      }

      // Floyd-Warshall style closure over the drawn edges only.
      const reach = new Map(cycle.modules.map((m) => [m, new Set<string>()]));
      for (const e of cycle.edges) reach.get(e.from)!.add(e.to);
      for (let changed = true; changed; ) {
        changed = false;
        for (const targets of reach.values()) {
          for (const via of [...targets]) {
            for (const end of reach.get(via) ?? []) {
              if (!targets.has(end)) {
                targets.add(end);
                changed = true;
              }
            }
          }
        }
      }
      for (const a of cycle.modules) {
        for (const b of cycle.modules) {
          expect(reach.get(a)!.has(b), `${a} cannot reach ${b}`).toBe(true);
        }
      }
    }
  });

  it("is byte-identical across two runs", async () => {
    const a = await runReport({ config: fixtureConfig(), minNodes: 15 });
    const b = await runReport({ config: fixtureConfig(), minNodes: 15 });
    expect(a.markdown).toBe(b.markdown);
  });

  it("never emits import boilerplate as a top finding", async () => {
    // Regression guard: without the ignored-kinds filter the entire top of the
    // report is ImportDeclaration, which carries no refactoring signal.
    const { markdown } = await runReport({ config: fixtureConfig(), minNodes: 5 });
    expect(markdown).not.toMatch(/Import(Declaration|Clause|Specifier)/);
  });

  it("respects the budget and states the omitted count honestly", async () => {
    // `minLines: 1` on purpose. This test is about truncation, and it needs
    // more findings than the budget can hold; the default four-line floor
    // leaves the fixture with few enough that everything fits and the test
    // stops exercising the budget at all.
    const full = await runReport({ config: fixtureConfig(), minNodes: 5, minLines: 1 });
    const tight = await runReport({
      config: fixtureConfig(),
      minNodes: 5,
      minLines: 1,
      // Tight enough to actually bite: the whole fixture report is ~270
      // tokens, so a ceiling above that truncates nothing and the assertions
      // below hold vacuously.
      budgetTokens: 200,
    });
    expect(tight.markdown.length).toBeLessThan(full.markdown.length);
    expect(tight.markdown).toMatch(/findings are not shown above/);
    // The stated total must be the pre-truncation candidate count, not the
    // number shown -- otherwise a harness cannot tell it is seeing a slice.
    expect(tight.json.totalFindings).toBe(full.json.totalFindings);
  });

  it("never lets test duplication take a production finding's slot", async () => {
    // The failure this replaces: 10 of the top 40 findings on a real
    // application were test scaffolding. This fixture reproduces the shape --
    // its highest-scoring cluster of all is a mock-logger setup repeated
    // across four test files, well above the one production clone.
    const options = { config: testSplitConfig(), minNodes: 8, minLines: 2 } as const;
    const { json, markdown } = await runReport(options);

    // The guard is only load-bearing if the scaffolding really does outrank
    // the production clone. Assert that, so this cannot pass by accident on a
    // fixture that stopped exercising the case.
    const best = [...json.duplication].sort((a, b) => b.score - a.score)[0]!;
    expect(best.tag).toBe("test");
    expect(json.census.duplication).toBe(1);
    expect(json.census.testDuplication).toBe(2);

    // ...and the report still leads with the production clone.
    expect(markdown.indexOf("## Duplication")).toBeLessThan(
      markdown.indexOf("## Test duplication"),
    );
    const production = markdown.slice(
      markdown.indexOf("## Duplication"),
      markdown.indexOf("## Test duplication"),
    );
    expect(production).toContain("src/order.ts");
    expect(production).not.toContain(".test.ts");
  });

  it("keeps the production finding when only one slot is available", async () => {
    // `maxFindings` caps each section independently, so the scaffolding
    // cannot consume the production section's only slot.
    const { markdown } = await runReport({
      config: testSplitConfig(),
      minNodes: 8,
      minLines: 2,
      maxFindings: 1,
    });
    expect(markdown).toContain("src/order.ts");
  });

  it("censuses every candidate it found, printed or not", async () => {
    // The census is what the report says the unprinted tail consists of. If it
    // does not add up to the stated total, the summary is describing a
    // different pile than the one the findings came off.
    // Run against the fixture that actually has both kinds, so the test
    // half of this sum is not always zero.
    const { json } = await runReport({ config: testSplitConfig(), minNodes: 8, minLines: 2 });
    const { census } = json;
    expect(census.duplication + census.testDuplication + census.cycles).toBe(json.totalFindings);
    const banded = census.bands.reduce((sum, b) => sum + b.count, 0);
    expect(banded).toBe(census.duplication);
    expect(census.duplication).toBeGreaterThan(0);
    expect(census.testDuplication).toBeGreaterThan(0);
  });

  it("emits no absolute paths", async () => {
    const { markdown } = await runReport({ config: fixtureConfig(), minNodes: 15 });
    expect(markdown).not.toContain("/Users/");
    expect(markdown).not.toMatch(/^\//m);
  });

  it("prefers the cut that dissolves the most tangle, then the cheapest", async () => {
    // The old rule took the lowest-weight edge that broke the component at
    // all, which reliably found the least interesting cut: on a real 7-module
    // tangle it detached one leaf and left six knotted. Here both edges of the
    // cycle dissolve it equally, so the tie-break decides -- and it must pick
    // the type-only one, which is erased at compile time and costs a file
    // move rather than a dependency inversion.
    const { json } = await runReport({ config: typeOnlyConfig(), granularity: 2, minNodes: 100 });
    const cycle = json.cycles.find((c) => c.modules.includes("model") && c.modules.includes("pure"));
    expect(cycle).toBeDefined();
    expect(cycle!.modules.sort()).toEqual(["model", "pure"]);
    expect(cycle!.cuts).toHaveLength(1);
    expect({ from: cycle!.cuts[0]!.from, to: cycle!.cuts[0]!.to }).toEqual({
      from: "pure",
      to: "model",
    });
    expect(cycle!.cuts[0]!.typeOnly).toBe(true);
    // ...and the residual is stated, so "one cut" cannot read as "solved"
    // when it is not. Here it genuinely is solved.
    expect(cycle!.residual).toBe(1);
  });

  it("takes the cut that dissolves most, not the cheapest one that works", async () => {
    // The reported pathology, reproduced: a three-package ring with a fourth
    // hanging off it by one symbol each way. The cheapest breaking edge is the
    // leaf's, and cutting it leaves the ring exactly as tangled. A heavier ring
    // edge does strictly better, and that is the one to suggest.
    const { json } = await runReport({ config: tangleConfig(), granularity: 2, minNodes: 100 });
    const cycle = json.cycles[0]!;
    expect(cycle.modules.sort()).toEqual(["alpha", "beta", "gamma", "leaf"]);

    const cut = cycle.cuts[0]!;
    // Not `alpha -> leaf` or `leaf -> alpha`, which are weight 1 and would
    // have been chosen first under cost ordering alone.
    expect(cut.weight).toBe(3);
    expect([cut.from, cut.to]).not.toContain("leaf");
    // Four modules down to two, rather than the three a leaf cut would leave.
    expect(cycle.residual).toBe(2);
  });

  it("reports the residual honestly when a cut only detaches a leaf", async () => {
    // A three-module ring with one extra module hanging off it: cutting the
    // leaf's edge shrinks the SCC without untangling the ring, and the report
    // has to say which of the two happened.
    const { json } = await runReport({
      config: fixtureConfig(),
      minNodes: 15,
      granularity: "file",
    });
    for (const cycle of json.cycles) {
      expect(cycle.residual).toBeLessThanOrEqual(cycle.modules.length);
      // Either no cut was found and nothing changed, or a cut was found and it
      // provably shrank the component.
      if (cycle.cuts.length === 0) expect(cycle.residual).toBe(cycle.modules.length);
      else expect(cycle.residual).toBeLessThan(cycle.modules.length);
    }
  });

  it("only suggests cuts it has verified break the cycle", async () => {
    const { json } = await runReport({
      config: fixtureConfig(),
      minNodes: 15,
      granularity: "file",
    });
    for (const cycle of json.cycles) {
      for (const cut of cycle.cuts) {
        expect(cycle.modules).toContain(cut.from);
        expect(cycle.modules).toContain(cut.to);
      }
    }
  });

  it("reports duplicated coverage as a fraction in [0, 1]", async () => {
    // The old node-mass percentage double counted nested clusters and could
    // print above 100%, which made the headline metric meaningless.
    for (const config of [fixtureConfig(), importsFixtureConfig()]) {
      for (const minNodes of [5, 15]) {
        const { json } = await runReport({ config, minNodes });
        const fraction = json.metrics.redundantByteFraction;
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps the node mass and the byte coverage labelled apart", async () => {
    const { markdown, json } = await runReport({ config: fixtureConfig(), minNodes: 5 });
    expect(markdown).toContain("duplicated mass");
    expect(markdown).toContain("duplicated coverage");
    // The two must not be confusable: mass is a node count, coverage a percent.
    expect(markdown).toMatch(/\| duplicated mass \| \d+ redundant nodes/);
    expect(markdown).toMatch(/\| duplicated coverage \| \d+\.\d% of source bytes \|/);
    expect(json.metrics.duplicatedMass).toBeGreaterThan(1);
  });

  it("throws rather than reporting an empty codebase as clean", async () => {
    // "0 files / 0 LOC ... 0 findings" is indistinguishable, to a harness,
    // from a codebase with nothing wrong with it. It must be an error.
    await expect(runReport({ config: emptyConfig(), minNodes: 15 })).rejects.toThrow(
      /no source files/i,
    );
  });

  it("names the config it tried in the empty-project error", async () => {
    await expect(runReport({ config: emptyConfig(), minNodes: 15 })).rejects.toThrow(
      /fixtures\/empty\/tsconfig\.json/,
    );
  });

  it("suggests the likely causes of an empty project", async () => {
    await expect(runReport({ config: emptyConfig(), minNodes: 15 })).rejects.toThrow(
      /references|include/i,
    );
  });

  it("caps findings per section without changing the stated total", async () => {
    const capped = await runReport({ config: fixtureConfig(), minNodes: 5, maxFindings: 1 });
    expect(capped.json.duplication.length).toBeLessThanOrEqual(1);
    expect(capped.json.totalFindings).toBeGreaterThan(1);
    expect(capped.markdown).toMatch(/findings are not shown above/);
  });
});
