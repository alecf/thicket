export function renderOne(rows: readonly { label: string; total: number }[]) {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`${row.label}: ${row.total}`);
  }
  lines.push("---");
  lines.push(`count: ${rows.length}`);
  return lines.join("\n");
}
