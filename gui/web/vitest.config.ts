import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Avoid process-per-file startup under endpoint scanning while preserving
    // per-file isolation and bounded parallelism for the jsdom suite.
    pool: "threads",
    maxWorkers: 4,
    include: ["src/**/*.test.{ts,tsx}", "e2e/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
