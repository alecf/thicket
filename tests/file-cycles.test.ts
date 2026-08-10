import { describe, expect, it } from "vitest";
import { fileCycles } from "../src/graph/file-cycles.js";

/** `graph` is file -> files it imports; `mod` maps a file to its module. */
function run(graph: Record<string, string[]>, mod: Record<string, string>) {
  return fileCycles(
    Object.keys(graph),
    (f) => graph[f] ?? [],
    (f) => mod[f],
  );
}

describe("fileCycles", () => {
  it("reports none when a module cycle is only a grouping artifact", () => {
    // The fact that reframed a whole finding. A 7-module SCC looked alarming;
    // at file level there was not one cycle crossing any of those module
    // boundaries, so nothing circular executes and the tangle is layering
    // drift, not an initialization hazard. Without this the reader cannot
    // tell that case from a genuine knot.
    //
    // a -> b and b -> a as MODULES, via different files: a1 -> b1, b2 -> a2.
    const graph = { a1: ["b1"], b1: [], b2: ["a2"], a2: [] };
    const mod = { a1: "a", a2: "a", b1: "b", b2: "b" };
    const out = run(graph, mod);
    expect(out.crossing.count).toBe(0);
    expect(out.within.count).toBe(0);
  });

  it("counts a file cycle that crosses two modules", () => {
    const graph = { a1: ["b1"], b1: ["a1"] };
    const out = run(graph, { a1: "a", b1: "b" });
    expect(out.crossing.count).toBe(1);
    expect(out.crossing.largest).toBe(2);
    expect(out.crossing.example).toEqual(["a1", "b1"]);
    expect(out.within.count).toBe(0);
  });

  it("counts a file cycle confined to one module separately", () => {
    // Real, but a different problem: it is inside a module the grouping
    // already claims belongs together, so it says nothing about THIS tangle.
    const graph = { a1: ["a2"], a2: ["a1"], b1: [] };
    const out = run(graph, { a1: "a", a2: "a", b1: "b" });
    expect(out.within.count).toBe(1);
    expect(out.within.largest).toBe(2);
    expect(out.crossing.count).toBe(0);
  });

  it("describes the largest cycle of each kind", () => {
    const graph = {
      // crossing, 3 files
      a1: ["b1"],
      b1: ["c1"],
      c1: ["a1"],
      // crossing, 2 files
      a2: ["b2"],
      b2: ["a2"],
      // within `a`, 2 files
      a3: ["a4"],
      a4: ["a3"],
    };
    const mod = { a1: "a", a2: "a", a3: "a", a4: "a", b1: "b", b2: "b", c1: "c" };
    const out = run(graph, mod);
    expect(out.crossing.count).toBe(2);
    expect(out.crossing.largest).toBe(3);
    expect(out.crossing.example).toEqual(["a1", "b1", "c1"]);
    expect(out.within.count).toBe(1);
    expect(out.within.largest).toBe(2);
  });

  it("ignores a file outside the modules it was given", () => {
    // The caller passes the files of one component; an import leaving it is
    // not part of that component's story.
    const graph = { a1: ["outside"], outside: ["a1"], b1: [] };
    const out = run(graph, { a1: "a", b1: "b" });
    expect(out.crossing.count).toBe(0);
    expect(out.within.count).toBe(0);
  });

  it("caps the files it names but still reports the true size", () => {
    const ring = ["f0", "f1", "f2", "f3", "f4", "f5"];
    const graph = Object.fromEntries(ring.map((f, i) => [f, [ring[(i + 1) % ring.length]!]]));
    const mod = Object.fromEntries(ring.map((f, i) => [f, i % 2 === 0 ? "a" : "b"]));
    const out = run(graph, mod);
    expect(out.crossing.largest).toBe(6);
    expect(out.crossing.example).toEqual(["f0", "f1", "f2", "f3"]);
  });

  it("is deterministic when two cycles are the same size", () => {
    const graph: Record<string, string[]> = { z1: ["z2"], z2: ["z1"], a1: ["a2"], a2: ["a1"] };
    const mod: Record<string, string> = { z1: "z", z2: "y", a1: "a", a2: "b" };
    const forward = fileCycles(["z1", "z2", "a1", "a2"], (f) => graph[f] ?? [], (f) => mod[f]);
    const reverse = fileCycles(["a2", "a1", "z2", "z1"], (f) => graph[f] ?? [], (f) => mod[f]);
    expect(forward).toEqual(reverse);
    // Tie broken by name, not by input order.
    expect(forward.crossing.example).toEqual(["a1", "a2"]);
  });
});
