import { defineConfig } from "vitest/config";

// Unit tests run in Node against the pure library functions (grading math). UI
// is exercised separately; we deliberately scope vitest to lib/ test files so it
// stays fast and free of the Next/React transform pipeline.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
