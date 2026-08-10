import { beforeAll, describe, expect, it } from "vitest";
import { initHash } from "../src/hash.js";
import {
  renderMarkdown,
  type CycleFinding,
  type ReportInput,
  type TangleEdge,
} from "../src/report/markdown.js";

/**
 * A tangle edge. `files` defaults to one synthetic importer, because the
 * report prints file counts and a zero-length list would make every edge look
 * free to cut.
 */
const edge = (from: string, to: string, weight: number, over: Partial<TangleEdge> = {}): TangleEdge => ({
  from,
  to,
  weight,
  files: [`${from}/importer.ts`],
  typeOnly: false,
  ...over,
});

beforeAll(async () => {
  await initHash();
});

/**
 * The chart syntax these tests pin was checked against mermaid's own parser
 * (`mermaid.parse`, 11.16.1) on the fixture chart, the golden report and a
 * 12-module chart from a real repository. mermaid is not a devDependency here
 * — it and jsdom are 177 MB and 100 packages against a CLI whose only runtime
 * dependency is `typescript` — so these assertions pin exact strings instead:
 * any future edit to the syntax surfaces as a diff a human has to approve
 * rather than as a chart that silently fails to render.
 */

const base: ReportInput = {
  version: "0.1.0",
  configHash: "abc123",
  fileCount: 4,
  lineCount: 60,
  granularity: "dir:1",
  moduleCount: 2,
  metrics: {
    duplicatedMass: 100,
    redundantByteFraction: 0.05,
    propagationCost: 0.5,
    cycleCount: 1,
    largestScc: 2,
  },
  scope: { analyzed: 4, onDisk: 4, complete: true, gaps: [] },
  duplication: [],
  testDuplication: [],
  cycles: [],
  totalFindings: 1,
  census: { duplication: 0, cycles: 1, bands: [], testDuplication: 0, singleFile: 0 },
};

/** The mermaid source of the first diagram in a report, fence excluded. */
function diagram(markdown: string): string[] {
  const lines = markdown.split("\n");
  const open = lines.findIndex((l) => /^`{3,}mermaid$/.test(l));
  if (open === -1) return [];
  const close = lines.findIndex((l, i) => i > open && /^`{3,}$/.test(l));
  return lines.slice(open + 1, close);
}

function render(cycle: CycleFinding): string {
  return renderMarkdown({ ...base, cycles: [cycle] });
}

/** A ring of `n` modules, each importing the next, plus one chord. */
function ring(n: number, extraEdges = 0): CycleFinding {
  const modules = Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, "0")}`);
  const edges = modules.map((from, i) => edge(from, modules[(i + 1) % n]!, i + 1));
  for (let i = 0; i < extraEdges; i++) {
    edges.push(edge(modules[0]!, modules[(i + 2) % n]!, 99));
  }
  return { id: "THK-CYC-ring", modules, edges, cuts: [], residual: n };
}

const twoModule: CycleFinding = {
  id: "THK-CYC-1",
  modules: ["src/gamma.ts", "src/alpha.ts"], // deliberately unsorted
  edges: [
    edge("src/alpha.ts", "src/gamma.ts", 3),
    edge("src/gamma.ts", "src/alpha.ts", 1),
  ],
  cuts: [edge("src/gamma.ts", "src/alpha.ts", 1)],
  residual: 1,
};

describe("the cycle diagram", () => {
  it("draws the whole SCC as a mermaid flowchart named by module path", () => {
    // Pinned exactly rather than probed with `toContain`: a diagram is only
    // useful if every node and every edge is where it belongs, and a
    // substring check would pass on a chart missing half its arrows.
    expect(diagram(render(twoModule))).toEqual([
      "flowchart LR",
      "  src/alpha.ts -->|3| src/gamma.ts",
      '  src/gamma.ts -. "cut · 1" .-> src/alpha.ts',
    ]);
  });

  it("orders edges by module name, not by discovery order", () => {
    // Determinism (AGENTS.md §1): Tarjan hands back components in traversal
    // order, so emitting as-received would let two runs over the same tree
    // produce different-but-equivalent charts.
    const reversed = {
      ...twoModule,
      modules: [...twoModule.modules].reverse(),
      edges: [...twoModule.edges].reverse(),
    };
    expect(diagram(render(reversed))).toEqual(diagram(render(twoModule)));
  });

  it("marks the suggested cut and nothing else", () => {
    const dotted = diagram(render(twoModule)).filter((l) => l.includes("-."));
    expect(dotted).toEqual(['  src/gamma.ts -. "cut · 1" .-> src/alpha.ts']);
  });

  it("draws every edge solid when no cut was found", () => {
    const uncut = { ...twoModule, cuts: [] };
    expect(diagram(render(uncut))).toEqual([
      "flowchart LR",
      "  src/alpha.ts -->|3| src/gamma.ts",
      "  src/gamma.ts -->|1| src/alpha.ts",
    ]);
  });

  it("falls back to slugged ids when a name is not a legal mermaid id", () => {
    // `app/[id]` is a Next.js dynamic route, not a contrived name: at file
    // granularity a bare `[` opens a node label and wrecks the chart.
    const odd: CycleFinding = {
      id: "THK-CYC-odd",
      modules: ["app/[id]/page.tsx", "lib/util.ts"],
      edges: [
        edge("app/[id]/page.tsx", "lib/util.ts", 2),
        edge("lib/util.ts", "app/[id]/page.tsx", 1),
      ],
      cuts: [],
      residual: 1,
    };
    expect(diagram(render(odd))).toEqual([
      "flowchart LR",
      '  app/_id_/page.tsx["app/[id]/page.tsx"]',
      '  lib/util.ts["lib/util.ts"]',
      "  app/_id_/page.tsx -->|2| lib/util.ts",
      "  lib/util.ts -->|1| app/_id_/page.tsx",
    ]);
  });

  it("puts the whole chart on slugs when any one name is unsafe", () => {
    // Naming some nodes by path and others by slug would read as though the
    // two kinds of node were different kinds of thing.
    const mixed: CycleFinding = {
      id: "THK-CYC-mixed",
      modules: ["a b", "clean/path", "other"],
      edges: [
        edge("a b", "clean/path", 1),
        edge("clean/path", "other", 1),
        edge("other", "a b", 1),
      ],
      cuts: [],
      residual: 1,
    };
    const nodes = diagram(render(mixed)).filter((l) => l.includes("["));
    expect(nodes).toEqual([
      '  a_b["a b"]',
      '  clean/path["clean/path"]',
      '  other["other"]',
    ]);
  });

  it("escapes a quote in a label rather than ending it early", () => {
    const quoted: CycleFinding = {
      id: "THK-CYC-quote",
      modules: ['weird"name', "plain"],
      edges: [
        edge('weird"name', "plain", 1),
        edge("plain", 'weird"name', 1),
      ],
      cuts: [],
      residual: 1,
    };
    expect(diagram(render(quoted))).toContain('  weird_name["weird#quot;name"]');
  });

  it("never lets two modules collapse onto one node id", () => {
    // `a:b` and `a?b` both slug to `a_b`. Sharing an id would merge two nodes
    // into one and turn a two-module cycle into a self-loop.
    const collide: CycleFinding = {
      id: "THK-CYC-collide",
      modules: ["a:b", "a?b"],
      edges: [
        edge("a:b", "a?b", 1),
        edge("a?b", "a:b", 1),
      ],
      cuts: [],
      residual: 1,
    };
    const drawn = diagram(render(collide));
    expect(drawn).toEqual([
      "flowchart LR",
      '  a_b["a:b"]',
      '  a_b_2["a?b"]',
      "  a_b -->|1| a_b_2",
      "  a_b_2 -->|1| a_b",
    ]);
  });

  it("slugs a module whose name is a mermaid keyword", () => {
    // A directory really can be called `end`, and `end` closes a subgraph.
    const keyword: CycleFinding = {
      id: "THK-CYC-kw",
      modules: ["end", "start"],
      edges: [
        edge("end", "start", 1),
        edge("start", "end", 1),
      ],
      cuts: [],
      residual: 1,
    };
    expect(diagram(render(keyword))).toContain('  _end["end"]');
  });

  it("still names the suggested cut in prose beside the chart", () => {
    // The chart is for reading; the cut is for acting on. A harness that does
    // not parse mermaid must still be able to find the edge to delete.
    expect(render(twoModule)).toContain("- **suggested cut:** `src/gamma.ts` → `src/alpha.ts`");
  });

  it("names the file a small cut lives in", () => {
    // A one-symbol edge is one line of one file. Printing that line is the
    // entire difference between acting on the suggestion and going to grep
    // for it; on a real report the cut was a single import and the report
    // never said where.
    expect(render(twoModule)).toContain(
      "- **suggested cut:** `src/gamma.ts` → `src/alpha.ts` — 1 symbol in" +
        " `src/gamma.ts/importer.ts`",
    );
  });

  it("counts the files of a cut too large to name them", () => {
    const wide: CycleFinding = {
      ...twoModule,
      cuts: [
        edge("src/gamma.ts", "src/alpha.ts", 30, {
          files: Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`),
        }),
      ],
    };
    expect(render(wide)).toContain(
      "- **suggested cut:** `src/gamma.ts` → `src/alpha.ts` — 30 symbols across 9 files",
    );
  });

  it("says what the cut leaves behind", () => {
    // "suggested cuts (1)" with nothing after it reads as "apply this and the
    // tangle is gone". On a real 7-module tangle the suggested cut detached
    // one leaf and left the other six knotted, and the report did not say so.
    const partial: CycleFinding = {
      ...twoModule,
      modules: ["a", "b", "c", "d", "e", "f", "g"],
      residual: 6,
    };
    expect(render(partial)).toContain(
      "- **leaves:** 6 of 7 modules still mutually dependent.",
    );
  });

  it("says plainly when a cut finishes the job", () => {
    expect(render(twoModule)).toContain("- **leaves:** nothing — this breaks the cycle completely.");
  });

  it("says so when no single edge breaks the cycle", () => {
    const stuck: CycleFinding = { ...twoModule, cuts: [], residual: 2 };
    const out = render(stuck);
    expect(out).toContain("- **no single edge breaks this cycle**");
    expect(out).not.toContain("**suggested cut:**");
    expect(out).not.toContain("**leaves:**");
  });

  it("marks a type-only edge in the chart", () => {
    // Such an edge has no runtime existence at all, so a cycle built from
    // them is a filing problem rather than an initialization hazard.
    const erased: CycleFinding = {
      ...twoModule,
      edges: [
        edge("src/alpha.ts", "src/gamma.ts", 3, { typeOnly: true }),
        edge("src/gamma.ts", "src/alpha.ts", 1),
      ],
      cuts: [],
    };
    expect(diagram(render(erased))).toEqual([
      "flowchart LR",
      "  src/alpha.ts -->|3 type| src/gamma.ts",
      "  src/gamma.ts -->|1| src/alpha.ts",
    ]);
  });

  it("explains what the arrow numbers mean, once per section", () => {
    // The charts carried an unlabelled number on every arrow and no legend
    // anywhere in a 2,600-line report. It is neither imports nor files, and
    // the difference between 12 symbols and the 7 files you would edit is
    // most of the estimate.
    const out = renderMarkdown({ ...base, cycles: [twoModule, { ...twoModule, id: "THK-CYC-2" }] });
    expect(out).toContain("Arrows run importer → imported.");
    expect(out).toContain("distinct symbols bound across the edge");
    expect(out).toContain("`type` marks one that is erased at compile time");
    // Once, not once per finding.
    expect(out.split("Arrows run importer").length - 1).toBe(1);
  });

  it("omits the chart rather than truncating it when the SCC is too large", () => {
    // A flowchart missing arrows is worse than no flowchart: the subgraph it
    // shows may not be cyclic at all, and a reader has no way to tell.
    const huge = ring(40);
    const out = render(huge);
    expect(diagram(out)).toEqual([]);
    expect(out).toContain("- **members (40):**");
    expect(out).toContain("`m00`");
    expect(out).toContain("**chart omitted:** 40 modules, 40 edges");
  });

  it("omits the chart when the SCC is small but densely connected", () => {
    const dense = ring(12, 120);
    expect(diagram(render(dense))).toEqual([]);
    expect(render(dense)).toContain("**chart omitted:** 12 modules, 132 edges");
  });

  it("draws a chart at the largest size it accepts", () => {
    // Guards the cap from silently drifting down to "never draws anything".
    const drawn = diagram(render(ring(20)));
    expect(drawn.filter((l) => l.includes("-->"))).toHaveLength(20);
    // Every module reachable in the chart, none dropped at the boundary.
    const named = new Set(drawn.flatMap((l) => l.match(/m\d\d/g) ?? []));
    expect(named.size).toBe(20);
  });
});
