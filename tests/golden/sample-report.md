# thicket report
thicket 0.1.0 · config 97d8d00b · 4 files / 56 LOC · granularity: file (4 modules)

## Summary
  analyzed             4 of 4 source files (100.0%)
  duplicated mass      253 redundant nodes (overlapping; trend only)
  duplicated coverage  37.9% of source bytes
  propagation cost     0.44
  dependency cycles    1 (largest SCC: 2 modules)
  findings             3 of 3 shown

## Duplication
### THK-DUP-d165768d · score 26 · L1 · 3 copies × ~10 lines · ~16 lines recoverable
  src/alpha.ts:4  src/beta.ts:3,14
  FunctionDeclaration
    export function normalizeAlpha(points: Point[]): Point[] {
      const result: Point[] = [];
      for (const p of points) {
    …

### THK-DUP-c389b5be · score 18 · L0 · 2 copies × ~10 lines · ~7 lines recoverable
  src/alpha.ts:4  src/beta.ts:14
  Block
    {
      const result: Point[] = [];
      for (const p of points) {
    …

## Module tangle
### THK-CYC-aca08f5a · SCC of 2 modules
  members: src/alpha.ts → src/gamma.ts
  suggested cuts (1): src/alpha.ts→src/gamma.ts

