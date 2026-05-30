import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Multi-project run: the node-only packages/gateway suite plus the admin
    // SvelteKit suite (its own config adds the Svelte compiler + jsdom). One
    // `vitest run` (= `pnpm test`) executes both. `apps/admin` is intentionally
    // excluded from the node project so its `.svelte` imports never hit the
    // node environment.
    projects: [
      {
        test: {
          name: "node",
          include: [
            "packages/**/*.test.ts",
            "apps/gateway/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          environment: "node",
          // Native addons (better-sqlite3) must be loaded by Node's require, not
          // transformed by Vite — otherwise the .node bindings cannot be located.
          server: {
            deps: {
              external: ["better-sqlite3"],
            },
          },
        },
      },
      "./apps/admin/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
