import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-env.ts"],
    // Tests share one Postgres database; run files serially to keep them deterministic.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { TZ: "UTC" },
  },
});
