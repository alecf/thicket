export interface SupportProvenance {
  readonly source: 'client';
  readonly questionnaireId: string;
  readonly schemaVersion: string;
  readonly adapterVersion: number;
  readonly capturedAt: string;
}

export function summarizeSupport(rows: readonly string[]): string {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.trim());
  }
  return [...seen].sort().join(", ");
}
