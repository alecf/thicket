import { roundCents, type Order } from "./order.js";

export function formatInvoiceId(id: string): string {
  return id.trim().toUpperCase();
}

// The other copy of the clone above.
export function normalizeInvoice(invoice: Order): Order {
  const total = Math.round(invoice.total * 100) / 100;
  const currency = invoice.currency.trim().toUpperCase();
  const id = invoice.id.trim().toLowerCase();
  return { id, total, currency };
}

export function invoiceCents(invoice: Order): number {
  return roundCents(invoice.total);
}
