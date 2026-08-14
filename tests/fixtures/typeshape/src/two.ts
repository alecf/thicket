export interface twoRowProps {
  rowLabel: string;
  rowValue: number;
  isEditable: boolean;
  onRowChange: (next: number) => void;
}

export type twoSummary = {
  totalCents: number;
  currencyCode: string;
  computedAt: Date;
};

export function rendertwo(rows: twoRowProps[]): string {
  const parts: string[] = [];
  for (const row of rows) {
    const label = row.rowLabel.trim().toUpperCase();
    const value = row.rowValue.toFixed(2);
    const flag = row.isEditable ? "editable" : "locked";
    parts.push(`${label}=${value}(${flag})`);
    if (row.rowValue < 0) {
      parts.push("negative");
    }
    if (row.rowValue > 1000) {
      parts.push("large");
    }
  }
  return parts.join(",");
}
