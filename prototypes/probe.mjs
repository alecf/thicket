import { API } from "typescript/unstable/sync";
import * as ast from "typescript/unstable/ast";

const config = process.argv[2];
const t = (label, fn) => {
  const s = performance.now();
  const r = fn();
  console.log(`${label}: ${(performance.now() - s).toFixed(0)}ms`);
  return r;
};

const api = new API({ cwd: process.cwd() });
const snapshot = t("updateSnapshot (load+bind program)", () =>
  api.updateSnapshot({ openProjects: [config] }),
);

const projects = snapshot.getProjects();
console.log(`projects: ${projects.length}`);
const project = snapshot.getProject(config) ?? projects[0];
console.log(`project: ${project.configFileName}`);

const names = t("getSourceFileNames", () => project.program.getSourceFileNames());
const local = names.filter((n) => !n.includes("node_modules") && !n.endsWith(".d.ts"));
console.log(`source files: ${names.length} total, ${local.length} local non-dts`);

// Walk every local file's AST, count nodes.
let nodes = 0, files = 0, funcs = 0, calls = 0, imports = 0;
const callNodes = [];
t("parse + walk all local ASTs", () => {
  for (const name of local) {
    const sf = project.program.getSourceFile(name);
    if (!sf) continue;
    files++;
    const visit = (n) => {
      nodes++;
      const k = ast.SyntaxKind[n.kind];
      if (k === "FunctionDeclaration" || k === "MethodDeclaration" || k === "ArrowFunction" || k === "FunctionExpression") funcs++;
      if (k === "CallExpression") { calls++; if (callNodes.length < 200) callNodes.push([sf, n]); }
      if (k === "ImportDeclaration") imports++;
      n.forEachChild(visit);
    };
    sf.forEachChild(visit);
  }
});
console.log(`walked ${files} files: ${nodes} nodes, ${funcs} functions, ${calls} calls, ${imports} imports`);

// Type-resolve a sample of call sites -> measures cost of exact call-graph edges.
const checker = project.checker;
let resolved = 0;
const N = Math.min(200, callNodes.length);
t(`getResolvedSignature x${N}`, () => {
  for (let i = 0; i < N; i++) {
    const [, n] = callNodes[i];
    try {
      const sig = checker.getResolvedSignature(n);
      if (sig) resolved++;
    } catch {}
  }
});
console.log(`resolved ${resolved}/${N} call signatures`);

api.close();
