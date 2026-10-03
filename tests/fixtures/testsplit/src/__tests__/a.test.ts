import { normalizeOrder } from "../order.js";

// The scaffolding: identical mock setup in four test files. A bigger shape,
// more copies and more files than the production clone, so on score alone it
// outranks it.
const logger = {
  info: (message: string) => message,
  warn: (message: string) => message,
  error: (message: string) => message,
  debug: (message: string) => message,
  trace: (message: string) => message,
  fatal: (message: string) => message,
  notice: (message: string) => message,
  verbose: (message: string) => message,
  critical: (message: string) => message,
  silly: (message: string) => message,
};

export function aCase(): string {
  logger.info("a");
  return normalizeOrder({ id: " a ", total: 1.005, currency: " usd " }).currency;
}
