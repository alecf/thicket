import { describe, expect, it } from "vitest";
import { runReport } from "../src/run.js";
import {
  configTableConfig,
  meshConfig,
  typeCycleConfig,
  typeShapeConfig,
  driftConfig,
  emptyConfig,
  fixtureConfig,
  importsFixtureConfig,
  passThroughConfig,
  tangleConfig,
  typeCutConfig,
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
      markdown.indexOf("## Duplication in tests"),
    );
    const production = markdown.slice(
      markdown.indexOf("## Duplication"),
      markdown.indexOf("## Duplication in tests"),
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

  it("proposes no cut for a module cycle that no file cycle underlies", async () => {
    // `model` and `pure` are mutually dependent as MODULES -- `model/uses.ts`
    // imports `pure/describe.ts`, which imports `model/types.ts` -- while the
    // files form a plain chain. Nothing is circular, so severing an edge
    // removes no cycle that exists. The report used to propose one anyway, and
    // an agent handed the equivalent finding on a real 7-module tangle spent
    // its time establishing that the suggested change altered nothing.
    const { json } = await runReport({ config: typeOnlyConfig(), granularity: 2, minNodes: 100 });
    const cycle = json.cycles.find((c) => c.modules.includes("model") && c.modules.includes("pure"));
    expect(cycle).toBeDefined();
    expect(cycle!.modules.sort()).toEqual(["model", "pure"]);
    expect(cycle!.fileCycles?.crossing.count).toBe(0);
    expect(cycle!.cuts).toEqual([]);
    // And the residual is the component unchanged, never a claim of progress.
    expect(cycle!.residual).toBe(2);
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

  it("refuses a cheap type-only cut that only detaches a leaf", async () => {
    // `shape` sits in the SCC by two `import type` edges and nothing else, so
    // detaching it is the cheapest cut on offer -- and it leaves the alpha/
    // beta/gamma clique exactly as knotted. This case is why type-only cuts
    // were banned outright, after an agent executed one like it in ten minutes
    // and correctly called it a no-op. The ban was aimed at the wrong
    // property: what makes this worthless is that it shaves one module off a
    // four-module tangle, which the residual bar rejects whether the edge is
    // erased or not. A type-only cut that BREAKS a cycle is now proposed --
    // see the type-cycle cases below.
    const { json, markdown } = await runReport({
      config: typeCutConfig(),
      granularity: 2,
      minNodes: 100,
    });
    const cycle = json.cycles[0]!;
    expect(cycle.modules.sort()).toEqual(["alpha", "beta", "gamma", "shape"]);
    // The cheap cut exists, is type-only, and is the most dissolving on offer.
    const shapeEdges = cycle.edges.filter((e) => e.from === "shape" || e.to === "shape");
    expect(shapeEdges).toHaveLength(2);
    expect(shapeEdges.every((e) => e.typeOnly)).toBe(true);
    expect(cycle.cuts).toEqual([]);
    expect(cycle.residual).toBe(4);
    // Refused for shaving, and the report says so with the number it rejected.
    expect(cycle.bestRejectedResidual).toBe(3);
    expect(markdown).toContain("the best available removes 1 of 4 modules");
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

  it("refuses a cut that shaves the tangle instead of breaking it", async () => {
    // Four files in a complete mesh, plus a leaf. No single edge inside the
    // mesh disconnects it, so the best cut available detaches the leaf: five
    // modules down to four, with the mesh untouched. That is not a fix, and
    // offering it is the failure mode the type-only refusal exposed -- the
    // chooser correctly rejected the pointless edge and then reached for the
    // next candidate instead of concluding there is nothing to suggest. On a
    // real 9-module tangle every available cut left 8.
    const { json } = await runReport({
      config: meshConfig(),
      granularity: "file",
      minNodes: 100,
      cache: false,
    });
    const cycle = json.cycles[0]!;
    expect(cycle.modules.length).toBe(5);
    expect(cycle.cuts).toEqual([]);
    // And says so, rather than printing a cut line with nothing under it.
    expect(cycle.residual).toBe(5);
    // The best it could do is remembered, because "nothing helps" and "the
    // best available removes one of five" are different answers and only one
    // of them is true here.
    expect(cycle.bestRejectedResidual).toBe(4);
  });

  it("does not explain a dotted arrow it never draws", async () => {
    const mesh = await runReport({
      config: meshConfig(),
      granularity: "file",
      minNodes: 100,
      cache: false,
    });
    expect(mesh.markdown).toContain("## Module tangle");
    expect(mesh.markdown).not.toContain("dotted arrow");
    // And still explains it where a cut is actually suggested.
    const tangle = await runReport({ config: tangleConfig(), granularity: 2, minNodes: 100 });
    expect(tangle.markdown).toContain("dotted arrow");
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

describe("what varies between the copies", () => {
  it("names the constants that parameterize a repeated shape", async () => {
    // The gap that cost an agent most of its investigation: the report said 19
    // classes were the same and stopped, when what decided the refactor was
    // the short list of what DIFFERS -- six constants, which turns "19 similar
    // classes" into "19 rows of a config table" and hands you the base class's
    // field list. Extracting them by hand is also how it found two classes
    // sharing a LOINC code, a live bug unrelated to the duplication.
    const { markdown } = await runReport({ config: configTableConfig(), cache: false });
    const line = markdown.split("\n").find((l) => l.startsWith("- **varies across copies:**"));
    expect(line).toBeDefined();
    for (const constant of ["loincCode", "loincDisplay", "unit", "junctionKey"]) {
      expect(line).toContain(`\`${constant}\` (4)`);
    }
    // The class name differs too, and saying so would be noise: that is what
    // an L1 match already means, and it would bury the four that matter.
    expect(line).not.toContain("Observation");
  });

  it("prints an exact count when every copy was compared", async () => {
    // Four copies, all four compared, four distinct values -- the count is
    // measured, not sampled, and marking it `≥4` would understate what the
    // tool actually knows.
    const { markdown } = await runReport({ config: configTableConfig(), cache: false });
    const line = markdown.split("\n").find((l) => l.startsWith("- **varies across copies:**"));
    expect(line).toContain("`loincCode` (4)");
    expect(line).not.toContain("≥");
  });
});

describe("the excerpt", () => {
  it("shows enough of a long shape to tell it from a near-identical sibling", async () => {
    // A flat three lines failed on exactly the findings that needed it most.
    // On a real 15-line block the elided lines 4-13 were the only thing
    // separating that cluster from five near-identical siblings; the three
    // shown were the part every variant had in common, so the excerpt
    // displayed the agreement and hid the disagreement.
    const { markdown } = await runReport({ config: configTableConfig(), cache: false });
    const fence = markdown.split("\n");
    const open = fence.findIndex((l) => l === "```ts");
    const close = fence.findIndex((l, i) => i > open && l === "```");
    const body = fence.slice(open + 1, close);
    expect(body.length).toBeGreaterThan(4);
    // The constants the finding says vary must be visible in the code it shows,
    // or the reader has been told what to look for and not shown where.
    expect(body.join("\n")).toContain("loincDisplay");
  });
});

describe("whether consolidating the copies would buy anything", () => {
  it("ranks a parameterized shape above differently-named ones with more copies", async () => {
    // Copy count measures how MUCH is duplicated, not whether merging leaves
    // the code better. The projections here outnumber the spec blocks and each
    // one differs from the next in every key -- 10 different objects sharing a
    // syntax template, whose only abstraction is a generic `pick` that no
    // future change benefits from. The specs are one concept with a parameter
    // list. On a real application the projection-shaped finding ranked SECOND
    // in the report and two agents asked to act on it declined.
    const { json } = await runReport({ config: driftConfig(), cache: false, minNodes: 12 });
    const where = (i: number) =>
      json.duplication[i]!.occurrences[0]!.filePath.split("/")[1];
    // 30 projections against 4 classes: on copies, lines and raw score the
    // projections win by 108 to 83, and they are the finding no one should do.
    expect(json.duplication[1]!.occurrences).toHaveLength(30);
    expect(where(1)).toBe("project");
    expect(where(0)).toBe("specs");
  });
});

describe("dissolving a cycle instead of cutting it", () => {
  it("names the edge that is routing rather than dependency", async () => {
    // The general form of the barrel problem, without special-casing barrels.
    // `app -> api` exists only because `api/errors.ts` forwards what `app`
    // imports from `core`, so the dependency is on `core` and the specifier is
    // pointing at the wrong file. Repointing it removes the edge and changes
    // nothing: a re-export is the same binding. On a real 12-module tangle
    // four inbound edges to one module were entirely this.
    const { json, markdown } = await runReport({
      config: passThroughConfig(),
      granularity: 2,
      minNodes: 100,
    });
    const cycle = json.cycles[0]!;
    expect(cycle.modules.sort()).toEqual(["api", "app"]);
    expect(cycle.dissolves).toHaveLength(1);
    const [d] = cycle.dissolves!;
    expect({ from: d!.from, to: d!.to }).toEqual({ from: "app", to: "api" });
    expect(d!.passThrough).toBe(2);
    expect(d!.origin).toBe("packages/core/errors.ts");
    expect(markdown).toContain("- **dissolve `app` → `api`:** all 2 imports pass through");
    expect(markdown).toContain("`packages/core/errors.ts`");
  });

  it("does not dissolve a package's own entry point", async () => {
    // `core/index.ts` forwards `core/errors.ts`, so every import through it is
    // 100% pass-through -- and repointing at the internal file would reach past
    // a boundary that exists on purpose. What makes the other case dissolvable
    // is not that it is a barrel, but that what it forwards lives in ANOTHER
    // module. Keeping the rule on that distinction is what stops this from
    // becoming a code-style opinion about barrel files.
    const { json } = await runReport({
      config: passThroughConfig(),
      granularity: 2,
      minNodes: 100,
    });
    // `mid -> core` is 100% pass-through and sits in a real cycle, so the fix
    // chooser genuinely considers it and must decline.
    const midCore = json.cycles.find((c) => c.modules.includes("mid"))!;
    expect(midCore.modules.sort()).toEqual(["core", "mid"]);
    const edge = midCore.edges.find((e) => e.from === "mid" && e.to === "core")!;
    expect(edge.passThrough).toBe(edge.weight);
    expect(midCore.dissolves).toEqual([]);
  });

  it("suggests no cut once dissolving already breaks the cycle", async () => {
    // A cut is a design decision and a dissolve is a find-and-replace. Once
    // the free fix is enough, proposing the expensive one on top of it is
    // asking for work that has already been done.
    const { json } = await runReport({
      config: passThroughConfig(),
      granularity: 2,
      minNodes: 100,
    });
    const cycle = json.cycles.find((c) => c.modules.includes("app"))!;
    expect(cycle.cuts).toEqual([]);
    expect(cycle.residual).toBe(1);
  });
});

describe("duplicated types", () => {
  // A duplicated interface is low-volume by nature: four copies of a five-line
  // shape is 13 recoverable lines against a duplicated function's 43. Scored
  // on volume it can never win, so on a real application 33 groups of
  // structurally identical type declarations -- `SimpleLogger`/`OpsLogger`/
  // `SlackLogger` among them -- were invisible at every depth setting. That is
  // not a ranking to tune; it is two incomparable kinds of work in one
  // contest, which this file's rules say to split rather than weight.
  it("gets its own section, so volume cannot crowd it out", async () => {
    const { markdown, json } = await runReport({
      config: typeShapeConfig(),
      maxFindings: 1,
      cache: false,
    });
    // One slot for code duplication, and the type findings still appear.
    expect(json.duplication).toHaveLength(1);
    expect(markdown).toContain("## Duplicated types");
    expect(json.typeDuplication.length).toBeGreaterThan(0);
  });

  it("routes type declarations out of the code section", async () => {
    // A three-member type alias is smaller than the default fragment floor, so
    // the floor is lowered here: the question is which section a finding lands
    // in, not which sizes are worth reporting.
    const { json } = await runReport({ config: typeShapeConfig(), minNodes: 6, cache: false });
    const kinds = (rs: { kind: string }[]) => rs.map((r) => r.kind);
    expect(kinds(json.typeDuplication)).toContain("InterfaceDeclaration");
    expect(kinds(json.typeDuplication)).toContain("TypeAliasDeclaration");
    // And the code duplication stays where it was.
    expect(kinds(json.duplication)).toContain("FunctionDeclaration");
    expect(kinds(json.duplication)).not.toContain("InterfaceDeclaration");
  });

  it("counts a type literal in a type position as a type", async () => {
    // `TypeLiteral` is the body of `type X = { ... }`. It is erased exactly as
    // an interface is, and grouping it with object literals would put the same
    // duplication in two different sections depending on how it was declared.
    const { json } = await runReport({ config: typeShapeConfig(), minNodes: 6, cache: false });
    expect(json.typeDuplication.map((r) => r.kind)).toContain("TypeLiteral");
  });
});

describe("cutting a cycle that exists only in the type system", () => {
  const load = () =>
    runReport({ config: typeCycleConfig(), granularity: 2, minNodes: 100, cache: false });
  // Generic in the cycle type rather than restating it: a hand-written
  // `{ modules: string[] }` here silently erases every other field, which is
  // how `cuts` and `residual` below stopped type-checking.
  const find = <C extends { modules: string[] }>(json: { cycles: C[] }, m: string) =>
    json.cycles.find((c) => c.modules.includes(m))!;

  it("proposes the cut, and labels it as erased", async () => {
    // `ta` and `tb` reference each other's types and nothing else. Refusing
    // this outright was an over-correction: the rule existed because a
    // type-only cut once shaved one module off a tangle and changed nothing --
    // which the residual bar now catches on its own, for runtime and type cuts
    // alike. A conceptual cycle is real complexity, and breaking it completely
    // is worth saying.
    const { json } = await load();
    const cycle = find(json, "ta");
    expect(cycle.cuts).toHaveLength(1);
    expect(cycle.cuts[0]!.typeOnly).toBe(true);
    expect(cycle.residual).toBe(1);
  });

  it("says in the report that the cut is type-only", async () => {
    const { markdown } = await load();
    expect(markdown).toMatch(/suggested cut:.*type-only symbol/);
  });

  it("still prefers a runtime edge when one breaks the cycle just as well", async () => {
    // `ra -> rb` runs; `rb -> ra` is erased. Both cuts break the cycle
    // completely, so the tie goes to the real one: only a runtime cycle can
    // fail at module-init time.
    const { json } = await load();
    const cycle = find(json, "ra");
    expect(cycle.cuts).toHaveLength(1);
    expect([cycle.cuts[0]!.from, cycle.cuts[0]!.to]).toEqual(["ra", "rb"]);
    expect(cycle.cuts[0]!.typeOnly).toBe(false);
  });
});

describe("the runtime tangle and the type tangle are different graphs", () => {
  // `import type` is erased, so the two graphs can be very different objects:
  // on a real application the same component was 9 modules with all edges and
  // 7 once type-only edges were dropped. A reader cannot derive the second
  // from the printed chart -- an edge labelled `1352 (241 type)` still exists
  // at runtime, so partial per-edge counts do not compose -- and both numbers
  // matter. A runtime cycle can fail at module-init time; a type cycle is a
  // knot someone has to hold in their head. Neither is the "real" one.
  it("reports how much of a tangle survives erasure", async () => {
    const { json } = await runReport({
      config: typeCutConfig(),
      granularity: 2,
      minNodes: 100,
      cache: false,
    });
    const cycle = json.cycles[0]!;
    expect(cycle.modules).toHaveLength(4);
    // `shape` hangs off the clique by two type-only edges, so it is not in the
    // runtime cycle at all.
    expect(cycle.runtimeModules).toBe(3);
  });

  it("says so in the heading", async () => {
    const { markdown } = await runReport({
      config: typeCutConfig(),
      granularity: 2,
      minNodes: 100,
      cache: false,
    });
    expect(markdown).toMatch(/SCC of 4 modules.*3 at runtime/);
  });

  it("calls a purely conceptual cycle what it is", async () => {
    const { json, markdown } = await runReport({
      config: typeCycleConfig(),
      granularity: 2,
      minNodes: 100,
      cache: false,
    });
    const cycle = json.cycles.find((c) => c.modules.includes("ta"))!;
    expect(cycle.runtimeModules).toBe(1);
    expect(markdown).toMatch(/SCC of 2 modules.*nothing at runtime/);
  });

  it("carries the same fact into the summary metric", async () => {
    const { markdown } = await runReport({
      config: typeCutConfig(),
      granularity: 2,
      minNodes: 100,
      cache: false,
    });
    expect(markdown).toMatch(/largest SCC: 4 modules, 3 at runtime/);
  });

  it("stays quiet when erasure changes nothing", async () => {
    // The ordinary case: every edge runs, so a second number would be noise.
    const { markdown, json } = await runReport({
      config: tangleConfig(),
      granularity: 2,
      minNodes: 100,
      cache: false,
    });
    expect(json.cycles[0]!.runtimeModules).toBe(json.cycles[0]!.modules.length);
    expect(markdown).not.toContain("at runtime");
  });
});

describe("the --types setting", () => {
  const run = (types: "include" | "exclude" | "only", config: string, extra = {}) =>
    runReport({ config, cache: false, types, ...extra });

  it("includes both by default", async () => {
    const { json } = await runReport({ config: typeShapeConfig(), minNodes: 6, cache: false });
    expect(json.duplication.length).toBeGreaterThan(0);
    expect(json.typeDuplication.length).toBeGreaterThan(0);
  });

  it("exclude drops type duplication and type-only edges", async () => {
    const { json } = await run("exclude", typeShapeConfig(), { minNodes: 6 });
    expect(json.typeDuplication).toEqual([]);
    expect(json.duplication.length).toBeGreaterThan(0);

    // A cycle held together by types alone is not a cycle in this mode.
    const cyc = await run("exclude", typeCycleConfig(), { granularity: 2, minNodes: 100 });
    expect(cyc.json.cycles.find((c) => c.modules.includes("ta"))).toBeUndefined();
  });

  it("only keeps type duplication and drops the code section", async () => {
    const { json } = await run("only", typeShapeConfig(), { minNodes: 6 });
    expect(json.duplication).toEqual([]);
    expect(json.typeDuplication.length).toBeGreaterThan(0);
  });

  it("is part of the config hash, so a warm cache cannot serve the wrong one", async () => {
    const a = await run("include", typeShapeConfig(), { minNodes: 6 });
    const b = await run("exclude", typeShapeConfig(), { minNodes: 6 });
    expect(a.json.configHash).not.toBe(b.json.configHash);
  });

  it("agrees with the runtime figure the default mode prints", async () => {
    // Two independent paths to the same number: `include` erases type edges
    // when measuring `runtimeModules`, `exclude` never builds them. If they
    // disagree, one of them is wrong and the report contradicts itself.
    const both = await run("include", typeCutConfig(), { granularity: 2, minNodes: 100 });
    const runtimeOnly = await run("exclude", typeCutConfig(), { granularity: 2, minNodes: 100 });
    const largest = (j: { cycles: { modules: string[] }[] }) =>
      j.cycles.reduce((max, c) => Math.max(max, c.modules.length), 0);
    expect(both.json.cycles[0]!.runtimeModules).toBe(largest(runtimeOnly.json));
  });

  it("states the mode in the report when it is not the default", async () => {
    const { markdown } = await run("only", typeShapeConfig(), { minNodes: 6 });
    expect(markdown).toContain("types: only");
    const plain = await runReport({ config: typeShapeConfig(), minNodes: 6, cache: false });
    expect(plain.markdown).not.toContain("types:");
  });
});
