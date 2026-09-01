export interface WidgetRowProps {
  rowLabel: string;
  rowValue: number;
  isEditable: boolean;
  onRowChange: (next: number) => void;
}

export type WidgetSummary = {
  totalCents: number;
  currencyCode: string;
  computedAt: Date;
};
