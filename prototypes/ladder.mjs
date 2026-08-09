// Q3: how much duplication crosses package boundaries?
// Q4: what is the MARGINAL yield of each normalization level?
//     (if L3 near-miss adds a lot over L0-L2, the ladder works; that also tells
//      us how much room is left for L4 embeddings)
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import { createHash } from "node:crypto";
import { relative, dirname, join } from "node:path";
import { existsSync } from "node:fs";

const MIN_NODES = 15;
const IGNORED = new Set(["ImportDeclaration","ImportClause","NamedImports","ImportSpecifier","ExportDeclaration","ExportSpecifier","NamedExports"]);
const K = 5, PERMS = 128, BANDS = 32, ROWS = 4, JACCARD = 0.7;

const cwd = process.cwd();
const api = new API({ cwd });
const snap = api.updateSnapshot({ openProjects: process.argv.slice(2) });

const pkgOf = (file) => {
  let d = dirname(file);
  while (d.startsWith(cwd) && d.length >= cwd.length) {
    if (existsSync(join(d, "package.json"))) return relative(cwd, d) || ".";
    d = dirname(d);
  }
  return ".";
};

const seen = new Set();
const files = [];
for (const p of snap.getProjects()) {
  for (const name of p.program.getSourceFileNames()) {
    if (name.includes("node_modules") || name.endsWith(".d.ts")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    files.push({ name, sf: p.program.getSourceFile(name), pkg: pkgOf(name) });
  }
}

const h = (s) => createHash("sha256").update(s).digest("base64url").slice(0, 16);

// Extract fragments at three normalization levels simultaneously.
const frags = [];
const t0 = performance.now();
// alpha-renaming must be FRAGMENT-LOCAL: renumber identifiers by order of first
// appearance within the fragment itself. Scoping this per-file makes L1 fail to
// generalize L0 (identical fragments get different indices depending on what
// preceded them in their file).
const alphaLocal = (tokens) => {
  const map = new Map();
  return tokens.map((t) => {
    if (!t.startsWith("Id:")) return t;
    const name = t.slice(3);
    if (!map.has(name)) map.set(name, map.size);
    return "Id#" + map.get(name);
  });
};

for (const f of files) {
  const rel = relative(cwd, f.name);
  const walk = (n) => {
    const kind = SyntaxKind[n.kind];
    let size = 1;
    const l0 = [], l1 = [], l2 = [];
    l0.push(kind); l1.push(kind); l2.push(kind);
    n.forEachChild((c) => {
      const r = walk(c);
      size += r.size;
      l0.push("(", ...r.l0, ")"); l1.push("(", ...r.l1, ")"); l2.push("(", ...r.l2, ")");
    });
    if (n.forEachChild.length !== undefined && size === 1) {
      // leaf: differentiate the three levels
      const text = (() => { try { return n.getText(); } catch { return ""; } })();
      if (kind === "Identifier") {
        l0[0] = "Id:" + text;
        l1[0] = "Id:" + text; // renumbered fragment-locally at emit time
        l2[0] = "Id";
      } else if (kind.endsWith("Literal") || kind === "StringLiteral" || kind === "NumericLiteral") {
        l0[0] = kind + ":" + text;
        l1[0] = kind;
        l2[0] = "Lit";
      }
    }
    if (size >= MIN_NODES && !IGNORED.has(kind)) {
      frags.push({
        rel, pkg: f.pkg, kind, size,
        start: n.getStart(), end: n.getEnd(),
        h0: h(l0.join(" ")), h1: h(alphaLocal(l1).join(" ")), h2: h(l2.join(" ")),
        tokens: l2,
      });
    }
    return { size, l0, l1, l2 };
  };
  f.sf.forEachChild((c) => { walk(c); });
}
console.log("extracted " + frags.length + " fragments (>=" + MIN_NODES + " nodes) in " + (performance.now() - t0).toFixed(0) + "ms\n");

const cluster = (key) => {
  const g = new Map();
  for (const f of frags) { const k = f[key]; let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(f); }
  return [...g.values()].filter((a) => a.length > 1);
};

const stat = (label, groups) => {
  let mass = 0, cross = 0, crossMass = 0;
  for (const g of groups) {
    const m = g[0].size * (g.length - 1);
    mass += m;
    if (new Set(g.map((x) => x.pkg)).size > 1) { cross++; crossMass += m; }
  }
  console.log("  " + label.padEnd(26) + String(groups.length).padStart(7) + " clusters  " +
    String(mass).padStart(8) + " mass   cross-pkg: " + String(cross).padStart(4) +
    " (" + String(mass ? (crossMass / mass * 100).toFixed(0) : 0).padStart(3) + "% of mass)");
  return groups;
};

console.log("Q4 - yield by normalization level:");
const g0 = stat("L0 exact (with names)", cluster("h0"));
const g1 = stat("L1 alpha-renamed", cluster("h1"));
const g2 = stat("L2 structural", cluster("h2"));

// --- L3: MinHash + LSH over L2 token shingles, one rep per distinct L2 hash ---
const reps = new Map();
for (const f of frags) if (!reps.has(f.h2)) reps.set(f.h2, f);
const repList = [...reps.values()];

const seeds = Array.from({ length: PERMS }, (_, i) => (i * 2654435761) >>> 0);
const sig = (tokens) => {
  const sh = new Set();
  for (let i = 0; i + K <= tokens.length; i++) sh.add(tokens.slice(i, i + K).join(" "));
  const arr = [...sh].map((s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x; });
  const out = new Int32Array(PERMS).fill(2147483647);
  for (const a of arr) for (let p = 0; p < PERMS; p++) { const v = (a ^ seeds[p]) >>> 0; if (v < out[p]) out[p] = v; }
  return { out, sh };
};

const t1 = performance.now();
for (const r of repList) { const s = sig(r.tokens); r.sig = s.out; r.sh = s.sh; }
const buckets = new Map();
for (let i = 0; i < repList.length; i++) {
  for (let b = 0; b < BANDS; b++) {
    const key = b + ":" + Array.from(repList[i].sig.slice(b * ROWS, b * ROWS + ROWS)).join(",");
    let a = buckets.get(key); if (!a) buckets.set(key, (a = [])); a.push(i);
  }
}
const pairs = new Set();
for (const a of buckets.values()) {
  if (a.length < 2 || a.length > 40) continue;
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) pairs.add(a[i] + "," + a[j]);
}
const parent = repList.map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
// A fragment and its own ancestor overlap almost perfectly and are NOT
// duplication -- they are the same code at two granularities. Exact hashing is
// immune (parent and child never share a hash) but fuzzy matching must exclude
// them explicitly, or every large block matches its own parent at ~0.99.
const nested = (a, b) =>
  a.rel === b.rel && a.start <= b.start && a.end >= b.end ||
  b.rel === a.rel && b.start <= a.start && b.end >= a.end;

let realPairs = 0, nestedSkipped = 0;
for (const p of [...pairs].sort()) {
  const [i, j] = p.split(",").map(Number);
  if (nested(repList[i], repList[j])) { nestedSkipped++; continue; }
  const A = repList[i].sh, B = repList[j].sh;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  const jac = inter / (A.size + B.size - inter);
  if (jac >= JACCARD) { realPairs++; const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
}
const l3 = new Map();
for (let i = 0; i < repList.length; i++) { const r = find(i); let a = l3.get(r); if (!a) l3.set(r, (a = [])); a.push(repList[i]); }
const l3groups = [...l3.values()].filter((a) => a.length > 1);
const t1ms = performance.now() - t1;

console.log("  " + "L3 near-miss (MinHash)".padEnd(26) + String(l3groups.length).padStart(7) + " clusters  " +
  "        (links " + l3groups.reduce((s, g) => s + g.length, 0) + " distinct L2 shapes, " + realPairs + " pairs >= " + JACCARD + " Jaccard, " + nestedSkipped + " nested pairs excluded)");
console.log("    LSH over " + repList.length + " distinct shapes in " + t1ms.toFixed(0) + "ms, " + pairs.size + " candidate pairs\n");

console.log("Q3 - packages: " + [...new Set(files.map((f) => f.pkg))].join(", "));
console.log("\nsample L3 near-miss clusters (NOT caught by exact structural hashing):");
let shown = 0;
for (const g of l3groups.sort((a, b) => b[0].size - a[0].size)) {
  if (shown++ >= 5) break;
  console.log("  " + g[0].kind + " ~" + g[0].size + " nodes, " + g.length + " variant shapes:");
  for (const o of g.slice(0, 3)) console.log("      " + o.rel + " (" + o.size + " nodes)");
}
api.close();
