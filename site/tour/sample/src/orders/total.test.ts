import { describe, expect, it } from "vitest";
import { orderTotal } from "./total.js";

describe("orderTotal", () => {
  it("adds every line", () => {
    const items = [
      { sku: "a", name: "Pen", price: 150, qty: 2 },
      { sku: "b", name: "Pad", price: 300, qty: 1 },
    ];
    expect(orderTotal({ items })).toBe(600);
  });
});
