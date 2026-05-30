import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    // Native addons (better-sqlite3) must be loaded by Node's require, not
    // transformed by Vite — otherwise the .node bindings cannot be located.
    server: {
      deps: {
        external: ["better-sqlite3"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
