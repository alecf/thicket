import { describe, expect, it } from "vitest";
import { cartSubtotal } from "./subtotal.js";

describe("cartSubtotal", () => {
  it("adds every line", () => {
    const lines = [
      { sku: "a", name: "Pen", price: 150, qty: 2 },
      { sku: "b", name: "Pad", price: 300, qty: 1 },
    ];
    expect(cartSubtotal({ lines })).toBe(600);
  });
});
