import { normalizeOrder } from "../order.js";

// The scaffolding: the same mock logger in three test files. Test-majority, so
// it is counted apart from the production clone it exercises.
const logger = {
  info: (message: string) => message,
  warn: (message: string) => message,
  error: (message: string) => message,
  debug: (message: string) => message,
};

export function bCase(): string {
  logger.info("b");
  return normalizeOrder({ id: " b ", total: 1.005, currency: " usd " }).currency;
}
