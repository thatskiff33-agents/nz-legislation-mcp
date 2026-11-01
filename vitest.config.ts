import { defineConfig } from "vitest/config";

// 100% line and branch coverage gate on src/, matching sibling MCP projects.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
