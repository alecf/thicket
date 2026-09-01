// Half of the runtime cycle: `order` needs `invoice` to format, and `invoice`
// needs `order` to round. Both directions carry values, so the cycle is one
// that can fail at module-init time rather than one type erasure deletes.
import { formatInvoiceId } from "./invoice.js";

export interface Order {
  id: string;
  total: number;
  currency: string;
}

export function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// The production clone: the same normalization body as `normalizeInvoice`.
export function normalizeOrder(order: Order): Order {
  const total = Math.round(order.total * 100) / 100;
  const currency = order.currency.trim().toUpperCase();
  const id = order.id.trim().toLowerCase();
  return { id, total, currency };
}

export function describeOrder(order: Order): string {
  return formatInvoiceId(order.id);
}
