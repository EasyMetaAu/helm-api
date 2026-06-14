import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "scripts/passthrough/unit.test.ts",
      "packages/core/src/provider/protocol.test.ts",
      "packages/core/src/provider/anthropic.test.ts",
      "packages/core/src/provider/openai-responses.test.ts",
      "apps/gateway/src/routes/execute.test.ts",
      "apps/gateway/src/routes/messages-pipeline.test.ts",
      "apps/gateway/src/routes/messages.test.ts",
      "apps/gateway/src/routes/responses.test.ts",
    ],
    environment: "node",
    server: {
      deps: {
        external: ["better-sqlite3"],
      },
    },
  },
});
