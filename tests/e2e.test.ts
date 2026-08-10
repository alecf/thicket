import { describe, expect, it } from "vitest";
import { runReport } from "../src/run.js";
import {
  emptyConfig,
  fixtureConfig,
  importsFixtureConfig,
  testSplitConfig,
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
