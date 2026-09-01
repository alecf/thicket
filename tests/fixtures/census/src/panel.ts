// The type duplication: `panel` and `widget` declare the same interface and
// the same type alias under different names. Both are erased at compile time
// and both are small, so they can only reach the report through the section
// that does not rank them against code.
export interface PanelRowProps {
  rowLabel: string;
  rowValue: number;
  isEditable: boolean;
  onRowChange: (next: number) => void;
}

export type PanelSummary = {
  totalCents: number;
  currencyCode: string;
  computedAt: Date;
};
