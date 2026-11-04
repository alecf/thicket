import type { Order, Summary } from "./types.js";

export function summarizeSouth(orders: Order[], region: string): Summary {
  const totals = new Map<string, number>();
  let count = 0;
  for (const order of orders) {
    if (order.region !== region) continue;
    const previous = totals.get(order.customer) ?? 0;
    totals.set(order.customer, previous + order.amount * order.quantity);
    count += 1;
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 5).map(([customer, amount]) => ({ customer, amount }));
  const total = ranked.reduce((sum, [, amount]) => sum + amount, 0);
  return { region, count, total, top, average: count === 0 ? 0 : total / count };
}
