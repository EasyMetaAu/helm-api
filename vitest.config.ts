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
            // Portal has no Svelte test project; its pure-TS helper tests (no
            // `$lib`/`$app` aliases, no .svelte imports) run in the node project.
            "apps/portal/src/lib/**/*.test.ts",
          ],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "packages/core/src/store/postgres/concurrency-leases.real-postgres.test.ts",
          ],
          // The postgres store suite opens an in-process PGlite (WASM Postgres)
          // per test. Under a full parallel run, many WASM cold-starts contend for
          // CPU and the default 5s ceiling is occasionally exceeded — a load flake,
          // not a real hang (the same files pass in isolation). Lift the ceiling so
          // these legitimately-slow inits have headroom; fast tests (the vast
          // majority, sub-ms) are unaffected. hookTimeout covers DB setup in hooks.
          testTimeout: 15_000,
          hookTimeout: 15_000,
          // Self-hosted runners expose 32 host CPUs. Letting Vitest match that
          // count cold-starts too many PGlite instances at once and makes valid
          // queries miss the timeout under shared-host load.
          maxWorkers: 4,
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
      all: true,
      include: [
        "packages/*/src/**/*.ts",
        "apps/gateway/src/**/*.ts",
        "apps/admin/src/**/*.{ts,svelte}",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/*.type-test.ts",
        "**/*.d.ts",
        "**/types.ts",
        "**/ports.ts",
        "**/test/**",
        "**/e2e/**",
        "**/fixtures/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.svelte-kit/**",
        "**/*.config.*",
        "apps/admin/src/lib/test/**",
        "apps/admin/src/locales/**",
        "apps/admin/src/app.html",
        "apps/gateway/src/routes/admin/deps.ts",
        "packages/core/src/protocol/transformer.ts",
        // Integration bootstrap + UI scaffolding: behaviour is exercised by the
        // Playwright e2e suite (protocol/routing/admin specs), not by unit tests.
        // Unit-testing the line-by-line wiring of `buildServer` or SvelteKit route
        // pages adds ~zero marginal benefit, so they are scoped out of the unit
        // coverage metric (the files still ship with regression tests where they
        // have extractable logic — see server.test.ts / server.helpers.test.ts).
        "apps/gateway/src/server.ts",
        "apps/gateway/src/index.ts",
        "apps/admin/src/routes/**",
        "apps/admin/src/lib/i18n/extraction-anchors.svelte",
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 93,
        lines: 90,
      },
    },
  },
});
