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
  erased: 0,
  topTarget: { path: `${to}/index.ts`, weight },
  passThrough: 0,
  typeOnly: false,
  ...over,
});

beforeAll(async () => {
  await initHash();
});

/**
 * The chart syntax these tests pin was checked against mermaid's own parser
 * (`mermaid.parse`, 11.16.1) on the fixture chart, the golden report and both
 * charts of a real 5,798-file repository. mermaid is not a devDependency here
 * — it and jsdom are 177 MB and 100 packages against a CLI whose only runtime
 * dependency is `typescript` — so these assertions pin exact strings instead.
 *
 * That was not enough on its own, and the gap is worth stating. When the edge
 * label gained a parenthesised count (`59 (4 type)`), the pinned strings were
 * updated to match the new output and every test passed — while the chart no
 * longer parsed, because an unquoted mermaid edge label ends at `(`. A string
 * pin agrees with whatever the code currently emits, which is exactly the
 * property you do not want from a syntax guard.
 *
 * So `describe("the chart parses")` asserts the INVARIANT the parser cares
 * about — every label is quoted, and no label contains a raw `"` — rather than
 * the bytes. That holds for labels nobody has thought of yet.
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
      "  src/alpha.ts -->|\"3\"| src/gamma.ts",
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
      "  src/alpha.ts -->|\"3\"| src/gamma.ts",
      "  src/gamma.ts -->|\"1\"| src/alpha.ts",
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
      "  app/_id_/page.tsx -->|\"2\"| lib/util.ts",
      "  lib/util.ts -->|\"1\"| app/_id_/page.tsx",
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
      "  a_b -->|\"1\"| a_b_2",
      "  a_b_2 -->|\"1\"| a_b",
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
      "  src/alpha.ts -->|\"3 type\"| src/gamma.ts",
      "  src/gamma.ts -->|\"1\"| src/alpha.ts",
    ]);
  });

  it("lifts a shared prefix out of the node names and into the heading", () => {
    // Every node in a real 7-module chart began `apps/mobile/`, seven times
    // over, on 26 edges. It is the one part of the name that distinguishes
    // nothing, and it crowded the part that does.
    const prefixed: CycleFinding = {
      id: "THK-CYC-p",
      modules: ["apps/mobile/lib", "apps/mobile/utils", "apps/mobile/hooks"],
      edges: [
        edge("apps/mobile/lib", "apps/mobile/utils", 28),
        edge("apps/mobile/utils", "apps/mobile/hooks", 3),
        edge("apps/mobile/hooks", "apps/mobile/lib", 127),
      ],
      cuts: [edge("apps/mobile/utils", "apps/mobile/hooks", 3)],
      residual: 2,
    };
    const out = render(prefixed);
    expect(out).toContain("### THK-CYC-p · SCC of 3 modules under `apps/mobile/`");
    expect(diagram(out)).toEqual([
      "flowchart LR",
      "  hooks -->|\"127\"| lib",
      "  lib -->|\"28\"| utils",
      '  utils -. "cut · 3" .-> hooks',
    ]);
    // The cut names modules, so it is relative too, and the heading says so.
    expect(out).toContain("- **suggested cut:** `utils` → `hooks`");
  });

  it("does not strip a prefix that is only part of a path segment", () => {
    // `packages/core/mobile` and `packages/core/mobile-web` share the STRING
    // `packages/core/mobile` and share the DIRECTORY `packages/core`.
    // Stripping the string would produce a node named `-web/lib`.
    const sibling: CycleFinding = {
      id: "THK-CYC-s",
      modules: ["packages/core/mobile/lib", "packages/core/mobile-web/lib"],
      edges: [
        edge("packages/core/mobile/lib", "packages/core/mobile-web/lib", 1),
        edge("packages/core/mobile-web/lib", "packages/core/mobile/lib", 1),
      ],
      cuts: [],
      residual: 2,
    };
    const out = render(sibling);
    expect(out).toContain("under `packages/core/`");
    expect(diagram(out)).toEqual([
      "flowchart LR",
      "  mobile-web/lib -->|\"1\"| mobile/lib",
      "  mobile/lib -->|\"1\"| mobile-web/lib",
    ]);
  });

  it("leaves a single shared directory in place", () => {
    // `src/` is the source root: four characters, and it tells the reader
    // where they are. Lifting it churns every node name to save nothing.
    const out = render(twoModule);
    expect(out).toContain("### THK-CYC-1 · SCC of 2 modules\n");
    expect(diagram(out)).toContain("  src/alpha.ts -->|\"3\"| src/gamma.ts");
  });

  it("says when nothing in the tangle is circular at file level", () => {
    // The fact that reversed an agent's whole recommendation, and it had to
    // write a Tarjan implementation to learn it. A 7-module SCC over 417 files
    // had three file cycles, all inside single directories, none crossing a
    // boundary the finding drew -- so the suggested cut removed zero real
    // cycles and the tangle was layering drift, not an initialization hazard.
    const out = render({
      ...twoModule,
      fileCycles: {
        crossing: { count: 0, largest: 0, example: [] },
        within: { count: 3, largest: 3, example: ["src/lib/a.ts", "src/lib/b.ts"] },
      },
    });
    expect(out).toContain("- **file cycles:** none cross these modules");
    expect(out).toContain("the SCC is a product of grouping files into directories");
    expect(out).toContain("3 cycles exist inside individual modules (largest 3 files, including");
    // Two named of a three-file cycle: a sample, not a ring, so no ↔.
    expect(out).toContain("including `src/lib/a.ts`, `src/lib/b.ts`");
    expect(out).not.toContain("↔");
  });

  it("says how many file cycles cross the modules when some do", () => {
    const out = render({
      ...twoModule,
      fileCycles: {
        crossing: { count: 12, largest: 5, example: ["src/a.ts", "src/b.ts"] },
        within: { count: 0, largest: 0, example: [] },
      },
    });
    expect(out).toContain("- **file cycles:** 12 cross these modules (largest 5 files, including `src/a.ts`, `src/b.ts`).");
    // Verb agreement, checked because the common real case is a count of one.
    expect(render({
      ...twoModule,
      fileCycles: {
        crossing: { count: 1, largest: 2, example: ["src/a.ts"] },
        within: { count: 0, largest: 0, example: [] },
      },
    })).toContain("1 crosses these modules");
    // The reassuring sentence must not appear when the answer is the opposite.
    expect(out).not.toContain("none cross these modules");
  });

  it("says nothing about file cycles when none were computed", () => {
    expect(render(twoModule)).not.toContain("file cycles");
  });

  it("says how much of a mixed edge is erased", () => {
    // All-or-nothing marking hid the cheapest fixes. On a real 7-module tangle
    // an edge rendered as a bare `5` was four `import type` bindings plus one
    // runtime import in a single file -- move that file and the edge erases
    // entirely. The bare number sends the reader to grep five files.
    const mixed: CycleFinding = {
      ...twoModule,
      edges: [
        edge("src/alpha.ts", "src/gamma.ts", 5, { erased: 4 }),
        // Nothing erased stays bare: a parenthetical `(0 type)` on every
        // ordinary edge is noise on the majority to annotate the minority.
        edge("src/gamma.ts", "src/alpha.ts", 1),
      ],
      cuts: [],
    };
    expect(diagram(render(mixed))).toEqual([
      "flowchart LR",
      "  src/alpha.ts -->|\"5 (4 type)\"| src/gamma.ts",
      "  src/gamma.ts -->|\"1\"| src/alpha.ts",
    ]);
  });

  it("explains what the arrow numbers mean, once per section", () => {
    // The charts carried an unlabelled number on every arrow and no legend
    // anywhere in a 2,600-line report. It is neither imports nor files, and
    // the difference between 12 symbols and the 7 files you would edit is
    // most of the estimate.
    const out = renderMarkdown({ ...base, cycles: [twoModule, { ...twoModule, id: "THK-CYC-2" }] });
    expect(out).toContain("Arrows run importer → imported.");
    // Named for what it counts. "distinct symbols" was wrong: the same symbol
    // imported in eight files counts eight times, and `export … from`
    // re-exports count too. An agent computed distinct names, mismatched on
    // every edge, and concluded the tool was broken before working out the
    // real metric.
    expect(out).toContain("import sites");
    expect(out).not.toContain("distinct symbols");
    expect(out).toContain("`type` marks an edge erased at compile time");
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

describe("the chart parses", () => {
  /**
   * Characters that end a mermaid edge label early when it is not quoted.
   *
   * Measured against mermaid 11.16.1 rather than guessed: an unquoted label
   * fails the parse on any of these, and a quoted one survives every one of
   * them, failing only on a raw `"` -- which `#quot;` handles.
   */
  const BREAKS_A_BARE_LABEL = /[()[\]{}|"]/;

  /** Every `A -->|label| B` and `A -. "label" .-> B` in a rendered chart. */
  function labels(markdown: string): { text: string; quoted: boolean }[] {
    const out: { text: string; quoted: boolean }[] = [];
    for (const line of markdown.split("\n")) {
      const piped = /-->\|(.*?)\|/.exec(line);
      if (piped) {
        const raw = piped[1]!;
        const quoted = raw.startsWith('"') && raw.endsWith('"');
        out.push({ text: quoted ? raw.slice(1, -1) : raw, quoted });
      }
      const dotted = /-\.\s*"(.*?)"\s*\.->/.exec(line);
      if (dotted) out.push({ text: dotted[1]!, quoted: true });
    }
    return out;
  }

  it("quotes every edge label, whatever it contains", () => {
    // The invariant, rather than another pinned string. `59 (4 type)` shipped
    // broken because the label form gained parentheses and the tests pinned
    // the new string without anything re-checking it against a parser: a
    // string pin agrees with whatever the code now emits, which is exactly the
    // property you do not want here.
    const charts = [
      render({ ...twoModule, modules: ["a", "b"], edges: [edge("a", "b", 59, { erased: 4 }), edge("b", "a", 1)], cuts: [] }),
      render({ ...twoModule, modules: ["a", "b"], edges: [edge("a", "b", 12, { erased: 12, typeOnly: true }), edge("b", "a", 1)], cuts: [] }),
      render(twoModule),
    ];
    let seen = 0;
    for (const chart of charts) {
      const found = labels(chart);
      expect(found.length).toBeGreaterThan(0);
      for (const { text, quoted } of found) {
        seen += 1;
        expect(quoted).toBe(true);
        // Quoted survives everything except a raw quote.
        expect(text).not.toContain('"');
      }
    }
    // The loop must not be vacuous: 3 charts, 2 edges each.
    expect(seen).toBe(6);
  });

  it("emits the mixed-edge label in a form that parses", () => {
    // The exact string that broke: unquoted, the parentheses end the label.
    const out = render({
      ...twoModule,
      modules: ["a", "b"],
      edges: [edge("a", "b", 59, { erased: 4 }), edge("b", "a", 1)],
      cuts: [],
    });
    expect(out).toContain('a -->|"59 (4 type)"| b');
    expect(out).not.toContain("-->|59 (4 type)|");
  });

  it("would reject a label carrying a bare-label breaker unquoted", () => {
    // Guards the guard: if the renderer ever stops quoting, this is the
    // property that fails rather than a string comparison that adapts.
    expect(BREAKS_A_BARE_LABEL.test("59 (4 type)")).toBe(true);
    expect(BREAKS_A_BARE_LABEL.test("12 type")).toBe(false);
  });
});

describe("dissolving an edge rather than cutting it", () => {
  const routing = (over: Partial<TangleEdge> = {}): TangleEdge => ({
    ...edge("actions", "app", 45),
    topTarget: { path: "apps/web/app/api/errors.ts", weight: 45 },
    passThrough: 45,
    origin: "apps/web/lib/errors.ts",
    ...over,
  });

  it("names what to repoint the specifier at", () => {
    const out = render({ ...twoModule, dissolves: [routing()], cuts: [] });
    expect(out).toContain(
      "- **dissolve `actions` → `app`:** all 45 imports pass through" +
        " `apps/web/app/api/errors.ts` to `apps/web/lib/errors.ts`.",
    );
  });

  it("says how much of a partly-routing edge passes through", () => {
    const out = render({ ...twoModule, dissolves: [routing({ weight: 81, passThrough: 72 })], cuts: [] });
    expect(out).toContain("72 of 81 imports pass through");
  });

  it("puts dissolves above the cut, because one is free and the other is a decision", () => {
    const out = render({ ...twoModule, dissolves: [routing()] });
    expect(out.indexOf("**dissolve")).toBeLessThan(out.indexOf("**suggested cut"));
  });

  it("attributes the residual to everything listed, not to the cut alone", () => {
    const withDissolve = render({ ...twoModule, dissolves: [routing()], residual: 4 });
    expect(withDissolve).toContain("- **leaves:** after all of the above 4 of 2 modules");
    // ...and says nothing of the sort when the cut is the only fix offered.
    expect(render({ ...twoModule, residual: 4 })).toContain("- **leaves:** 4 of 2 modules");
  });

  it("agrees with itself on one further edge and several", () => {
    const five = Array.from({ length: 5 }, (_, i) => routing({ from: `m${i}` }));
    expect(render({ ...twoModule, dissolves: five, cuts: [] })).toContain(
      "and 1 further edge that dissolves the same way",
    );
    expect(render({ ...twoModule, dissolves: [...five, routing({ from: "m9" })], cuts: [] })).toContain(
      "and 2 further edges that dissolve the same way",
    );
  });
});

describe("what the report proposes doing about a tangle", () => {
  const withCycles = (crossing: number): CycleFinding["fileCycles"] => ({
    crossing: { count: crossing, largest: crossing > 0 ? 3 : 0, example: [] },
    within: { count: 0, largest: 0, example: [] },
  });

  it("proposes nothing when no file-level cycle crosses the modules", () => {
    // A cut cannot remove a cycle that does not exist. Printing one two lines
    // under "nothing here is circular at runtime" invites an agent to spend a
    // morning on a change that alters nothing that runs -- which is what
    // happened on a real 7-module tangle.
    const out = render({ ...twoModule, cuts: [], fileCycles: withCycles(0) });
    expect(out).toContain("none cross these modules");
    expect(out).not.toContain("- **suggested cut:**");
    expect(out).not.toContain("no single edge breaks");
  });

  it("still says so when a real cycle exists and no single edge breaks it", () => {
    const out = render({ ...twoModule, cuts: [], fileCycles: withCycles(4) });
    expect(out).toContain("- **no single edge breaks this cycle**");
    expect(out).toContain("whichever runtime edge you remove");
  });
});
