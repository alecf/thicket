import xxhash from "xxhash-wasm";

let h64: ((input: string, seed?: bigint) => string) | undefined;

/** Must be awaited once at startup before any hash() call. */
export async function initHash(): Promise<void> {
  if (h64) return;
  const api = await xxhash();
  h64 = (input: string) => api.h64ToString(input);
}

/**
 * Content-addressing hash. Not cryptographic: collisions only ever merge two
 * fragments in a candidate list a human or LLM reviews, so 64 bits is ample.
 */
export function hash(input: string): string {
  if (!h64) throw new Error("initHash() must be awaited before hash()");
  return h64(input).padStart(16, "0");
}
