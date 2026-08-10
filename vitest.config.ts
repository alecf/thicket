import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // `tests/fixtures/testsplit` contains files named `*.test.ts` on purpose:
    // the whole point of that fixture is that thicket classifies them as
    // tests, and `isTestPath` keys on the name. They are input data, not
    // suites, so vitest must not try to run them.
    exclude: ["tests/fixtures/**"],
    testTimeout: 30_000, // program loads can be slow on first run
  },
});
