import { describe, expect, it } from "vitest";
import { hash, initHash } from "../src/hash.js";

describe("hash", () => {
  it("is stable across calls", async () => {
    await initHash();
    expect(hash("hello")).toBe(hash("hello"));
  });

  it("differs for different input", async () => {
    await initHash();
    expect(hash("hello")).not.toBe(hash("world"));
  });

  it("returns a short url-safe string", async () => {
    await initHash();
    expect(hash("hello")).toMatch(/^[0-9a-f]{16}$/);
  });
});
