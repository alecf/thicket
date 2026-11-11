/**
 * Writes `site/tour/data.js`, the data the pipeline tour animates.
 *
 * Every number on the tour page comes from this script. It runs thicket's own
 * pipeline stages on the sample project in `site/tour/sample/` and records
 * what each stage produced: the fragments, both hashes of each, the groups
 * before and after nested repeats are dropped, the near copy, the scores, the
 * import edges, and the finished report.
 *
 * Run it again after a change to the pipeline that could move any of those:
 *
 *   bun site/tour/generate.ts
 *
 * The output is committed, so building the site does not run thicket.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openProject } from "../../src/extract/ts-adapter.js";
import { clusterFragments, collectFragments, type Cluster } from "../../src/fingerprint/cluster.js";
import { extractFragments } from "../../src/fingerprint/fragments.js";
import { forEachChildSafe, safeText } from "../../src/extract/traverse.js";
import type { Node } from "../../src/extract/types.js";
import { typescript } from "../../src/lang/typescript/profile.js";
import { SKETCH_BINS, EMPTY_BIN, similarity } from "../../src/fingerprint/sketch.js";
import { subsume } from "../../src/report/rank.js";
import { runReport } from "../../src/run.js";
import { VERSION } from "../../src/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const sample = join(here, "sample");
const config = join(sample, "tsconfig.json");
const MIN_NODES = 15;
const MIN_LINES = 4;

const { markdown, json } = await runReport({ config, dir: sample, cache: false });

const project = await openProject(config, { root: sample });
try {
  const files = project.files();
  const fragments = await collectFragments(project, { minNodes: MIN_NODES, minLines: MIN_LINES });
  const raw = clusterFragments(fragments);
  const kept = subsume(raw);

  const key = (f: { filePath: string; start: number; end: number }) => `${f.filePath}:${f.start}-${f.end}`;
  const clusterOut = (c: Cluster) => ({
    id: c.id,
    level: c.level,
    kind: c.kind,
    nodeCount: c.nodeCount,
    members: c.occurrences.map(key),
  });

  // Token streams for the fragments the tour opens up. Only these two are
  // shown token by token: the original and its renamed copy.
  const featured: Record<string, { l0: string[]; l1: string[] }> = {};
  for (const file of files) {
    if (file.path !== "src/orders/total.ts" && file.path !== "src/cart/subtotal.ts") continue;
    for (const f of extractFragments(file, { minNodes: MIN_NODES, minLines: MIN_LINES })) {
      if (f.kind === "FunctionDeclaration") featured[file.path] = { l0: f.tokensL0, l1: f.tokensL1 };
    }
  }

  // The syntax tree of the original, with positions, so the page can grow
  // each node out of the text it covers. Walked the way fragments.ts walks.
  interface TreeNode {
    kind: string;
    text?: string;
    start: number;
    end: number;
    line: number;
    endLine: number;
    nodes: number;
    children: TreeNode[];
  }
  const original = files.find((f) => f.path === "src/orders/total.ts")!;
  const lineOf = (pos: number) => original.sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const toTree = (node: Node): TreeNode => {
    const children: TreeNode[] = [];
    forEachChildSafe(node, (child) => {
      children.push(toTree(child));
    });
    const start = node.getStart();
    const end = node.getEnd();
    const leafText =
      children.length === 0 && (typescript.isIdentifier(node.kind) || typescript.isLiteral(node.kind))
        ? safeText(node)
        : undefined;
    return {
      kind: typescript.kindName(node),
      ...(leafText === undefined ? {} : { text: leafText }),
      start,
      end,
      line: lineOf(start),
      endLine: lineOf(end),
      nodes: 1 + children.reduce((n, c) => n + c.nodes, 0),
      children,
    };
  };
  let tree: TreeNode | undefined;
  const findFn = (node: Node) => {
    if (tree) return;
    if (typescript.kindName(node) === "FunctionDeclaration") {
      tree = toTree(node);
      return;
    }
    forEachChildSafe(node, (child) => {
      findFn(child);
    });
  };
  findFn(original.sourceFile as unknown as Node);

  // The near copy and the copy it is compared with, bin by bin.
  const at = (path: string, kind: string) => fragments.find((f) => f.filePath === path && f.kind === kind)!;
  const nearA = at("src/orders/total.ts", "FunctionDeclaration");
  const nearB = at("src/reports/rows.ts", "FunctionDeclaration");
  const bins = (s: Uint16Array) => Array.from(s, (v) => (v === EMPTY_BIN ? -1 : v));
  const sim = similarity(nearA.sketch!, nearB.sketch!);

  const data = {
    version: VERSION,
    minNodes: MIN_NODES,
    minLines: MIN_LINES,
    sketchBins: SKETCH_BINS,
    files: files
      .map((f) => ({ path: f.path, text: readFileSync(join(sample, f.path), "utf8") }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    fragments: fragments.map((f) => ({
      key: key(f),
      file: f.filePath,
      kind: f.kind,
      nodes: f.nodeCount,
      line: f.line,
      endLine: f.endLine,
      start: f.start,
      end: f.end,
      literalShare: f.literalShare,
      l0: f.l0.slice(0, 8),
      l1: f.l1.slice(0, 8),
    })),
    rawClusters: raw.map(clusterOut),
    keptClusters: kept.map(clusterOut),
    featured,
    tree,
    near: {
      a: key(nearA),
      b: key(nearB),
      binsA: bins(nearA.sketch!),
      binsB: bins(nearB.sketch!),
      match: sim.match,
      of: sim.of,
    },
    imports: files.map((f) => ({
      file: f.path,
      targets: project.importDetailsOf(f).map((d) => ({ target: d.target, symbols: d.symbols, erased: d.erased })),
    })),
    report: { markdown, json },
  };

  writeFileSync(
    join(here, "data.js"),
    `// Generated by site/tour/generate.ts from site/tour/sample. Do not edit.\nwindow.TOUR_DATA = ${JSON.stringify(data)};\n`,
  );
  console.log(`wrote site/tour/data.js: ${fragments.length} fragments, ${raw.length} groups, ${kept.length} kept`);
} finally {
  await project.close();
}
