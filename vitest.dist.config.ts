import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/dist-smoke.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
});
