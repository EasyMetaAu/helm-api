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
  SqliteOAuthQuotaStore,
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

function xaiAccessToken(account: string): string {
  const payload = Buffer.from(JSON.stringify({ tier: "supergrok" })).toString("base64url");
  return `xai-access-${account}.${payload}.signature`;
}

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

async function createPromptVideo(key: string, prompt: string, model = "grok-imagine-video") {
  return gateway().fetch(
    new Request("http://gateway.test/v1/videos/generations", {
      method: "POST",
      headers: AUTH(key),
      body: JSON.stringify({
        model,
        prompt,
        duration: 30,
      }),
    }),
  );
}

async function createQualityImage(
  key: string,
  aspectRatio: "3:4" | "4:5",
  responseFormat: "b64_json" | "url",
): Promise<Response> {
  return gateway().fetch(
    new Request("http://gateway.test/v1/images/generations", {
      method: "POST",
      headers: AUTH(key),
      body: JSON.stringify({
        model: "grok-imagine-image-quality",
        prompt: "a picture-book scene",
        aspect_ratio: aspectRatio,
        response_format: responseFormat,
      }),
    }),
  );
}

function pngDimensions(base64: string): [number, number] {
  const bytes = Buffer.from(base64, "base64");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

async function startVideo(
  key: string,
  operation: "generations" | "extensions",
  body: Record<string, unknown>,
): Promise<Response> {
  return gateway().fetch(
    new Request(`http://gateway.test/v1/videos/${operation}`, {
      method: "POST",
      headers: AUTH(key),
      body: JSON.stringify(body),
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
  for (const [keyId, key, accountId, allowCustomModel] of [
    ["video_key_a", KEY_A, HELM_ACCOUNT, true],
    ["video_key_b", KEY_B, HELM_ACCOUNT, false],
    ["video_key_c", KEY_C, "acct_video_other", false],
  ] as const) {
    await keys.createKey({
      keyId,
      hash: hashKey(key),
      prefix: key.slice(0, 16),
      accountId,
      role: "user",
      allowCustomModel,
    });
  }
  const oauth = new SqliteOAuthTokenStore(db);
  const quota = new SqliteOAuthQuotaStore(db);
  for (const account of ["a", "b"]) {
    await oauth.upsert({
      providerId: "xai",
      account,
      accessEnc: encryptSecret(xaiAccessToken(account), ENC_KEY),
      refreshEnc: encryptSecret(`xai-refresh-${account}`, ENC_KEY),
      expiresAt: Date.now() + 60 * 60_000,
      meta: JSON.stringify({ accountId: `xai-user-${account}`, email: `${account}@example.test` }),
      updatedAt: Date.now(),
    });
    await quota.upsert({
      providerId: "xai",
      account,
      windows: [
        {
          key: "7d",
          usedPercent: 1,
          resetsAtMs: Date.now() + 7 * 24 * 60 * 60_000,
          windowMinutes: 7 * 24 * 60,
        },
      ],
      capturedAt: Date.now(),
      source: "xai",
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

test.beforeEach(async () => {
  await nativeFetch(`${MOCK}${VIDEO_RESET_PATH}`, { method: "POST" });
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

test("quality images request upstream 2:3 and return cropped 3:4/4:5 carriers", async () => {
  const cover = await createQualityImage(KEY_B, "3:4", "b64_json");
  expect(cover.status).toBe(200);
  const coverBody = (await cover.json()) as { data: Array<{ b64_json: string }> };
  expect(pngDimensions(coverBody.data[0]?.b64_json ?? "")).toEqual([6, 8]);

  const page = await createQualityImage(KEY_B, "4:5", "url");
  expect(page.status).toBe(200);
  const pageBody = (await page.json()) as { data: Array<{ url: string }> };
  expect(pageBody.data[0]?.url).toMatch(/^data:image\/png;base64,/);
  expect(pngDimensions(pageBody.data[0]?.url.split(",", 2)[1] ?? "")).toEqual([8, 10]);

  const capture = await videoCapture();
  expect(capture.images).toHaveLength(2);
  expect(capture.images.map(({ body }) => body)).toEqual([
    expect.objectContaining({ aspect_ratio: "2:3", response_format: "b64_json" }),
    expect.objectContaining({ aspect_ratio: "2:3", response_format: "b64_json" }),
  ]);
});

test("rejects a configured static outputVideo alias at the closed Imagine request boundary", async () => {
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

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  expect((await videoCapture()).starts).toHaveLength(0);
});

test("forwards official and compatibility generation shapes plus one extension exactly once", async () => {
  const generationBodies = [
    { model: "grok-imagine-video", prompt: "text only", duration: 30 },
    {
      model: "grok-imagine-video-1.5",
      prompt: "single image",
      image: { url: "https://example.test/source.png" },
      aspect_ratio: "4:3",
      duration: 12,
      resolution: "1080p",
    },
    {
      model: "grok-imagine-video-1.5",
      prompt: "reference <IMAGE_0> with <AUDIO_0>",
      reference_images: [{ url: "https://example.test/one.png" }],
      reference_audios: [{ voice_id: "eve" }],
      aspect_ratio: "3:4",
      duration: 8,
      resolution: "720p",
    },
    {
      model: "grok-imagine-video-1.5",
      prompt: "compatible <IMAGE_0> and <IMAGE_1>",
      images: [{ url: "https://example.test/three.png" }, { url: "https://example.test/four.png" }],
      aspect_ratio: "16:9",
      duration: 30,
      resolution: "720p",
    },
  ];

  for (const body of generationBodies) {
    const response = await startVideo(KEY_A, "generations", body);
    expect(response.status, await response.text()).toBe(200);
  }
  const extensionBody = {
    model: "grok-imagine-video",
    prompt: "continue the camera movement",
    video: { url: "https://example.test/source.mp4" },
    duration: 30,
  };
  const extension = await startVideo(KEY_A, "extensions", extensionBody);
  const extensionJson = (await extension.json()) as { request_id: string };
  expect(extension.status).toBe(200);

  const captured = await videoCapture();
  expect(captured.starts).toHaveLength(5);
  expect(captured.starts.map(({ operation, body }) => ({ operation, body }))).toEqual([
    ...generationBodies.map((body) => ({
      operation: "generation",
      body:
        "images" in body
          ? {
              ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== "images")),
              reference_images: body.images,
            }
          : body,
    })),
    { operation: "extension", body: extensionBody },
  ]);

  expect((await pollVideo(KEY_B, extensionJson.request_id)).status).toBe(404);
  expect((await pollVideo(KEY_A, extensionJson.request_id)).status).toBe(200);
  await boot();
  expect((await pollVideo(KEY_A, extensionJson.request_id)).status).toBe(200);
  const finished = await videoCapture();
  expect(finished.polls).toEqual([
    { requestId: extensionJson.request_id, account: captured.starts[4]?.account },
    { requestId: extensionJson.request_id, account: captured.starts[4]?.account },
  ]);
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
  const imageBody = await image.json();
  expect(image.status, JSON.stringify(imageBody)).toBe(200);
  expect(imageBody).toMatchObject({
    model: "grok-imagine-image-quality",
    data: [{ b64_json: expect.any(String) }],
  });
  expect((await videoCapture()).images).toEqual([
    {
      account: expect.stringMatching(/^[ab]$/),
      body: expect.objectContaining({
        model: "grok-imagine-image-quality",
        resolution: "1k",
      }),
    },
  ]);

  const first = await createPromptVideo(
    KEY_A,
    "camera pushes toward the subject",
    "xai/grok-imagine-video",
  );
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
