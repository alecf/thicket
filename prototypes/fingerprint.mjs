// Prototype of thicket pillar 1: deterministic structural duplication via
// normalized post-order Merkle hashing of every AST subtree.
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import { createHash } from "node:crypto";

const MIN_NODES = 12;

// Boilerplate that is structurally identical everywhere and carries no
// refactoring signal. Discovered empirically: without this, import statements
// swamp the entire report.
const IGNORED = new Set([
  "ImportDeclaration", "ImportClause", "NamedImports", "ImportSpecifier",
  "ExportDeclaration", "ExportSpecifier", "NamedExports",
]);

const api = new API({ cwd: process.cwd() });
const snap = api.updateSnapshot({ openProjects: process.argv.slice(2) });

const groups = new Map();
const seenFiles = new Set(); // a file shared by N projects must be analyzed ONCE
let walked = 0, hashed = 0, bytes = 0, files = 0;

const t0 = performance.now();
for (const p of snap.getProjects()) {
  for (const name of p.program.getSourceFileNames()) {
    if (name.includes("node_modules") || name.endsWith(".d.ts")) continue;
    if (seenFiles.has(name)) continue;
    seenFiles.add(name);
    const sf = p.program.getSourceFile(name);
    if (!sf) continue;
    files++;
    bytes += sf.text.length;
    const rel = name.replace(process.cwd() + "/", "");

    const hash = (n) => {
      walked++;
      const kind = SyntaxKind[n.kind];
      const parts = [kind];
      let size = 1;
      // NOTE: forEachChild ABORTS if the callback returns truthy. Must not leak
      // a return value out of the callback.
      n.forEachChild((c) => {
        const [h, s] = hash(c);
        parts.push(h);
        size += s;
      });
      const digest = createHash("sha256").update(parts.join(" ")).digest("base64url").slice(0, 16);
      if (size >= MIN_NODES && !IGNORED.has(kind)) {
        hashed++;
        let g = groups.get(digest);
        if (!g) groups.set(digest, (g = []));
        g.push({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, size, kind });
      }
      return [digest, size];
    };
    sf.forEachChild((c) => { hash(c); });
  }
}
const ms = performance.now() - t0;

const dupes = [...groups.values()]
  .filter((g) => g.length > 1)
  .sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));

console.log(`fingerprinted ${files} files / ${(bytes / 1e6).toFixed(2)} MB / ${walked} nodes in ${ms.toFixed(0)}ms`);
console.log(`  => ${(walked / ms * 1000 / 1e6).toFixed(2)}M nodes/sec, ${(bytes / 1e6 / (ms / 1000)).toFixed(1)} MB/sec`);
console.log(`  ${hashed} candidate fragments, ${dupes.length} duplicate groups\n`);
console.log(`Top duplication by mass (nodes x extra copies):`);
for (const g of dupes.slice(0, 15)) {
  console.log(`  [mass ${g[0].size * (g.length - 1)}] ${g[0].kind} ~${g[0].size} nodes x${g.length}`);
  for (const o of g.slice(0, 4)) console.log(`      ${o.file}:${o.line}`);
}
api.close();
