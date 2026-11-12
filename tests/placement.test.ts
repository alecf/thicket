import { describe, expect, it } from "vitest";
import { buildPackages, type PackageManifest } from "../src/graph/packages.js";
import { placementGraph, placementOf } from "../src/graph/placement.js";
import { ORDERING_PROBE } from "./helpers.js";

interface Repo {
  imports: Record<string, string[]>;
  /** File -> module. Default: every file is its own module. */
  modules?: Record<string, string>;
  manifests?: Record<string, PackageManifest>;
}

function graphOf(repo: Repo) {
  const files = [...new Set([...Object.keys(repo.imports), ...Object.values(repo.imports).flat()])].sort();
  const importsOf = (p: string) => repo.imports[p] ?? [];
  const moduleOf = (p: string) => repo.modules?.[p] ?? p;
  const adjacency = new Map<string, string[]>();
  for (const f of files) {
    for (const t of importsOf(f)) {
      const a = moduleOf(f);
      const b = moduleOf(t);
      if (a === b) continue;
      adjacency.set(a, [...new Set([...(adjacency.get(a) ?? []), b])].sort());
    }
  }
  const modules = [...new Set(files.map(moduleOf))].sort();
  return placementGraph({
    files,
    importsOf,
    moduleOf,
    modules,
    moduleAdjacency: adjacency,
    packages: buildPackages(files, importsOf, (d) => repo.manifests?.[d]),
  });
}

describe("placementOf", () => {
  it("flags a copy's file that already reaches another copy", () => {
    // cart imports invoice. Putting the shared code in cart makes invoice
    // import cart, which closes a cycle. invoice is a safe home: cart already
    // imports it.
    const g = graphOf({ imports: { "src/cart.ts": ["src/invoice.ts"], "src/invoice.ts": [] } });
    const p = placementOf(["src/cart.ts", "src/invoice.ts"], g);
    expect(p.avoid).toEqual([{ file: "src/cart.ts", reason: { kind: "cycle", with: "src/invoice.ts" } }]);
  });

  it("flags a home reached through other files, and names the copy it reaches", () => {
    const g = graphOf({
      imports: { "a.ts": ["mid.ts"], "mid.ts": ["b.ts"], "b.ts": [] },
    });
    expect(placementOf(["a.ts", "b.ts"], g).avoid).toEqual([
      { file: "a.ts", reason: { kind: "cycle", with: "b.ts" } },
    ]);
  });

  it("does not flag a home already in one cycle with the copy", () => {
    // a, b and m form a ring, and b does not import a directly. Making b
    // import a adds an edge inside the ring: no cycle is created and the
    // ring does not grow.
    const g = graphOf({ imports: { "a.ts": ["b.ts"], "b.ts": ["m.ts"], "m.ts": ["a.ts"] } });
    expect(placementOf(["a.ts", "b.ts"], g).avoid).toEqual([]);
  });

  it("flags a home that would close a cycle between modules only", () => {
    // No file path runs from x2 back to y1, but module X reaches module Y
    // through x1. Making y1 import x2 adds the edge Y -> X and closes a module
    // cycle, which is what the report's tangle section counts.
    const g = graphOf({
      imports: { "x/x1.ts": ["y/y2.ts"], "x/x2.ts": [], "y/y1.ts": [], "y/y2.ts": [] },
      modules: { "x/x1.ts": "x", "x/x2.ts": "x", "y/y1.ts": "y", "y/y2.ts": "y" },
    });
    const p = placementOf(["x/x2.ts", "y/y1.ts"], g);
    expect(p.avoid).toEqual([{ file: "x/x2.ts", reason: { kind: "module-cycle", from: "y", to: "x" } }]);
  });

  it("flags a home in a package another copy's package cannot import", () => {
    const g = graphOf({
      imports: { "extensions/css/a.ts": [], "extensions/html/b.ts": [] },
      manifests: { "extensions/css": { name: "css", deps: [] }, "extensions/html": { name: "html", deps: [] } },
    });
    const p = placementOf(["extensions/css/a.ts", "extensions/html/b.ts"], g);
    expect(p.avoid).toEqual([
      { file: "extensions/css/a.ts", reason: { kind: "package", from: "extensions/html" } },
      { file: "extensions/html/b.ts", reason: { kind: "package", from: "extensions/css" } },
    ]);
    expect(p.packages).toEqual(["extensions/css", "extensions/html"]);
  });

  it("allows a home in a package every other copy's package depends on", () => {
    const g = graphOf({
      imports: { "packages/app/a.ts": [], "packages/lib/b.ts": [] },
      manifests: {
        "packages/app": { name: "app", deps: ["lib"] },
        "packages/lib": { name: "lib", deps: [] },
      },
    });
    const p = placementOf(["packages/app/a.ts", "packages/lib/b.ts"], g);
    expect(p.avoid).toEqual([{ file: "packages/app/a.ts", reason: { kind: "package", from: "packages/lib" } }]);
  });

  it("says nothing when every copy's file is a safe home", () => {
    const g = graphOf({ imports: { "a.ts": ["shared.ts"], "b.ts": ["shared.ts"], "shared.ts": [] } });
    expect(placementOf(["a.ts", "b.ts"], g).avoid).toEqual([]);
  });

  it("lists homes and the copy each reaches in code-unit order", () => {
    // ORDERING_PROBE carries both properties: case and punctuation that
    // collation reorders, and a path (`a/c.ts`) whose sorted place no
    // directory walk produces. The files form a one-way chain from the last
    // in sorted order to the first, passed in chain order. Every file except
    // the chain's end reaches the end, which sorts first, so each is flagged
    // and each names it.
    const chain: Record<string, string[]> = {};
    const reversed = [...ORDERING_PROBE].reverse();
    reversed.forEach((f, i) => (chain[f] = i + 1 < reversed.length ? [reversed[i + 1]!] : []));
    const p = placementOf([...reversed], graphOf({ imports: chain }));
    expect(p.avoid.map((a) => a.file)).toEqual(ORDERING_PROBE.slice(1));
    for (const a of p.avoid) expect(a.reason).toEqual({ kind: "cycle", with: ORDERING_PROBE[0] });
  });

  it("names the copies' deepest common directory when they share one package", () => {
    // Judged in round 3: when every copy sits in one package, a new file
    // under this directory was rated right 56 times in 56.
    const g = graphOf({
      imports: { "src/a/x/one.ts": [], "src/a/y/two.ts": [], "src/a/three.ts": [] },
    });
    expect(placementOf(["src/a/x/one.ts", "src/a/y/two.ts", "src/a/three.ts"], g).newFileDir).toBe("src/a");
  });

  it("names no directory when the copies span packages", () => {
    // A host package picked from the graph was rated right 38% of the time.
    const g = graphOf({
      imports: { "packages/app/a.ts": [], "packages/lib/b.ts": [] },
      manifests: { "packages/app": { name: "app", deps: ["lib"] }, "packages/lib": { name: "lib", deps: [] } },
    });
    expect(placementOf(["packages/app/a.ts", "packages/lib/b.ts"], g).newFileDir).toBeUndefined();
  });

  it("names no directory when the only common one is the repository root", () => {
    const g = graphOf({ imports: { "src/a.ts": [], "tools/b.ts": [] } });
    expect(placementOf(["src/a.ts", "tools/b.ts"], g).newFileDir).toBeUndefined();
  });

  it("does not stop at a directory name that is only a common prefix", () => {
    // `src/ab` and `src/ac` share the characters `src/a`, not a directory.
    const g = graphOf({ imports: { "src/ab/x.ts": [], "src/ac/y.ts": [] } });
    expect(placementOf(["src/ab/x.ts", "src/ac/y.ts"], g).newFileDir).toBe("src");
  });
});

