import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// The connection page exercises real browser code against deterministic HTTP
// fixtures. No database, subscription credentials or live inference is needed.
const port = 5187;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "portal-connect.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: {
    channel: process.env.HELM_BROWSER_CHANNEL,
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: `pnpm --filter @helm/portal exec vite dev --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: `http://127.0.0.1:${port}/portal/connect`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
