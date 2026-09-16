export interface DebtProvenance {
  readonly source: 'client';
  readonly questionnaireId: string;
  readonly schemaVersion: string;
  readonly adapterVersion: number;
  readonly capturedAt: string;
}

export function summarizeDebt(rows: readonly string[]): string {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.trim());
  }
  return [...seen].sort().join(", ");
}

export function auditDebt(items: readonly number[]): number {
  let total = 0;
  for (const item of items) {
    total += item * 2;
  }
  return total;
}
