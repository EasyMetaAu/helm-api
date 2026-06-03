import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, adminEnv } from "./e2e/fixtures/admin.js";

const GATEWAY_PORT = 8090;
const MOCK_PORT = 8181;

// The admin static-serve resolves its SPA root (`./apps/admin/build`) relative to
// the gateway process CWD, which it documents as the repo root. Playwright would
// otherwise launch webServers from this config's dir (apps/gateway), so we pin the
// gateway launcher's CWD to the repo root (two levels up) — both so /admin finds
// the adapter-static build and so HELM_DATA_DIR lands in the throwaway dir.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// e2e env shared by the gateway launcher: provider points at the local mock,
// a deterministic test key is pre-seeded, sqlite lives in a throwaway dir.
const e2eEnv = {
  HELM_PORT: String(GATEWAY_PORT),
  // Resolved against the gateway CWD (repo root, set on the webServer below).
  HELM_DATA_DIR: "./apps/gateway/.e2e-data",
  HELM_TEST_KEY: "helm_live_e2e_testkey",
  // PRIMARY (deepseek) provider credential — mandatory; the gateway fail-closes
  // without it. A dummy value is enough: HELM_PROVIDER_BASE_URL points every
  // provider at the offline mock, so no real key is ever used.
  DEEPSEEK_API_KEY: "sk-upstream-mock-key",
  HELM_PROVIDER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  // e2e-only: lets the `x-helm-eval` request header toggle Layer-2 eval per
  // request so e2e.eval can black-box the cascade without a config reload.
  // Production never sets this (eval stays config-driven, fail-open to balanced).
  HELM_E2E: "1",
  // Enable HTTP Basic on /admin via env (env-priority, docs/11) so e2e.admin can
  // black-box the auth gate against the real gateway + adapter-static build.
  ...adminEnv,
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${GATEWAY_PORT}`,
  },
  projects: [
    {
      // Default project: the API/protocol/routing specs hit the unauthenticated
      // /v1/* + /healthz surface (NOT /admin), so they need no credentials.
      name: "gateway",
      testIgnore: /admin\.spec\.ts$/,
    },
    {
      // Admin auth-gate cases (@noauth): run WITHOUT httpCredentials so the
      // gateway's HTTP Basic challenge is observable. With credentials configured,
      // Playwright would transparently answer the 401 challenge and retry, masking
      // the gate — so these specs must run in a credential-less project.
      name: "admin-noauth",
      testMatch: /admin\.spec\.ts$/,
      grep: /@noauth/,
    },
    {
      // Admin UI flows: drive the SPA behind HTTP Basic. Playwright injects the
      // credentials so the browser never sees the native auth dialog.
      name: "admin",
      testMatch: /admin\.spec\.ts$/,
      grepInvert: /@noauth/,
      use: {
        httpCredentials: { username: ADMIN_USER, password: ADMIN_PASSWORD },
      },
    },
  ],
  webServer: [
    {
      command: `MOCK_PORT=${MOCK_PORT} tsx e2e/fixtures/mock-upstream.ts`,
      url: `http://127.0.0.1:${MOCK_PORT}/`,
      reuseExistingServer: !process.env.CI,
      // the mock returns 404 on `/` which Playwright treats as "up"
      ignoreHTTPSErrors: true,
    },
    {
      // Run from the repo root so admin-static's `./apps/admin/build` resolves.
      command: "tsx apps/gateway/e2e/fixtures/test-server.ts",
      cwd: REPO_ROOT,
      url: `http://127.0.0.1:${GATEWAY_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      env: e2eEnv,
      timeout: 30_000,
    },
  ],
});
