import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

export default defineConfig({
  test: {
    include: [
      resolve(
        repositoryRoot,
        "packages/core/src/store/postgres/concurrency-leases.real-postgres.test.ts",
      ),
    ],
    environment: "node",
    fileParallelism: false,
  },
});
