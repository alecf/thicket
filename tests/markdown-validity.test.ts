import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { initHash } from "../src/hash.js";
import {
  renderMarkdown,
  type ReportInput,
  type TangleEdge,
} from "../src/report/markdown.js";
import type { Ranked } from "../src/report/rank.js";

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

const GOLDEN = new URL("./golden/sample-report.md", import.meta.url);

const occurrence = (filePath: string, line: number) => ({
  filePath,
  start: line * 10,
  end: line * 10 + 200,
  line,
  endLine: line + 8,
  parentId: line,
});

const ranked = (id: string, over: Partial<Ranked> = {}): Ranked => ({
  score: 100,
  tag: "source",
  linesPerCopy: 9,
  recoverableLines: 16,
  excerpt: ["export function normalize(points: Point[]) {", "  const out = [];", "…"],
  cluster: {
    id,
    level: "L1",
    kind: "FunctionDeclaration",
    nodeCount: 20,
    mass: 40,
    occurrences: [occurrence("src/alpha.ts", 4), occurrence("src/beta.ts", 14)],
  },
  ...over,
});

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
  duplication: [ranked("THK-DUP-1")],
  testDuplication: [],
  cycles: [
    {
      id: "THK-CYC-1",
      modules: ["core", "ui"],
      edges: [
        edge("core", "ui", 4),
        edge("ui", "core", 1),
      ],
      cuts: [edge("ui", "core", 1)],
      residual: 1,
    },
  ],
  totalFindings: 2,
  census: { duplication: 1, cycles: 1, bands: [{ label: "10–29", count: 1 }], testDuplication: 0, singleFile: 0 },
};

/**
 * Splits a document into fenced-code regions and prose regions, so prose-only
 * rules are not applied to the contents of a code block.
 */
function proseLines(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const opener = /^(`{3,}|~{3,})/.exec(line);
    if (fence === undefined && opener) {
      fence = opener[1];
      continue;
    }
    if (fence !== undefined) {
      if (opener && opener[1]!.startsWith(fence[0]!) && opener[1]!.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * A closing fence must be at least as long as the one that opened it, so a
 * shorter run of backticks inside a longer fence is content rather than a
 * terminator. Counting every ``` line as a toggle would call a correctly
 * escaped block unbalanced.
 */
function fencesAreBalanced(markdown: string): boolean {
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const run = /^(`{3,})/.exec(line)?.[1];
    if (run === undefined) continue;
    if (fence === undefined) fence = run;
    else if (run.length >= fence.length) fence = undefined;
  }
  return fence === undefined;
}

describe("the report is valid markdown", () => {
  const documents: Record<string, string> = {
    "a rendered report": renderMarkdown(base),
    "the committed golden file": readFileSync(GOLDEN, "utf8"),
    "a report with a scope warning": renderMarkdown({
      ...base,
      scope: {
        analyzed: 176,
        onDisk: 6286,
        complete: false,
        gaps: [
          { dir: "apps/web", fileCount: 5262, config: "apps/web/tsconfig.json" },
          { dir: "vendored", fileCount: 848 },
        ],
      },
    }),
    "a truncated report": renderMarkdown({ ...base, totalFindings: 495 }),
  };

  for (const [name, markdown] of Object.entries(documents)) {
    describe(name, () => {
      it("indents no prose line, so nothing becomes a lazy paragraph continuation", () => {
        // The bug this replaces. Every body line used to be indented two
        // spaces, and CommonMark folds an indented line following a paragraph
        // into that paragraph: the whole Summary rendered as one run-on line,
        // and the four-space excerpt was swallowed by the paragraph above it
        // rather than becoming a code block -- an indented code block cannot
        // interrupt a paragraph.
        for (const line of proseLines(markdown)) {
          if (line.trim() === "") continue;
          expect(line, `indented prose: ${JSON.stringify(line)}`).not.toMatch(/^ /);
        }
      });

      it("separates every block construct with a blank line", () => {
        const lines = proseLines(markdown);
        for (const [i, line] of lines.entries()) {
          if (!line.startsWith("#")) continue;
          if (i > 0) expect(lines[i - 1], `before ${line}`).toBe("");
          expect(lines[i + 1], `after ${line}`).toBe("");
        }
      });

      it("closes every code fence it opens", () => {
        expect(fencesAreBalanced(markdown)).toBe(true);
      });

      it("gives every table a delimiter row under its header", () => {
        const lines = proseLines(markdown);
        for (const [i, line] of lines.entries()) {
          if (!line.startsWith("|")) continue;
          const previous = lines[i - 1] ?? "";
          const isHeader = !previous.startsWith("|");
          if (isHeader) expect(lines[i + 1]).toMatch(/^\| *-{3,} *\|/);
        }
      });
    });
  }
});

describe("code excerpts", () => {
  it("puts source in a fenced block tagged with the language", () => {
    const out = renderMarkdown(base);
    expect(out).toContain("```ts\nexport function normalize(points: Point[]) {");
  });

  it("tags the fence from the file the excerpt was taken from", () => {
    const tsx = renderMarkdown({
      ...base,
      duplication: [
        ranked("THK-DUP-tsx", {
          cluster: { ...ranked("x").cluster, occurrences: [occurrence("src/App.tsx", 4)] },
        }),
      ],
    });
    expect(tsx).toContain("```tsx\n");
  });

  it("lengthens the fence past any backtick run in the source", () => {
    // A template literal containing a fence would otherwise close the block
    // early and spill the rest of the report into the page as prose.
    const out = renderMarkdown({
      ...base,
      duplication: [
        ranked("THK-DUP-tick", { excerpt: ["const md = `", "```ts", "x", "`;"] }),
      ],
    });
    expect(out).toContain("````ts\n");
    expect(fencesAreBalanced(out)).toBe(true);
  });
});

describe("occurrence lists", () => {
  it("gives each file its own list item rather than one long paragraph", () => {
    const out = renderMarkdown(base);
    expect(out).toContain("- `src/alpha.ts:4`\n");
    expect(out).toContain("- `src/beta.ts:14`\n");
  });

  it("counts the files it withheld when a cap is configured", () => {
    const many = ranked("THK-DUP-many", {
      cluster: {
        ...ranked("x").cluster,
        occurrences: Array.from({ length: 40 }, (_, i) =>
          occurrence(`src/f${String(i).padStart(2, "0")}.ts`, i + 1),
        ),
      },
    });
    const out = renderMarkdown({ ...base, duplication: [many], maxFilesPerFinding: 6 });
    expect(out).toMatch(/^- … and 34 more files$/m);
  });
});
