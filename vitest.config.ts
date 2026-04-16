import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/live/**", "node_modules/**", "dist/**"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    sequence: {
      concurrent: false,
    },
    globalSetup: ["tests/global-setup.ts"],
    pool: "forks",
    forks: {
      singleFork: true,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/**/*.d.ts",
        "tests/**",
      ],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
        statements: 50,
      },
    },
  },
});
