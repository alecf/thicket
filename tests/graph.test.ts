import { describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { buildModuleGraph } from "../src/graph/build.js";
import { propagationCost, stronglyConnected } from "../src/graph/metrics.js";
import { fixtureConfig, monorepoConfigs, typeOnlyConfig } from "./helpers.js";

describe("stronglyConnected", () => {
  it("finds a simple 2-node cycle", () => {
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", []],
    ]);
    expect(stronglyConnected(["a", "b", "c"], adj).filter((s) => s.length > 1)).toEqual([
      ["a", "b"],
    ]);
  });

  it("returns no multi-node component for a DAG", () => {
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    expect(stronglyConnected(["a", "b", "c"], adj).filter((s) => s.length > 1)).toEqual([]);
  });

  it("is deterministic in component and member order", () => {
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["d"]],
      ["d", ["c"]],
    ]);
    const one = JSON.stringify(stronglyConnected(["a", "b", "c", "d"], adj));
    const two = JSON.stringify(stronglyConnected(["d", "c", "b", "a"], adj));
    expect(one).toBe(two);
  });

  it("finds a 3-node cycle and excludes a node that only points into it", () => {
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
      ["d", ["a"]],
    ]);
    expect(stronglyConnected(["a", "b", "c", "d"], adj).filter((s) => s.length > 1)).toEqual([
      ["a", "b", "c"],
    ]);
  });
});

describe("propagationCost", () => {
  it("is 1 for a fully connected graph", () => {
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(propagationCost(["a", "b"], adj)).toBeCloseTo(1);
  });

  it("is 0 for isolated nodes", () => {
    expect(
      propagationCost(
        ["a", "b"],
        new Map([
          ["a", []],
          ["b", []],
        ]),
      ),
    ).toBe(0);
  });

  it("counts transitive reach, not just direct edges", () => {
    // a -> b -> c. Reach: a={b,c}, b={c}, c={}. total 3 over 3x3 = 1/3.
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    expect(propagationCost(["a", "b", "c"], adj)).toBeCloseTo(3 / 9);
  });

  it("is 0 for an empty graph", () => {
    expect(propagationCost([], new Map())).toBe(0);
  });
});

describe("buildModuleGraph", () => {
  it("detects the alpha<->gamma cycle in the fixture", async () => {
    const project = await openProject(fixtureConfig());
    const graph = buildModuleGraph(project, { granularity: "file" });
    const cyclic = stronglyConnected(graph.modules, graph.adjacency).filter((s) => s.length > 1);
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0]).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("weights edges by distinct imported symbols, not by import count", async () => {
    const project = await openProject(fixtureConfig());
    const graph = buildModuleGraph(project, { granularity: "file" });
    const find = (from: string, to: string) =>
      graph.edges.find((e) => e.from === from && e.to === to);
    // alpha.ts: `import { type Point, ORIGIN } from "./util/shared.js"` -> 2
    //           `import { scale } from "./gamma.js"`                     -> 1
    expect(find("src/alpha.ts", "src/util/shared.ts")?.weight).toBe(2);
    expect(find("src/alpha.ts", "src/gamma.ts")?.weight).toBe(1);
  });

  it("never emits a self-edge", async () => {
    const project = await openProject(fixtureConfig());
    const graph = buildModuleGraph(project, { granularity: 1 });
    for (const e of graph.edges) expect(e.from).not.toBe(e.to);
  });

  it("adjacency is consistent with edges", async () => {
    const project = await openProject(fixtureConfig());
    const graph = buildModuleGraph(project, { granularity: "file" });
    for (const e of graph.edges) expect(graph.adjacency.get(e.from)).toContain(e.to);
    const edgeCount = [...graph.adjacency.values()].reduce((n, v) => n + v.length, 0);
    expect(edgeCount).toBe(graph.edges.length);
  });

  it("keeps a multi-project monorepo as one module per package", async () => {
    const project = await openProject(monorepoConfigs());
    const graph = buildModuleGraph(project);
    expect(graph.granularity).toBe("dir:1");
    expect(graph.modules).toEqual(["a", "b", "shared"]);
    // Each package does `import { type Vec, UNIT }` from shared -> weight 2.
    // A weight of 1 here would mean edges are counted per import declaration.
    expect(graph.edges).toEqual([
      {
        from: "a",
        to: "shared",
        weight: 2,
        files: ["a/src/index.ts"],
        erased: 1,
        typeOnly: false,
      },
      {
        from: "b",
        to: "shared",
        weight: 2,
        files: ["b/src/index.ts"],
        erased: 1,
        typeOnly: false,
      },
    ]);
  });

  it("marks an edge type-only only when nothing on it survives compilation", async () => {
    // The weight alone cannot tell a runtime dependency from a filing mistake.
    // On a real application the single most interesting edge in a 12-module
    // tangle was 100% `import type` -- it has no module-init hazard and is
    // fixed by moving a types file -- while the edge the tool suggested
    // cutting was a value import. Reporting them identically sends a reader
    // after the wrong one.
    const project = await openProject(typeOnlyConfig());
    const graph = buildModuleGraph(project, { granularity: 2 });
    expect(graph.modules).toEqual(["effect", "model", "pure", "view"]);
    expect(graph.edges).toEqual([
      {
        // A side-effect import beside an erased one: one binding, erased, and
        // still a runtime dependency. See the test below.
        from: "effect",
        to: "model",
        weight: 1,
        files: ["packages/effect/register.ts"],
        erased: 1,
        typeOnly: false,
      },
      {
        from: "model",
        to: "pure",
        weight: 1,
        files: ["packages/model/uses.ts"],
        erased: 0,
        typeOnly: false,
      },
      {
        from: "pure",
        to: "model",
        weight: 1,
        files: ["packages/pure/describe.ts"],
        erased: 1,
        typeOnly: true,
      },
      // One value import beside one type-only import: still a real dependency.
      {
        from: "view",
        to: "model",
        weight: 4,
        files: ["packages/view/render.ts"],
        erased: 2,
        typeOnly: false,
      },
    ]);
  });

  it("does not erase an edge whose only unerased import binds no names", async () => {
    // `import "./x.js"` beside `import type { A } from "./x.js"` is one
    // binding, erased -- so a rule of "every binding is erased" is vacuously
    // true, and the edge comes out type-only. It is the opposite: the
    // side-effect import is the one form that exists purely for its runtime
    // effect, and calling this edge erasable would tell a reader a live
    // module-init dependency can be cut by moving a types file.
    const project = await openProject(typeOnlyConfig());
    const graph = buildModuleGraph(project, { granularity: 2 });
    const effect = graph.edges.find((e) => e.from === "effect" && e.to === "model")!;
    expect(effect.weight).toBe(1);
    expect(effect.erased).toBe(1);
    expect(effect.typeOnly).toBe(false);
  });

  it("counts how much of a mixed edge is erased, not just whether all of it is", async () => {
    // The boolean alone hides the cheapest fixes. A real 7-module tangle had
    // an edge printed as a bare `5` that was four `import type` bindings and
    // exactly one runtime import in one file: moving that file makes the whole
    // edge erasable. `4 (2 type)` says there is something to look at; `4` does
    // not.
    const project = await openProject(typeOnlyConfig());
    const graph = buildModuleGraph(project, { granularity: 2 });
    const viewToModel = graph.edges.find((e) => e.from === "view" && e.to === "model")!;
    expect(viewToModel.weight).toBe(4);
    expect(viewToModel.erased).toBe(2);
    expect(viewToModel.typeOnly).toBe(false);
  });

  it("names every file carrying an edge, because files are the unit of work", async () => {
    // The weight counts symbols and the edit count is files, and the two differ by
    // up to 2x on real edges. A reader triaging a tangle needs the second.
    const project = await openProject(typeOnlyConfig());
    const graph = buildModuleGraph(project, { granularity: 2 });
    const viewToModel = graph.edges.find((e) => e.from === "view" && e.to === "model")!;
    // Four symbols from two different files in `model`, all imported by ONE
    // file in `view`: four symbols, one edit.
    expect(viewToModel.weight).toBe(4);
    expect(viewToModel.files).toEqual(["packages/view/render.ts"]);
  });
});
