import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/entry.ts", "src/mcp/server.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 75,
        branches: 60
      }
    }
  }
});
