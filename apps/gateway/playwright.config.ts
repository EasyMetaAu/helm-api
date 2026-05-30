import { defineConfig } from "@playwright/test";

const GATEWAY_PORT = 8090;
const MOCK_PORT = 8181;

// e2e env shared by the gateway launcher: provider points at the local mock,
// a deterministic test key is pre-seeded, sqlite lives in a throwaway dir.
const e2eEnv = {
  HELM_PORT: String(GATEWAY_PORT),
  HELM_DATA_DIR: "./.e2e-data",
  HELM_TEST_KEY: "helm_live_e2e_testkey",
  OPENAI_API_KEY: "sk-upstream-mock-key",
  HELM_PROVIDER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  // e2e-only: lets the `x-helm-eval` request header toggle Layer-2 eval per
  // request so e2e.eval can black-box the cascade without a config reload.
  // Production never sets this (eval stays config-driven, fail-closed).
  HELM_E2E: "1",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${GATEWAY_PORT}`,
  },
  webServer: [
    {
      command: `MOCK_PORT=${MOCK_PORT} tsx e2e/fixtures/mock-upstream.ts`,
      url: `http://127.0.0.1:${MOCK_PORT}/`,
      reuseExistingServer: !process.env.CI,
      // the mock returns 404 on `/` which Playwright treats as "up"
      ignoreHTTPSErrors: true,
    },
    {
      command: "tsx e2e/fixtures/test-server.ts",
      url: `http://127.0.0.1:${GATEWAY_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      env: e2eEnv,
      timeout: 30_000,
    },
  ],
});
