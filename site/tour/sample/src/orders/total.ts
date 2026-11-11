import type { LineItem } from "./types.js";
import { invoiceFor } from "../invoice/total.js";

export function orderTotal(order: { items: LineItem[] }) {
  let sum = 0;
  for (const item of order.items) {
    sum += item.price * item.qty;
  }
  return sum;
}

export function closeOrder(order: { items: LineItem[] }) {
  return invoiceFor(order.items);
}
