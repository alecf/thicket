import { API } from "typescript/unstable/sync";

const api = new API({ cwd: process.cwd() });
const s0 = performance.now();
const snap = api.updateSnapshot({ openProjects: process.argv.slice(2) });
console.log(`load ${process.argv.length - 2} project(s): ${(performance.now() - s0).toFixed(0)}ms`);

let allNodes = 0, allFiles = 0, bytes = 0;
const s1 = performance.now();
for (const p of snap.getProjects()) {
  for (const name of p.program.getSourceFileNames()) {
    const sf = p.program.getSourceFile(name);
    if (!sf) continue;
    allFiles++;
    bytes += sf.text.length;
    const visit = (n) => { allNodes++; n.forEachChild(visit); };
    sf.forEachChild(visit);
  }
}
const ms = performance.now() - s1;
console.log(`walked ${allFiles} files / ${(bytes / 1e6).toFixed(1)} MB / ${allNodes} nodes in ${ms.toFixed(0)}ms`);
console.log(`  => ${(allNodes / ms * 1000 / 1e6).toFixed(2)}M nodes/sec, ${(bytes / 1e6 / (ms / 1000)).toFixed(1)} MB/sec`);
api.close();
