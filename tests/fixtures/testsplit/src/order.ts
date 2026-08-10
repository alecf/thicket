export interface Order {
  id: string;
  total: number;
  currency: string;
}

// The production duplication: the same normalization body in two source
// files. Smaller and less repeated than the test scaffolding below, so a
// single ranking puts it underneath.
export function normalizeOrder(order: Order): Order {
  const total = Math.round(order.total * 100) / 100;
  const currency = order.currency.trim().toUpperCase();
  return { id: order.id.trim(), total, currency };
}
