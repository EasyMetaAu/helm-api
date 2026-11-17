import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteDb, hashKey, SqliteKeyStore } from "@helm/core";
import { expect, it, vi } from "vitest";
import { buildServer, type ServerHandle } from "./server.js";

const { download, transcript } = vi.hoisted(() => {
  const transcript = {
    transcripts: [
      {
        text: "你好。",
        sentences: [
          {
            begin_time: 10,
            end_time: 300,
            text: "你好。",
            words: [{ begin_time: 10, end_time: 300, text: "你好", punctuation: "。" }],
          },
        ],
      },
    ],
  };
  return { transcript, download: vi.fn(async () => transcript) };
});
vi.mock("@helm/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@helm/core")>();
  return {
    ...core,
    materializeBailianTranscription: (value: Record<string, unknown>, signal?: AbortSignal) =>
      core.materializeBailianTranscription(value, signal, download),
  };
});

it("serves Fun-ASR jobs with hotwords, word timing, lane permissions and operation recovery", async () => {
  // Existing isolated SQLite migration review: docs/g4-speech-media-ci-sql-review.md.
  // All data is synthetic; HTTP and result downloads are stubbed before server startup.
  const dir = await mkdtemp(join(tmpdir(), "helm-fun-asr-"));
  const db = createSqliteDb(join(dir, "helm.db"));
  const keys = new SqliteKeyStore(db);
  let server: ServerHandle | undefined;
  let createFailure = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith("/services/audio/asr/transcription")) {
      if (createFailure) throw new Error("response lost");
      return Response.json({ output: { task_id: "task-1", task_status: "PENDING" } });
    }
    if (String(url).endsWith("/tasks/task-1") && init?.method === "GET") {
      return Response.json({
        output: {
          task_id: "task-1",
          task_status: "SUCCEEDED",
          results: [
            { subtask_status: "SUCCEEDED", transcription_url: "https://cdn.example/result.json" },
          ],
        },
        usage: { duration: 1 },
      });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  try {
    await cp(resolve("config"), join(dir, "config"), { recursive: true });
    for (const [keyId, lane] of [
      ["owner", "transcription-fun-asr"],
      ["other", "transcription-fun-asr"],
      ["denied", "balanced"],
    ] as const) {
      await keys.createKey({
        keyId,
        hash: hashKey(`fixture-${keyId}`),
        prefix: "fixture",
        accountId: "fixture",
        role: "user",
        allowCustomModel: false,
        allowedLanes: [lane],
      });
    }
    for (const [key, value] of Object.entries({
      BAILIAN_API_KEY: "fixture-bailian",
      HELM_DATA_DIR: dir,
      HELM_SIGNALS_DISABLED: "1",
      HELM_OAUTH_ENC_KEY: "11".repeat(32),
      HELM_AUTH_CACHE_TTL_MS: "0",
    }))
      vi.stubEnv(key, value);
    vi.stubGlobal("fetch", fetch);
    server = await buildServer({
      configDir: join(dir, "config"),
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: { log: () => {} },
    });
    const root = "/v1/audio/transcription-jobs";
    const app = server.app;
    const headers = (key = "owner") => ({
      authorization: `Bearer fixture-${key}`,
      "content-type": "application/json",
    });
    const request = {
      model: "transcription-fun-asr",
      input: { file_urls: ["https://cdn.example/audio.mp4"] },
      parameters: { vocabulary: { 阿里巴巴: 4 }, language_hints: ["zh"] },
    };
    const post = (body: unknown, key = "owner") =>
      app.request(root, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify(body),
      });
    for (const parameters of [
      { vocabulary: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`词${i}`, 4])) },
      { vocabulary: { ["中".repeat(16)]: 4 } },
      { vocabulary: { 阿里巴巴: 0 } },
    ]) {
      const response = await post({ ...request, parameters });
      expect(response.status, await response.text()).toBe(400);
    }
    expect((await post(request, "denied")).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    const created = await post(request);
    expect(created.status).toBe(200);
    const { request_id } = (await created.json()) as { request_id: string };
    expect(request_id).toBeTruthy();
    expect(request_id).not.toBe("task-1");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      ...request,
      model: "fun-asr",
    });
    expect(
      (await server.app.request(`${root}/${request_id}`, { headers: headers("other") })).status,
    ).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
    const polled = await server.app.request(`${root}/${request_id}`, { headers: headers() });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({
      request_id,
      status: "done",
      usage: { type: "duration", seconds: 1, duration: 1 },
      transcription: { results: [{ transcript }], partial_failure: false },
    });
    await keys.updateKey("owner", { allowedLanes: ["balanced"] });
    const before = fetch.mock.calls.length;
    expect((await server.app.request(`${root}/${request_id}`, { headers: headers() })).status).toBe(
      403,
    );
    expect(fetch).toHaveBeenCalledTimes(before);
    await keys.updateKey("owner", { allowedLanes: ["transcription-fun-asr"] });
    createFailure = true;
    const unknown = await post(request);
    expect(unknown.status).toBe(503);
    const { error } = (await unknown.json()) as { error: { code: string; operation_id: string } };
    expect(error.code).toBe("outcome_unknown");
    const operation = await server.app.request(`${root}/operations/${error.operation_id}`, {
      headers: headers(),
    });
    expect(operation.status).toBe(200);
    expect(await operation.json()).toMatchObject({
      state: "outcome_unknown",
      upstream_task_known: false,
    });
    expect(fetch).toHaveBeenCalledTimes(before + 1);
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});
