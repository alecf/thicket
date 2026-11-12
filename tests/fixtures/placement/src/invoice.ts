// `cart` imports this file, so the shared version of `lineTotal` can live
// here. The reverse cannot: `invoice` importing `cart` closes a cycle.
export interface Line {
  price: number;
  qty: number;
  discount: number;
}

export function invoiceTotal(lines: Line[]): number {
  let sum = 0;
  for (const line of lines) {
    const gross = line.price * line.qty;
    sum += gross - gross * line.discount;
  }
  return Math.round(sum * 100) / 100;
}
