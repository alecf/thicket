import { closeOrder } from "../orders/total.js";
import type { LineItem } from "../orders/types.js";

export function reportTotal(report: { rows: LineItem[] }) {
  let sum = 0;
  for (const row of report.rows) {
    if (row.qty === 0) continue;
    sum += row.price * row.qty;
  }
  return sum;
}

export function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function reprint(items: LineItem[]) {
  return closeOrder({ items });
}
