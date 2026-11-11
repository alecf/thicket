import type { LineItem } from "../orders/types.js";
import { formatMoney } from "../reports/rows.js";

export function orderTotal(order: { items: LineItem[] }) {
  let sum = 0;
  for (const item of order.items) {
    sum += item.price * item.qty;
  }
  return sum;
}

export function invoiceFor(items: LineItem[]) {
  return formatMoney(orderTotal({ items }));
}
