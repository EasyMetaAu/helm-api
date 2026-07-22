import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashKey } from "@helm/core";
import { expect, test } from "@playwright/test";
import {
  OAUTH_401_ONCE_SENTINEL,
  OAUTH_BEARER_PREFIX,
  OAUTH_RESET_PATH,
  OAUTH_TOKEN_COUNT_PATH,
  OAUTH_TOKEN_PATH,
} from "./fixtures/mock-upstream.js";

// e2e.oauth — black-box the OAuth subscription-provider path (issue #38) over a
// REAL in-process gateway whose PRIMARY provider authenticates via OAuth (env
// NAMEs → token manager → dynamic per-request Bearer). The gateway is built
// in-process here (NOT the shared Playwright webServer) so we can point a bespoke
// OAuth config at the SAME deterministic mock upstream (port 8181) without
// touching the shipped config. The mock is the OAuth token endpoint AND the
// credential-checked chat upstream; a sentinel prompt makes it 401 once so we can
// observe the invalidate + single-retry-with-fresh-token path.

const MOCK = "http://127.0.0.1:8181";
const TEST_KEY = "helm_live_oauth_e2e";
const AUTH = { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" };

let app: { fetch: (req: Request) => Promise<Response> } | null = null;
let dataDir = "";
let configDir = "";

function requireApp(): { fetch: (req: Request) => Promise<Response> } {
  if (app === null) throw new Error("OAuth e2e gateway app was not initialized");
  return app;
}

function writeConfig(dir: string): void {
  writeFileSync(join(dir, "server.yaml"), "host: 127.0.0.1\nport: 8099\nbase_path: /\n");
  writeFileSync(
    join(dir, "auth.yaml"),
    "require_api_key: true\nbootstrap:\n  generate_if_missing: false\n  persist_to: ./oauth-keys.json\n  print_once: false\n",
  );
  writeFileSync(
    join(dir, "runtime.yaml"),
    "request_timeout_ms: 60000\nrate_limit:\n  enabled: false\n  default:\n    rpm: 0\n    tpm: 0\n",
  );
  // PRIMARY provider authenticates via OAuth (env NAMEs only). base_url is
  // overridden by HELM_PROVIDER_BASE_URL at boot to point at the mock; token_url
  // points directly at the mock's token endpoint.
  writeFileSync(
    join(dir, "providers.yaml"),
    [
      "providers:",
      "  - name: oauth-primary",
      "    type: openai",
      `    base_url: ${MOCK}`,
      "    oauth:",
      "      grant: refresh_token",
      `      token_url: ${MOCK}${OAUTH_TOKEN_PATH}`,
      "      client_id_env: OAUTH_E2E_CLIENT_ID",
      "      client_secret_env: OAUTH_E2E_CLIENT_SECRET",
      "      refresh_token_env: OAUTH_E2E_REFRESH_TOKEN",
      "",
    ].join("\n"),
  );
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "helm-oauth-data-"));
  configDir = mkdtempSync(join(tmpdir(), "helm-oauth-cfg-"));
  writeConfig(configDir);

  // OAuth secrets (env NAMEs resolved here at the composition root, principle 7).
  process.env.OAUTH_E2E_CLIENT_ID = "cid-e2e";
  process.env.OAUTH_E2E_CLIENT_SECRET = "csecret-e2e";
  process.env.OAUTH_E2E_REFRESH_TOKEN = "rtok-e2e";
  process.env.HELM_DATA_DIR = dataDir;
  process.env.HELM_PROVIDER_BASE_URL = MOCK;
  process.env.HELM_SIGNALS_DISABLED = "1";

  // Seed the deterministic API key directly so the gateway never has to bootstrap.
  const { createSqliteDb, SqliteKeyStore } = await import("@helm/core");
  const db = createSqliteDb(join(dataDir, "helm.db"));
  const keyStore = new SqliteKeyStore(db);
  await keyStore.createKey({
    keyId: "k_oauth_e2e",
    hash: hashKey(TEST_KEY),
    prefix: "helm_live_oauth",
    accountId: "acct_oauth",
    role: "root",
  });
  (db as unknown as { $sqlite: { close: () => void } }).$sqlite.close();

  const { buildServer } = await import("../src/server.js");
  const handle = await buildServer({ configDir });
  app = handle.app as unknown as { fetch: (req: Request) => Promise<Response> };

  // Reset mock OAuth counters for a clean run.
  await fetch(`${MOCK}${OAUTH_RESET_PATH}`, { method: "POST" });
});

test.afterAll(() => {
  for (const k of [
    "OAUTH_E2E_CLIENT_ID",
    "OAUTH_E2E_CLIENT_SECRET",
    "OAUTH_E2E_REFRESH_TOKEN",
    "HELM_PROVIDER_BASE_URL",
    "HELM_DATA_DIR",
    "HELM_SIGNALS_DISABLED",
  ]) {
    delete process.env[k];
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

function chat(content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content }],
    stream: false,
    ...extra,
  });
}

test("routes an OpenAI request through an OAuth provider with a fetched Bearer", async () => {
  const res = await requireApp().fetch(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: chat("Say hi."),
    }),
  );
  expect(res.status).toBe(200);
  // The mock minted at least one token (the gateway fetched a Bearer to call it).
  const count = await fetch(`${MOCK}${OAUTH_TOKEN_COUNT_PATH}`).then((r) => r.json());
  expect((count as { count: number }).count).toBeGreaterThanOrEqual(1);
});

test("refreshes + retries once on an upstream 401 and succeeds", async () => {
  await fetch(`${MOCK}${OAUTH_RESET_PATH}`, { method: "POST" });
  const res = await requireApp().fetch(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: chat(`Trigger one 401 then succeed ${OAUTH_401_ONCE_SENTINEL}`),
    }),
  );
  // First upstream call 401s → client invalidates, mints a fresh token, retries
  // once → 200. The end-to-end success ALONE proves the refresh+retry fired: the
  // mock only serves this prompt after it has 401'd once, and the retry must carry
  // a fresh mock-issued Bearer (the 401 branch rejects a missing/stale prefix).
  expect(res.status).toBe(200);
  const count = (await fetch(`${MOCK}${OAUTH_TOKEN_COUNT_PATH}`).then((r) => r.json())) as {
    count: number;
  };
  // The invalidate() forced at least one fresh mint AFTER the reset above.
  expect(count.count).toBeGreaterThanOrEqual(1);
});

test("streams through an OAuth provider end-to-end", async () => {
  const res = await requireApp().fetch(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: chat("Stream please.", { stream: true }),
    }),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  // The mock SSE stream ends with [DONE]; the bytes must flow through intact.
  expect(text).toContain("data:");
  expect(text).toContain("[DONE]");
});

test("never leaks the OAuth Bearer prefix into the response body", async () => {
  // Defense-in-depth sanity: the dynamic Bearer lives in the Authorization header,
  // never in the chat body (principle 7). The echoed mock body must not carry it.
  const res = await requireApp().fetch(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: chat("plain"),
    }),
  );
  const text = await res.text();
  expect(text).not.toContain(OAUTH_BEARER_PREFIX);
});
