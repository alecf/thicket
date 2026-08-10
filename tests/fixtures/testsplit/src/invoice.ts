import type { Order } from "./order.js";

export function normalizeInvoice(invoice: Order): Order {
  const total = Math.round(invoice.total * 100) / 100;
  const currency = invoice.currency.trim().toUpperCase();
  return { id: invoice.id.trim(), total, currency };
}
