import { describe, expect, it } from "vitest";
import { buildImportIndex, findingContext } from "../src/report/context.js";

/** `graph` is file -> files it imports. */
function index(graph: Record<string, string[]>) {
  return buildImportIndex(Object.keys(graph), (f) => graph[f] ?? []);
}

describe("findingContext: what every copy already imports", () => {
  it("names what all the copies import and nothing else does not", () => {
    // The fact that decided a real finding: 19 duplicated classes all extend a
    // base class that already has the generic factory methods they reimplement.
    // Without it the finding reads as "design a new abstraction"; with it, as
    // "delete the overrides".
    const graph = {
      "a.ts": ["base.ts", "only-a.ts"],
      "b.ts": ["base.ts", "only-b.ts"],
      "c.ts": ["base.ts"],
      "base.ts": [],
      "only-a.ts": [],
      "only-b.ts": [],
    };
    const c = findingContext(["a.ts", "b.ts", "c.ts"], index(graph), 6);
    expect(c.sharedImports).toEqual(["base.ts"]);
  });

  it("does not name a cluster member, however much the members cross-import", () => {
    // Holds structurally rather than by a guard: a member survives the
    // intersection only if every member imports it, itself included.
    const graph = {
      "a.ts": ["b.ts", "c.ts", "base.ts"],
      "b.ts": ["a.ts", "c.ts", "base.ts"],
      "c.ts": ["a.ts", "b.ts", "base.ts"],
      "base.ts": [],
    };
    const c = findingContext(["a.ts", "b.ts", "c.ts"], index(graph), 4);
    expect(c.sharedImports).toEqual(["base.ts"]);
  });

  it("drops an import the whole codebase makes", () => {
    // A logger or a `cn()` helper is common to every cluster and therefore
    // distinguishes none of them. The claim worth printing is "these copies
    // share something the rest of the codebase does not".
    const everywhere = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`f${i}.ts`, ["log.ts"]]),
    );
    const graph: Record<string, string[]> = { ...everywhere, "log.ts": [], "base.ts": [] };
    graph["f0.ts"] = ["log.ts", "base.ts"];
    graph["f1.ts"] = ["log.ts", "base.ts"];
    const c = findingContext(["f0.ts", "f1.ts"], index(graph), 22);
    expect(c.sharedImports).toEqual(["base.ts"]);
  });

  it("says nothing for a cluster confined to one file", () => {
    // One file's import list is not something its copies share.
    const graph = { "a.ts": ["base.ts"], "base.ts": [] };
    expect(findingContext(["a.ts"], index(graph), 2).sharedImports).toEqual([]);
  });

  it("says nothing when the copies have no import in common", () => {
    const graph = { "a.ts": ["x.ts"], "b.ts": ["y.ts"], "x.ts": [], "y.ts": [] };
    expect(findingContext(["a.ts", "b.ts"], index(graph), 4).sharedImports).toEqual([]);
  });

  it("caps and sorts what it names", () => {
    const shared = ["e.ts", "d.ts", "c.ts", "b.ts", "a.ts"];
    const graph: Record<string, string[]> = { "one.ts": shared, "two.ts": shared };
    for (const s of shared) graph[s] = [];
    const c = findingContext(["one.ts", "two.ts"], index(graph), 7);
    expect(c.sharedImports).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("findingContext: blast radius", () => {
  it("counts the distinct files outside the cluster that import into it", () => {
    // Turns "this looks big" into "this is contained", which is what decides
    // whether a finding gets scheduled.
    const graph = {
      "a.ts": [],
      "b.ts": [],
      "user1.ts": ["a.ts"],
      "user2.ts": ["a.ts", "b.ts"], // two edges in, one file
      "unrelated.ts": [],
    };
    expect(findingContext(["a.ts", "b.ts"], index(graph), 5).dependents).toBe(2);
  });

  it("does not count members importing each other as outside dependents", () => {
    const graph = { "a.ts": ["b.ts"], "b.ts": ["a.ts"], "outside.ts": ["a.ts"] };
    expect(findingContext(["a.ts", "b.ts"], index(graph), 3).dependents).toBe(1);
  });

  it("reports zero for a cluster nothing else reaches", () => {
    // A real answer, not a missing one: nothing outside imports these, so the
    // extraction cannot break a caller.
    const graph = { "a.ts": [], "b.ts": [], "elsewhere.ts": ["other.ts"], "other.ts": [] };
    expect(findingContext(["a.ts", "b.ts"], index(graph), 4).dependents).toBe(0);
  });
});
