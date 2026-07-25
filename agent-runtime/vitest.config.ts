import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: "default",
    // --expose-gc: test/performance/session-memory.test.ts needs a real
    // global.gc() to force collection between measurement rounds so RSS
    // deltas reflect actual retained memory, not just uncollected garbage.
    // Harmless for every other test file -- it only exposes the function,
    // it never changes GC behavior on its own.
    execArgv: ["--expose-gc"],
  },
});
