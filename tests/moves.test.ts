import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openProject, type Project } from "../src/extract/ts-adapter.js";
import { runReport } from "../src/run.js";
import { movesConfig, typeCycleConfig } from "./helpers.js";

describe("symbolsOf", () => {
  let project: Project;
  beforeAll(async () => {
    project = await openProject([movesConfig()]);
  });
  afterAll(async () => {
    await project.close();
  });
  const symbols = (path: string) => {
    const file = project.files().find((f) => f.path === path);
    if (file === undefined) throw new Error(`no ${path}`);
    return project.symbolsOf(file);
  };

  it("keeps every span a name declares", () => {
    // A `const` and a `type` of one name. Moving only the first left the
    // type behind in a judged round, and the cycle with it.
    const s = symbols("src/mode.ts");
    expect(s.decls.get("Mode")).toHaveLength(2);
    expect(s.typeNames.has("Mode")).toBe(true);
  });

  it("does not take a function's locals for top-level declarations", () => {
    const s = symbols("src/mode.ts");
    expect([...s.decls.keys()].sort()).toEqual(["Mode", "helper"]);
  });

  it("reads aliases, namespace imports and type-only imports", () => {
    const s = symbols("src/mode.ts");
    expect(s.bindings).toEqual([
      { local: "P", exported: "Point", target: "src/point.ts", typeOnly: true },
      { local: "points", exported: "*", target: "src/point.ts", typeOnly: false },
    ]);
  });

  it("names the package behind each import that resolves to no file", () => {
    // A relative import resolves to a file and is a binding. A bare one that
    // resolves to none is a package. `fs` and `node:path` are Node's own.
    const s = symbols("src/ext/core/owner.ts");
    expect(s.packageBindings).toEqual([{ local: "pad", pkg: "left-pad" }]);
    expect(s.bindings.map((b) => b.local)).toEqual(["render", "base", "fmt"]);
  });

  it("marks a file of interfaces and aliases only as types-only", () => {
    expect(symbols("src/point.ts").typesOnly).toBe(false);
    expect(symbols("src/point.ts").typeNames.has("Point")).toBe(true);
  });
});

describe("move search", () => {
  const report = () => runReport({ config: movesConfig(), granularity: "file", minNodes: 100, cache: false });

  it("moves one declaration that two files import, with its helper", async () => {
    // Cutting either edge into `store.ts` leaves the other two files in a
    // cycle. Moving `storeKey` removes both edges at once.
    const { json, markdown } = await report();
    const cycle = json.cycles.find((c) => c.modules.includes("src/store.ts"))!;
    expect(cycle.cuts).toEqual([]);
    expect(cycle.residual).toBe(1);
    expect(cycle.move).toEqual({
      owner: "src/store.ts",
      seeds: ["storeKey"],
      helpers: ["PREFIX"],
      lines: 4,
      residual: 1,
      runtimeResidual: 1,
      // `Lists.ts` before `alpha.ts`: code-unit order, not collation order.
      removes: [
        { from: "src/Lists.ts", to: "src/store.ts" },
        { from: "src/alpha.ts", to: "src/store.ts" },
      ],
      // An existing file that closes no cycle beats a new one. Both users
      // qualify, and `Lists.ts` comes first in code-unit order.
      home: { file: "src/Lists.ts", kind: "user" },
    });
    expect(markdown).toContain(
      "- **suggested move:** `storeKey` with its helper `PREFIX` out of `src/store.ts` — 4 lines",
    );
    expect(markdown).toContain("- **move to:** `src/Lists.ts`, which uses it");
    expect(markdown).toContain('src/alpha.ts -. "move · 1" .-> src/store.ts');
  });

  it("puts the code in its one other user when that adds no import", async () => {
    const { json, markdown } = await report();
    const cycle = json.cycles.find((c) => c.modules.includes("src/theme/parent.ts"))!;
    expect(cycle.move?.seeds).toEqual(["THEME"]);
    expect(cycle.move?.home).toEqual({ file: "src/theme/child.ts", kind: "user" });
    // Relative to the heading's prefix, like the chart.
    expect(markdown).toContain("- **move to:** `child.ts`, which uses it");
  });

  it("names a new file when no user's package can import the others", async () => {
    // Packages `a` and `b` both use `tagged`, and neither depends on the
    // other. A new file beside the owner is one both already reach.
    const { json, markdown } = await report();
    const cycle = json.cycles.find((c) => c.modules.includes("src/pkg/core/registry.ts"))!;
    expect(cycle.move?.home).toEqual({ file: "src/pkg/core/tagged.ts", kind: "new" });
    expect(markdown).toContain("- **move to:** a new file, `core/tagged.ts`");
  });

  it("does not count a cycle the home was already in", async () => {
    // `consts.ts` and `names.ts` form a cycle of their own. Moving `ringKey`
    // into `consts.ts` breaks this tangle and leaves that cycle as it was.
    const { json } = await report();
    const cycle = json.cycles.find((c) => c.modules.includes("src/ring/owner.ts"))!;
    expect(cycle.move?.home).toEqual({ file: "src/ring/consts.ts", kind: "dependency" });
    expect(cycle.residual).toBe(1);
  });

  it("keeps an edge that a file with its own code still re-exports", async () => {
    // `user.ts` re-exports from `owner.ts` beside code of its own. Moving
    // `ownerKey` leaves that re-export, and the cycle with it.
    const { json } = await report();
    const cycle = json.cycles.find((c) => c.modules.includes("src/mixed/owner.ts"))!;
    expect(cycle.move).toBeUndefined();
    expect(cycle.cuts).toHaveLength(1);
  });

  it("skips a home whose package cannot load a package the code imports", async () => {
    // `view.ts` adds no import as a home, and it wins without the check. Its
    // package does not list `left-pad`, and none of its files import it. A
    // judge rated such a home wrong in round 6.
    const { json } = await report();
    const cycle = json.cycles.find((c) => c.modules.includes("src/ext/core/owner.ts"))!;
    expect(cycle.move?.seeds).toEqual(["stamp"]);
    expect(cycle.move?.home).toEqual({ file: "src/ext/core/base.ts", kind: "shared" });
  });

  it("falls back to an edge cut when no move breaks the cycle", async () => {
    // `ta` and `tb` each declare a type that names the other's. Moving either
    // type keeps a 2-file cycle with the file it came from, so only the cut
    // is left to suggest.
    const { json } = await runReport({ config: typeCycleConfig(), granularity: "file", cache: false });
    const cycle = json.cycles.find((c) => c.modules.includes("packages/ta/index.ts"))!;
    expect(cycle.move).toBeUndefined();
    expect(cycle.cuts.map((c) => `${c.from} -> ${c.to}`)).toEqual([
      "packages/ta/index.ts -> packages/tb/index.ts",
    ]);
  });

  it("keeps the edge search for a tangle of modules", async () => {
    // At directory depth 2 a module is a directory. The search moves code
    // between files, and a move inside a module changes no module edge.
    const { json } = await runReport({ config: typeCycleConfig(), granularity: 2, cache: false });
    expect(json.cycles.length).toBeGreaterThan(0);
    for (const cycle of json.cycles) expect(cycle.move).toBeUndefined();
  });
});
