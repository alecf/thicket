# thicket report
thicket 0.1.0 · config ce6df2e5 · 4 files / 56 LOC · granularity: file (4 modules)

## Summary
  duplicated mass      253 redundant nodes (overlapping; trend only)
  duplicated coverage  37.9% of source bytes
  propagation cost     0.44
  dependency cycles    1 (largest SCC: 2 modules)
  findings             3 of 3 shown

## Duplication
### THK-DUP-d165768d · score 792 · L1 · 3 copies × 88 nodes
  src/alpha.ts:4  src/beta.ts:3,14
  FunctionDeclaration

### THK-DUP-c389b5be · score 305 · L0 · 2 copies × 77 nodes
  src/alpha.ts:4  src/beta.ts:14
  Block

## Module tangle
### THK-CYC-aca08f5a · SCC of 2 modules
  members: src/alpha.ts → src/gamma.ts
  suggested cuts (1): src/alpha.ts→src/gamma.ts

