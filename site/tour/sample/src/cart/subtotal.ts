import type { CartLine } from "./types.js";

export function cartSubtotal(cart: { lines: CartLine[] }) {
  let total = 0;
  for (const line of cart.lines) {
    total += line.price * line.qty;
  }
  return total;
}
