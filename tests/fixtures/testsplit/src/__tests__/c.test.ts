import { normalizeOrder } from "../order.js";

// The scaffolding: identical mock setup in four test files. More copies and
// more files than the production clone, so on score alone it outranks it.
const logger = {
  info: (message: string) => message,
  warn: (message: string) => message,
  error: (message: string) => message,
  debug: (message: string) => message,
};

export function cCase(): string {
  logger.info("c");
  return normalizeOrder({ id: " c ", total: 1.005, currency: " usd " }).currency;
}
