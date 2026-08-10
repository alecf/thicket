import { describe, expect, it } from "vitest";
import { buildImportIndex, findingContext } from "../src/report/context.js";

/**
 * `graph` is file -> files it imports; `reexports` is file -> what it forwards
 * with `export … from` and nothing else of its own.
 */
function index(graph: Record<string, string[]>, reexports: Record<string, string[]> = {}) {
  return buildImportIndex(
    Object.keys(graph),
    (f) => graph[f] ?? [],
    (f) => reexports[f] ?? [],
  );
}

/** Just the paths, for the tests that do not care where a shim forwards. */
const paths = (c: { sharedImports: { path: string }[] }) => c.sharedImports.map((s) => s.path);

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
    expect(paths(c)).toEqual(["base.ts"]);
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
    expect(paths(c)).toEqual(["base.ts"]);
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
    expect(paths(c)).toEqual(["base.ts"]);
  });

  it("says nothing for a cluster confined to one file", () => {
    // One file's import list is not something its copies share.
    const graph = { "a.ts": ["base.ts"], "base.ts": [] };
    expect(paths(findingContext(["a.ts"], index(graph), 2))).toEqual([]);
  });

  it("says nothing when the copies have no import in common", () => {
    const graph = { "a.ts": ["x.ts"], "b.ts": ["y.ts"], "x.ts": [], "y.ts": [] };
    expect(paths(findingContext(["a.ts", "b.ts"], index(graph), 4))).toEqual([]);
  });

  it("caps and sorts what it names", () => {
    const shared = ["e.ts", "d.ts", "c.ts", "b.ts", "a.ts"];
    const graph: Record<string, string[]> = { "one.ts": shared, "two.ts": shared };
    for (const s of shared) graph[s] = [];
    const c = findingContext(["one.ts", "two.ts"], index(graph), 7);
    expect(paths(c)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("findingContext: through re-export shims", () => {
  it("follows a shim to the module it forwards", () => {
    // The failure this fixes. A real finding named
    // `models/member/vitals/VitalObservation.ts` as the abstraction all 19
    // copies share; that file is nine lines of `export * from`. The base class
    // the whole refactor hinges on -- 1012 lines, with the polymorphic static
    // helpers already written -- was one hop further on, and the agent had to
    // go find it. This field exists to point at the abstraction, and it was
    // stopping at the signpost.
    const graph = {
      "a.ts": ["shim.ts"],
      "b.ts": ["shim.ts"],
      "shim.ts": ["packages/models/Base.ts"],
      "packages/models/Base.ts": [],
    };
    const c = findingContext(["a.ts", "b.ts"], index(graph, { "shim.ts": ["packages/models/Base.ts"] }), 4);
    expect(c.sharedImports).toEqual([
      { path: "shim.ts", forwardsTo: "packages/models/Base.ts" },
    ]);
  });

  it("follows a chain of shims to the end", () => {
    const graph = {
      "a.ts": ["one.ts"],
      "b.ts": ["one.ts"],
      "one.ts": ["two.ts"],
      "two.ts": ["real.ts"],
      "real.ts": [],
    };
    const reexports = { "one.ts": ["two.ts"], "two.ts": ["real.ts"] };
    const c = findingContext(["a.ts", "b.ts"], index(graph, reexports), 5);
    expect(c.sharedImports).toEqual([{ path: "one.ts", forwardsTo: "real.ts" }]);
  });

  it("does not follow a barrel that forwards many modules", () => {
    // `export * from` × 30 is an index, not a shim: there is no single module
    // it stands for, and naming one of the thirty would be a guess.
    const graph = { "a.ts": ["index.ts"], "b.ts": ["index.ts"], "index.ts": ["x.ts", "y.ts"], "x.ts": [], "y.ts": [] };
    const c = findingContext(["a.ts", "b.ts"], index(graph, { "index.ts": ["x.ts", "y.ts"] }), 5);
    expect(c.sharedImports).toEqual([{ path: "index.ts" }]);
  });

  it("does not follow a file that re-exports and also declares its own code", () => {
    // `reexportsOf` reports nothing for such a file, because what the copies
    // share may well be the part it declares itself.
    const graph = { "a.ts": ["mixed.ts"], "b.ts": ["mixed.ts"], "mixed.ts": ["dep.ts"], "dep.ts": [] };
    const c = findingContext(["a.ts", "b.ts"], index(graph), 4);
    expect(c.sharedImports).toEqual([{ path: "mixed.ts" }]);
  });

  it("stops rather than looping when shims forward to each other", () => {
    const graph = { "a.ts": ["one.ts"], "b.ts": ["one.ts"], "one.ts": ["two.ts"], "two.ts": ["one.ts"] };
    const reexports = { "one.ts": ["two.ts"], "two.ts": ["one.ts"] };
    // A file count large enough that `two.ts` importing `one.ts` does not trip
    // the ubiquity filter, which would empty the answer for an unrelated reason.
    const c = findingContext(["a.ts", "b.ts"], index(graph, reexports), 12);
    // Whatever it names, it must terminate and must not name the shim as its
    // own destination.
    expect(c.sharedImports[0]?.path).toBe("one.ts");
    expect(c.sharedImports[0]?.forwardsTo).not.toBe("one.ts");
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
    expect(findingContext(["a.ts", "b.ts"], index(graph), 5).dependents.direct).toBe(2);
  });

  it("does not count members importing each other as outside dependents", () => {
    const graph = { "a.ts": ["b.ts"], "b.ts": ["a.ts"], "outside.ts": ["a.ts"] };
    expect(findingContext(["a.ts", "b.ts"], index(graph), 3).dependents.direct).toBe(1);
  });

  it("reports zero for a cluster nothing else reaches", () => {
    // A real answer, not a missing one: nothing outside imports these, so the
    // extraction cannot break a caller.
    const graph = { "a.ts": [], "b.ts": [], "elsewhere.ts": ["other.ts"], "other.ts": [] };
    expect(findingContext(["a.ts", "b.ts"], index(graph), 4).dependents.direct).toBe(0);
  });

  it("counts what a barrel hides behind it, and names the barrel", () => {
    // The number was a floor presented as a total. On a real cluster of 19
    // files the honest direct count was 5 -- four co-located test files and an
    // `index.ts` -- while 17 more files reached the cluster through that
    // index. "5 files" reads as contained; it is not.
    const graph: Record<string, string[]> = {
      "a.ts": [],
      "b.ts": [],
      "index.ts": ["a.ts", "b.ts"],
      "a.test.ts": ["a.ts"],
    };
    for (let i = 0; i < 17; i++) graph[`user${i}.ts`] = ["index.ts"];
    const c = findingContext(["a.ts", "b.ts"], index(graph, { "index.ts": ["a.ts", "b.ts"] }), 21);
    expect(c.dependents.direct).toBe(2);
    expect(c.dependents.throughBarrels).toBe(17);
    expect(c.dependents.barrels).toEqual(["index.ts"]);
  });

  it("does not double-count a file that imports both the barrel and a member", () => {
    const graph = {
      "a.ts": [],
      "index.ts": ["a.ts"],
      "both.ts": ["index.ts", "a.ts"],
      "b.ts": [],
    };
    const c = findingContext(["a.ts", "b.ts"], index(graph, { "index.ts": ["a.ts"] }), 4);
    expect(c.dependents.direct).toBe(2); // index.ts and both.ts
    expect(c.dependents.throughBarrels).toBe(0);
  });

  it("says nothing about barrels when no dependent is one", () => {
    const graph = { "a.ts": [], "b.ts": [], "user.ts": ["a.ts"] };
    const c = findingContext(["a.ts", "b.ts"], index(graph), 3);
    expect(c.dependents.throughBarrels).toBe(0);
    expect(c.dependents.barrels).toEqual([]);
  });
});
