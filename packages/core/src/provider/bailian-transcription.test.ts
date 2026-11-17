import { describe, expect, it, vi } from "vitest";
import {
  createBailianMediaClient,
  materializeBailianTranscription,
  normalizeBailianTranscription,
} from "./bailian-media.js";

const config = { baseUrl: "https://dashscope.example/api/v1", apiKey: "fixture-key" };
const accepted = { output: { task_id: "task-1", task_status: "PENDING" } };
const body = {
  model: "fun-asr",
  input: { file_urls: ["https://cdn.example/audio.mp4?signature=a%2Bb"] },
  parameters: { vocabulary: { 阿里巴巴: 4 }, language_hints: ["zh"] },
};
// Synthetic fixture using the documented Fun-ASR/Paraformer result-file shape.
const transcript = {
  file_url: body.input.file_urls[0],
  properties: { original_duration_in_milliseconds: 9000 },
  transcripts: [
    {
      channel_id: 0,
      content_duration_in_milliseconds: 1500,
      text: "你好，阿里巴巴。",
      sentences: [
        {
          begin_time: 100,
          end_time: 1600,
          text: "你好，阿里巴巴。",
          sentence_id: 1,
          speaker_id: 0,
          words: [
            { begin_time: 100, end_time: 500, text: "你好", punctuation: "，" },
            {
              begin_time: 700,
              end_time: 1600,
              text: "阿里巴巴",
              punctuation: "。",
              confidence: 0.98,
            },
          ],
        },
      ],
    },
  ],
};
const completed = {
  output: {
    task_id: "task-1",
    task_status: "SUCCEEDED",
    results: [
      {
        file_url: body.input.file_urls[0],
        subtask_status: "SUCCEEDED",
        transcription_url: "https://cdn.example/result.json",
      },
    ],
  },
  usage: { duration: 2 },
};

describe("Bailian recorded-file transcription", () => {
  it.each(["fun-asr", "paraformer-v2"])("maps %s to the native async protocol", async (model) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(accepted));
    const client = createBailianMediaClient({ config, fetch });
    const request = { ...body, model, parameters: { vocabulary_id: "vocab-fixture" } };
    expect(await client.transcriptionCreate(request)).toEqual(accepted);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${config.baseUrl}/services/audio/asr/transcription`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-DashScope-Async")).toBe("enable");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-key");
    expect(JSON.parse(String(init?.body))).toEqual(request);
    await client.transcriptionRetrieve("task-1");
    expect(fetch.mock.calls[1]?.[0]).toBe(`${config.baseUrl}/tasks/task-1`);
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("GET");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("forwards inline hotwords unchanged and sends empty parameters when omitted", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(accepted));
    const client = createBailianMediaClient({ config, fetch });
    await client.transcriptionCreate(body);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(body);
    await client.transcriptionCreate({ model: body.model, input: body.input });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      model: body.model,
      input: body.input,
      parameters: {},
    });
  });

  it.each([400, 401, 429, 500, 503])("never retries create after HTTP %s", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ code: "UpstreamError" }, { status }),
    );
    await expect(
      createBailianMediaClient({ config, fetch }).transcriptionCreate(body),
    ).rejects.toMatchObject({
      outcome: status < 500 ? "rejected" : "unknown",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not send invalid vocabulary", async () => {
    const fetch = vi.fn();
    await expect(
      createBailianMediaClient({ config, fetch }).transcriptionCreate({
        ...body,
        parameters: { vocabulary: { ["中".repeat(16)]: 4 } },
      }),
    ).rejects.toMatchObject({ outcome: "not_sent" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["PENDING", "queued"],
    ["RUNNING", "in_progress"],
    ["FAILED", "failed"],
    ["CANCELED", "cancelled"],
  ])("maps %s to %s", (task_status, status) => {
    expect(
      normalizeBailianTranscription(
        {
          output: {
            task_id: "task-1",
            task_status,
            ...(task_status === "FAILED"
              ? { code: "InvalidFile", message: "Unreadable file" }
              : {}),
          },
        },
        "task-1",
        "fun-asr",
      ),
    ).toMatchObject({
      status,
      ...(task_status === "FAILED"
        ? { error: { code: "InvalidFile", message: "Unreadable file" } }
        : {}),
    });
  });

  it("rejects UNKNOWN, mismatched identity and malformed success", () => {
    expect(
      normalizeBailianTranscription(
        { output: { task_id: "task-1", task_status: "UNKNOWN" } },
        "task-1",
        "fun-asr",
      ),
    ).toBeNull();
    expect(normalizeBailianTranscription(completed, "other", "fun-asr")).toBeNull();
    expect(
      normalizeBailianTranscription({ ...completed, model: "other" }, "task-1", "fun-asr"),
    ).toBeNull();
    expect(
      normalizeBailianTranscription(
        {
          output: {
            task_id: "task-1",
            task_status: "SUCCEEDED",
            results: [{ subtask_status: "SUCCEEDED" }],
          },
        },
        "task-1",
        "fun-asr",
      ),
    ).toBeNull();
  });

  it.each([
    "fun-asr",
    "paraformer-v2",
  ])("preserves every word and meters provider duration for %s", async (model) => {
    const download = vi.fn(async () => transcript);
    const raw = await materializeBailianTranscription(completed, undefined, download);
    const result = normalizeBailianTranscription(raw, "task-1", model);
    expect(result).toMatchObject({
      status: "done",
      usage: { type: "duration", seconds: 2, duration: 2 },
    });
    expect(result?.transcription.results?.[0]?.transcript).toEqual(transcript);
    expect(download).toHaveBeenCalledWith("https://cdn.example/result.json", { signal: undefined });
  });

  it("preserves partial failures and fetches only successful files", async () => {
    const download = vi.fn(async () => transcript);
    const raw = await materializeBailianTranscription(
      {
        ...completed,
        output: {
          ...completed.output,
          results: [
            ...completed.output.results,
            { subtask_status: "FAILED", code: "InvalidFile", message: "Unreadable file" },
          ],
        },
      },
      undefined,
      download,
    );
    expect(normalizeBailianTranscription(raw, "task-1", "fun-asr")).toMatchObject({
      status: "done",
      transcription: {
        partial_failure: true,
        upstream_status: "partial",
        results: [
          expect.any(Object),
          { subtask_status: "FAILED", code: "InvalidFile", message: "Unreadable file" },
        ],
      },
    });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    {},
    { error: "download failed" },
    { transcripts: [{ text: 7 }] },
    {
      transcripts: [
        {
          text: "hello",
          sentences: [
            {
              begin_time: 0,
              end_time: 1,
              text: "hello",
              words: [{ begin_time: "0", end_time: 1, text: "hello" }],
            },
          ],
        },
      ],
    },
  ])("rejects malformed transcript JSON (case %#)", async (value) => {
    await expect(
      materializeBailianTranscription(completed, undefined, async () => value),
    ).rejects.toThrow();
  });

  it("propagates download failure and never fetches failed tasks", async () => {
    const download = vi.fn(async () => {
      throw new Error("unavailable result");
    });
    await expect(materializeBailianTranscription(completed, undefined, download)).rejects.toThrow(
      "unavailable result",
    );
    download.mockClear();
    const failed = { output: { task_id: "task-1", task_status: "FAILED", code: "InvalidFile" } };
    expect(await materializeBailianTranscription(failed, undefined, download)).toEqual(failed);
    expect(download).not.toHaveBeenCalled();
  });

  it("never infers billable seconds from timestamps and rejects invalid duration", () => {
    const { usage: _, ...withoutUsage } = completed;
    expect(normalizeBailianTranscription(withoutUsage, "task-1", "fun-asr")?.usage).toBeUndefined();
    for (const duration of [-1, "2", Number.NaN]) {
      expect(
        normalizeBailianTranscription({ ...completed, usage: { duration } }, "task-1", "fun-asr"),
      ).toBeNull();
    }
    expect(
      normalizeBailianTranscription({ ...completed, usage: { duration: 0 } }, "task-1", "fun-asr")
        ?.usage,
    ).toMatchObject({ seconds: 0 });
  });
});
