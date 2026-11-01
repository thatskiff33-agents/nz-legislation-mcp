import { defineConfig } from "vitest/config";

// 100% line and branch coverage gate on src/, matching sibling MCP projects.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Two-line process shim; exercised by the spawn test in test/e2e.
      exclude: ["src/cli.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
