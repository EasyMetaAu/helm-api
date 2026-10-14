import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteDb, hashKey, SqliteKeyStore } from "@helm/core";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { buildServer, type ServerHandle } from "./server.js";

const Created = z.object({ request_id: z.string() });
it("integrates native images/video/ASR/speech with ownership and restart boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helm-native-integration-"));
  const db = createSqliteDb(join(dir, "helm.db"));
  let server: ServerHandle | undefined;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const models = [
    ["image", "qwen-image-3.0-pro"],
    ["video", "wan3.0-video"],
    ["asr", "qwen3-asr-flash"],
    ["file", "qwen3-asr-flash-filetrans"],
  ];
  const headers = (key = "owner") => ({
    authorization: `Bearer test-${key}`,
    "content-type": "application/json",
  });
  try {
    await cp(resolve("config"), join(dir, "config"), { recursive: true });
    for (const key of ["owner", "other", "restricted", "spend"]) {
      await new SqliteKeyStore(db).createKey({
        keyId: key,
        hash: hashKey(`test-${key}`),
        prefix: "test",
        accountId: "fixture",
        role: "user",
        allowCustomModel: true,
        ...(key === "restricted" ? { allowedLanes: ["balanced"] } : {}),
        ...(key === "spend" ? { budgetSpendUsd: 1, budgetWindowSeconds: 3600 } : {}),
      });
    }
    await appendFile(
      join(dir, "config/providers.yaml"),
      "\n  - " +
        JSON.stringify({
          name: "ali",
          type: "bailian-media",
          api_key_env: "ALI_TEST_KEY",
          media_account_id: "account-a",
          base_url: "https://workspace.example.test/api/v1",
          models: models.map(([alias, provider_model]) => ({
            alias: `ali/${alias}`,
            provider_model,
          })),
        }) +
        "\n  - " +
        JSON.stringify({
          name: "mm",
          type: "minimax-media",
          api_key_env: "MM_TEST_KEY",
          media_account_id: "account-m",
          base_url: "https://api.minimax.io",
          models: [
            { alias: "mm/video", provider_model: "MiniMax-H3" },
            { alias: "mm/speech", provider_model: "speech-2.8-hd" },
          ],
        }) +
        "\n",
    );
    for (const [lane, alias] of [
      ["test-image", "ali/image"],
      ["test-video", "ali/video"],
      ["test-asr", "ali/asr"],
      ["test-file", "ali/file"],
      ["test-mm", "mm/video"],
      ["test-speech", "mm/speech"],
    ])
      await appendFile(
        join(dir, "config/lanes.yaml"),
        `\n${lane}:\n  primary: ${alias}\n  fallback: []\n`,
      );
    for (const [alias, flag] of [
      ["ali/image", "outputImage"],
      ["ali/video", "outputVideo"],
      ["mm/video", "outputVideo"],
      ["mm/speech", "outputAudio"],
    ])
      await appendFile(
        join(dir, "config/capabilities.yaml"),
        `\n${alias}:\n  supportsTools: false\n  jsonOutput: none\n  supportsVision: false\n  supportsStreaming: false\n  maxContextTokens: 0\n  maxOutputTokens: null\n  ${flag}: true\n`,
      );
    for (const [key, value] of Object.entries({
      ALI_TEST_KEY: "fixture-ali",
      MM_TEST_KEY: "fixture-mm",
      HELM_DATA_DIR: dir,
      HELM_SIGNALS_DISABLED: "1",
      HELM_OAUTH_ENC_KEY: "11".repeat(32),
      HELM_AUTH_CACHE_TTL_MS: "0",
    }))
      vi.stubEnv(key, value);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const req = new Request(input, init);
        const path = new URL(req.url).pathname;
        const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
        calls.push({ path, body });
        if (path.endsWith("images/generations"))
          return Response.json({ data: [{ url: "https://cdn.example/image.png" }] });
        if (path.endsWith("chat/completions"))
          return Response.json({
            id: "chat",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              { index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" },
            ],
          });
        if (path.endsWith("t2a_v2"))
          return Response.json({
            base_resp: { status_code: 0 },
            data: { audio: "494433", status: 2 },
            extra_info: { usage_characters: 2 },
          });
        if (path === "/v2/video_generation") return Response.json({ task_id: "mm-job" });
        if (path.includes("/v2/query/"))
          return Response.json({
            task: {
              id: "mm-job",
              model: "MiniMax-H3",
              status: "succeeded",
              content: { url: "https://cdn.example/movie.mp4" },
            },
          });
        if (req.method === "POST")
          return Response.json({
            output: {
              task_id: body.model === "wan3.0-video" ? "video-job" : "asr-job",
              task_status: "PENDING",
            },
          });
        return Response.json({
          output: {
            task_id: path.endsWith("video-job") ? "video-job" : "asr-job",
            task_status: path.endsWith("video-job") ? "SUCCEEDED" : "RUNNING",
            ...(path.endsWith("video-job") ? { video_url: "https://cdn.example/movie.mp4" } : {}),
          },
        });
      }),
    );
    const start = () =>
      buildServer({
        configDir: join(dir, "config"),
        resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
        logger: { log: () => {} },
      });
    server = await start();
    const post = (path: string, body: unknown, key = "owner") =>
      server?.app.request(path, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify(body),
      }) as Promise<Response>;
    const video = { model: "test-video", input: { prompt: "bird" } };
    for (const key of ["spend", "restricted"]) {
      const response = await post("/v1/videos/generations", video, key);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toHaveLength(0);
    for (const [path, body] of [
      ["/v1/images/generations", { model: "test-image", prompt: "bird" }],
      [
        "/v1/audio/speech",
        { model: "test-speech", input: "你好", voice: "Chinese (Mandarin)_Warm_Bestie" },
      ],
      [
        "/v1/chat/completions",
        {
          model: "test-asr",
          messages: [
            {
              role: "user",
              content: [
                { type: "input_audio", input_audio: { data: "https://cdn.example/audio.mp3" } },
              ],
            },
          ],
          asr_options: { enable_itn: false },
        },
      ],
    ] as const) {
      const r = await post(path, body);
      expect(r.status, await r.text()).toBe(200);
    }
    expect(calls.find((c) => c.path.endsWith("chat/completions"))?.body).toMatchObject({
      model: "qwen3-asr-flash",
      asr_options: { enable_itn: false },
      messages: [{ content: [{ input_audio: { data: "https://cdn.example/audio.mp3" } }] }],
    });
    const ids = [];
    for (const [path, body, poll] of [
      ["/v1/videos/generations", video, "/v1/videos"],
      [
        "/v1/videos/generations",
        {
          model: "test-mm",
          content: [{ type: "text", text: "bird" }],
          resolution: "768P",
          duration: 4,
          ratio: "16:9",
        },
        "/v1/videos",
      ],
      [
        "/v1/audio/transcription-jobs",
        { model: "test-file", input: { file_url: "https://cdn.example/audio.mp3" } },
        "/v1/audio/transcription-jobs",
      ],
    ] as const) {
      const r = await post(path, body);
      const raw = await r.json();
      expect(r.status, JSON.stringify(raw)).toBe(200);
      ids.push(`${poll}/${Created.parse(raw).request_id}`);
    }
    await server.dispose?.();
    server = await start();
    for (const path of ids) {
      const before = calls.length;
      expect((await server.app.request(path, { headers: headers("other") })).status).toBe(404);
      expect(calls).toHaveLength(before);
      const r = await server.app.request(path, { headers: headers() });
      expect(r.status, await r.text()).toBe(200);
    }
    vi.stubEnv("ALI_TEST_KEY", "rotated-fixture");
    const before = calls.length;
    expect((await server.app.request(ids[0] ?? "", { headers: headers() })).status).toBe(409);
    expect(calls).toHaveLength(before);
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});
