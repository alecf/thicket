import { beforeAll, describe, expect, it } from "vitest";
import { initHash } from "../src/hash.js";
import {
  renderMarkdown,
  type CycleFinding,
  type ReportInput,
} from "../src/report/markdown.js";

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
  cycles: [],
  totalFindings: 1,
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
  const edges = modules.map((from, i) => ({
    from,
    to: modules[(i + 1) % n]!,
    weight: i + 1,
  }));
  for (let i = 0; i < extraEdges; i++) {
    edges.push({ from: modules[0]!, to: modules[(i + 2) % n]!, weight: 99 });
  }
  return { id: "THK-CYC-ring", modules, edges, cuts: [] };
}

const twoModule: CycleFinding = {
  id: "THK-CYC-1",
  modules: ["src/gamma.ts", "src/alpha.ts"], // deliberately unsorted
  edges: [
    { from: "src/alpha.ts", to: "src/gamma.ts", weight: 3 },
    { from: "src/gamma.ts", to: "src/alpha.ts", weight: 1 },
  ],
  cuts: [{ from: "src/gamma.ts", to: "src/alpha.ts" }],
};

describe("the cycle diagram", () => {
  it("draws the whole SCC as a mermaid flowchart", () => {
    // Pinned exactly rather than probed with `toContain`: a diagram is only
    // useful if every node and every edge is where it belongs, and a
    // substring check would pass on a chart missing half its arrows.
    expect(diagram(render(twoModule))).toEqual([
      "flowchart LR",
      '  m0["src/alpha.ts"]',
      '  m1["src/gamma.ts"]',
      "  m0 -->|3| m1",
      '  m1 -. "cut · 1" .-> m0',
    ]);
  });

  it("numbers nodes by sorted module name, not by discovery order", () => {
    // Determinism (AGENTS.md §1): Tarjan hands back components in traversal
    // order, so numbering as-received would let two runs over the same tree
    // emit different-but-equivalent charts.
    const reversed = { ...twoModule, modules: [...twoModule.modules].reverse() };
    expect(diagram(render(reversed))).toEqual(diagram(render(twoModule)));
  });

  it("marks the suggested cut and nothing else", () => {
    const dotted = diagram(render(twoModule)).filter((l) => l.includes("-."));
    expect(dotted).toEqual(['  m1 -. "cut · 1" .-> m0']);
  });

  it("draws every edge solid when no cut was found", () => {
    const uncut = { ...twoModule, cuts: [] };
    expect(diagram(render(uncut))).toEqual([
      "flowchart LR",
      '  m0["src/alpha.ts"]',
      '  m1["src/gamma.ts"]',
      "  m0 -->|3| m1",
      "  m1 -->|1| m0",
    ]);
  });

  it("quotes node labels so a path is never parsed as mermaid syntax", () => {
    const odd: CycleFinding = {
      id: "THK-CYC-odd",
      modules: ['weird"name', "packages/ui-(v2)"],
      edges: [
        { from: 'weird"name', to: "packages/ui-(v2)", weight: 1 },
        { from: "packages/ui-(v2)", to: 'weird"name', weight: 1 },
      ],
      cuts: [],
    };
    const nodes = diagram(render(odd)).filter((l) => l.includes("["));
    expect(nodes).toEqual(['  m0["packages/ui-(v2)"]', '  m1["weird#quot;name"]']);
  });

  it("still names the suggested cut in prose beside the chart", () => {
    // The chart is for reading; the cut is for acting on. A harness that does
    // not parse mermaid must still be able to find the edge to delete.
    expect(render(twoModule)).toContain(
      "- **suggested cuts (1):** `src/gamma.ts` → `src/alpha.ts`",
    );
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
    expect(drawn.filter((l) => l.includes("["))).toHaveLength(20);
    expect(drawn.filter((l) => l.includes("-->"))).toHaveLength(20);
  });
});
