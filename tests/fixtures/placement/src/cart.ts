import { type Line } from "./invoice.js";

export function cartTotal(lines: Line[]): number {
  let sum = 0;
  for (const line of lines) {
    const gross = line.price * line.qty;
    sum += gross - gross * line.discount;
  }
  return Math.round(sum * 100) / 100;
}
