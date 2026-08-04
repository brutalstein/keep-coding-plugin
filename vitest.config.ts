import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/graph-benchmark.test.ts", "tests/dist-smoke.test.ts", "tests/context-benchmark.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["tests/graph-benchmark.test.ts", "src/entry.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 75,
        branches: 75
      }
    }
  }
});
