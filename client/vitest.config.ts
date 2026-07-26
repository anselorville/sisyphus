import { defineConfig } from "vitest/config";

// Pure reducer-style unit tests only (see src/hooks/*.test.ts) -- none of
// them touch the DOM, so plain "node" is enough and keeps this fast. If a
// later task adds component-rendering tests, this can switch to "jsdom"
// then.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: "default",
  },
});
