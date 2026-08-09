import { describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { buildModuleGraph } from "../src/graph/build.js";
import { propagationCost, stronglyConnected } from "../src/graph/metrics.js";
import { fixtureConfig, monorepoConfigs } from "./helpers.js";

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
      { from: "a", to: "shared", weight: 2 },
      { from: "b", to: "shared", weight: 2 },
    ]);
  });
});
