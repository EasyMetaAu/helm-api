import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntimeMemoryCoordinator,
  createSqliteDb,
  encryptSecret,
  hashKey,
  SqliteKeyStore,
  SqliteOAuthTokenStore,
} from "@helm/core";
import { expect, test } from "@playwright/test";
import {
  VIDEO_CAPTURE_PATH,
  VIDEO_RESET_PATH,
  type VideoCapture,
} from "./fixtures/mock-upstream.js";

const MOCK = "http://127.0.0.1:8181";
const ENC_KEY = Buffer.alloc(32, 19);
const HELM_ACCOUNT = "acct_video_e2e";
const KEY_A = "helm_live_video_key_a";
const KEY_B = "helm_live_video_key_b";
const KEY_C = "helm_live_video_key_other_account";
const AUTH = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

let dataDir = "";
let configDir = "";
let app: { fetch(request: Request): Promise<Response> } | null = null;
let nativeFetch: typeof fetch;

function gateway(): { fetch(request: Request): Promise<Response> } {
  if (app === null) throw new Error("video e2e gateway was not initialized");
  return app;
}

async function boot(): Promise<void> {
  const { buildServer } = await import("../src/server.js");
  const built = await buildServer({
    configDir,
    memoryCoordinator: createRuntimeMemoryCoordinator({
      capacityBytes: () => Number.MAX_SAFE_INTEGER,
    }),
  });
  app = built.app as unknown as { fetch(request: Request): Promise<Response> };
}

async function videoCapture(): Promise<VideoCapture> {
  return nativeFetch(`${MOCK}${VIDEO_CAPTURE_PATH}`).then((response) => response.json());
}

async function createVideo(key: string, prompt: string): Promise<Response> {
  return gateway().fetch(
    new Request("http://gateway.test/v1/videos/generations", {
      method: "POST",
      headers: AUTH(key),
      body: JSON.stringify({
        model: "grok-imagine-video-1.5-preview",
        prompt,
        image: { url: "data:image/png;base64,aGVsbQ==" },
        duration: 6,
        resolution: "480p",
      }),
    }),
  );
}

async function pollVideo(key: string, requestId: string): Promise<Response> {
  return gateway().fetch(
    new Request(`http://gateway.test/v1/videos/${requestId}`, { headers: AUTH(key) }),
  );
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "helm-video-data-"));
  configDir = mkdtempSync(join(tmpdir(), "helm-video-config-"));
  cpSync(fileURLToPath(new URL("../../../config", import.meta.url)), configDir, {
    recursive: true,
  });
  appendFileSync(
    join(configDir, "providers.yaml"),
    `
  - name: static-video
    type: openai
    base_url: ${MOCK}
    api_key_env: HELM_E2E_STATIC_VIDEO_KEY
    models:
      - alias: static/video
        provider_model: grok-imagine-video
`,
  );
  appendFileSync(
    join(configDir, "capabilities.yaml"),
    `
static/video:
  supportsTools: false
  jsonOutput: none
  supportsVision: true
  supportsStreaming: false
  supportsCachedContent: false
  outputVideo: true
  maxContextTokens: 32768
  maxOutputTokens: null
`,
  );

  process.env.HELM_DATA_DIR = dataDir;
  process.env.HELM_OAUTH_ENC_KEY = ENC_KEY.toString("base64");
  process.env.HELM_PROVIDER_BASE_URL = MOCK;
  process.env.HELM_SIGNALS_DISABLED = "1";
  process.env.HELM_E2E_STATIC_VIDEO_KEY = "xai-access-static";

  const db = createSqliteDb(join(dataDir, "helm.db"));
  const keys = new SqliteKeyStore(db);
  for (const [keyId, key, accountId] of [
    ["video_key_a", KEY_A, HELM_ACCOUNT],
    ["video_key_b", KEY_B, HELM_ACCOUNT],
    ["video_key_c", KEY_C, "acct_video_other"],
  ] as const) {
    await keys.createKey({
      keyId,
      hash: hashKey(key),
      prefix: key.slice(0, 16),
      accountId,
      role: "user",
    });
  }
  const oauth = new SqliteOAuthTokenStore(db);
  for (const account of ["a", "b"]) {
    await oauth.upsert({
      providerId: "xai",
      account,
      accessEnc: encryptSecret(`xai-access-${account}`, ENC_KEY),
      refreshEnc: encryptSecret(`xai-refresh-${account}`, ENC_KEY),
      expiresAt: Date.now() + 60 * 60_000,
      meta: JSON.stringify({ accountId: `xai-user-${account}`, email: `${account}@example.test` }),
      updatedAt: Date.now(),
    });
  }
  (db as unknown as { $sqlite: { close(): void } }).$sqlite.close();

  nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input.url : String(input);
    const url = new URL(source);
    if (url.hostname === "api.x.ai" || url.hostname === "cli-chat-proxy.grok.com") {
      const rewritten = new URL(`${url.pathname.replace(/^\/v1/, "")}${url.search}`, MOCK);
      return input instanceof Request
        ? nativeFetch(new Request(rewritten, input), init)
        : nativeFetch(rewritten, init);
    }
    return nativeFetch(input, init);
  }) as typeof fetch;

  await nativeFetch(`${MOCK}${VIDEO_RESET_PATH}`, { method: "POST" });
  await boot();
});

test.afterAll(() => {
  globalThis.fetch = nativeFetch;
  for (const name of [
    "HELM_DATA_DIR",
    "HELM_OAUTH_ENC_KEY",
    "HELM_PROVIDER_BASE_URL",
    "HELM_SIGNALS_DISABLED",
    "HELM_E2E_STATIC_VIDEO_KEY",
  ]) {
    delete process.env[name];
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

test("rejects a static outputVideo provider because Imagine is SuperGrok OAuth-only", async () => {
  const response = await gateway().fetch(
    new Request("http://gateway.test/v1/videos/generations", {
      method: "POST",
      headers: AUTH(KEY_A),
      body: JSON.stringify({
        model: "static/video",
        prompt: "must stay on the subscription connection",
        image: { url: "https://example.test/frame.png" },
        duration: 6,
        resolution: "480p",
      }),
    }),
  );

  expect(response.status).toBe(503);
  expect((await videoCapture()).starts).toHaveLength(0);
});

test("start, owner isolation, OAuth pinning, and restart recovery stay on one durable journey", async () => {
  const image = await gateway().fetch(
    new Request("http://gateway.test/v1/images/generations", {
      method: "POST",
      headers: AUTH(KEY_A),
      body: JSON.stringify({
        model: "grok-imagine-image-quality",
        prompt: "a lighthouse in fog",
        n: 1,
        resolution: "1k",
        response_format: "b64_json",
      }),
    }),
  );
  expect(image.status).toBe(200);
  expect(await image.json()).toMatchObject({
    model: "grok-imagine-image-quality",
    data: [{ b64_json: expect.any(String) }],
  });
  expect((await videoCapture()).images).toEqual([
    {
      account: "a",
      body: expect.objectContaining({
        model: "grok-imagine-image-quality",
        resolution: "1k",
      }),
    },
  ]);

  const first = await createVideo(KEY_A, "camera pushes toward the subject");
  const second = await createVideo(KEY_B, "wind moves the subject's coat");
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const firstId = ((await first.json()) as { request_id: string }).request_id;
  const secondId = ((await second.json()) as { request_id: string }).request_id;

  const started = await videoCapture();
  expect(started.starts).toHaveLength(2);
  expect(new Set(started.starts.map(({ account }) => account)).size).toBe(2);

  const crossKey = await pollVideo(KEY_B, firstId);
  expect(crossKey.status).toBe(404);
  expect((await videoCapture()).polls).toHaveLength(0);

  const crossAccount = await pollVideo(KEY_C, firstId);
  expect(crossAccount.status).toBe(404);
  expect((await videoCapture()).polls).toHaveLength(0);

  const pending = await pollVideo(KEY_A, firstId);
  expect(pending.status).toBe(200);
  expect(await pending.json()).toMatchObject({ request_id: firstId, status: "rendering" });

  // A fresh buildServer opens a new SQLite-backed registry over the same data dir.
  // Continuing with the original id proves recovery; start count must stay at two.
  await boot();

  const doneAfterRestart = await pollVideo(KEY_A, firstId);
  expect(doneAfterRestart.status).toBe(200);
  expect(await doneAfterRestart.json()).toMatchObject({
    request_id: firstId,
    status: "done",
    video: { url: `https://download.example.test/${firstId}.mp4` },
  });

  const secondPending = await pollVideo(KEY_B, secondId);
  expect(secondPending.status).toBe(200);
  expect(await secondPending.json()).toMatchObject({ request_id: secondId, status: "rendering" });

  const finished = await videoCapture();
  expect(finished.starts).toHaveLength(2);
  expect(finished.polls).toEqual(
    expect.arrayContaining([
      { requestId: firstId, account: started.starts[0]?.account },
      { requestId: secondId, account: started.starts[1]?.account },
    ]),
  );
});
