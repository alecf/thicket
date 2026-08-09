import { describe, expect, it } from "vitest";
import { runReport } from "../src/run.js";
import { fixtureConfig } from "./helpers.js";

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
    const full = await runReport({ config: fixtureConfig(), minNodes: 5 });
    const tight = await runReport({
      config: fixtureConfig(),
      minNodes: 5,
      budgetTokens: 300,
    });
    expect(tight.markdown.length).toBeLessThan(full.markdown.length);
    expect(tight.markdown).toMatch(/further findings omitted/);
    // The stated total must be the pre-truncation candidate count, not the
    // number shown -- otherwise a harness cannot tell it is seeing a slice.
    expect(tight.json.totalFindings).toBe(full.json.totalFindings);
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

  it("caps findings per section without changing the stated total", async () => {
    const capped = await runReport({ config: fixtureConfig(), minNodes: 5, maxFindings: 1 });
    expect(capped.json.duplication.length).toBeLessThanOrEqual(1);
    expect(capped.json.totalFindings).toBeGreaterThan(1);
    expect(capped.markdown).toMatch(/further findings omitted/);
  });
});
