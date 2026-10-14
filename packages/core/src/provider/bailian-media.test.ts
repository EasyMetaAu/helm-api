import { describe, expect, it, vi } from "vitest";
import { createResponseWorkAdmission } from "../runtime/response-work-admission.js";
import { parseBailianShortAsrRequest } from "./bailian-asr.js";
import {
  createBailianMediaClient,
  normalizeBailianTask,
  normalizeBailianTranscription,
  normalizeBailianVideo,
  parseBailianCreated,
} from "./bailian-media.js";

const config = { baseUrl: "https://workspace.example.test/api/v1", apiKey: "offline-secret" };
const image = { model: "qwen-image-3.0-pro", prompt: "A bird", size: "1024x1024" };
const video = { model: "wan3.0-video", input: { prompt: "A bird" }, parameters: { duration: 5 } };
const accepted = { output: { task_id: "job-1", task_status: "PENDING" }, request_id: "req-1" };
const imageResult = {
  data: [{ url: "https://cdn.example.test/i.png" }],
  usage: { output_image_count: 1 },
};
function setup(response: () => Promise<Response>, capacityBytes = 4096) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(response);
  const admission = createResponseWorkAdmission({
    capacityBytes,
    jsonAmplification: 1,
    minChargeBytes: 1,
  });
  return {
    fetch,
    admission,
    client: createBailianMediaClient({ config, fetch, responseWorkAdmission: admission }),
  };
}

describe("Bailian media contracts", () => {
  it("retains an upstream task ID as recoverable evidence after malformed acceptance", async () => {
    const { client } = setup(async () =>
      Response.json({
        output: { task_id: "job-known", task_status: "NEW_STATUS" },
        message: "offline-secret",
      }),
    );
    const error = await client.videoGeneration(video).catch((e: unknown) => e);
    expect(error).toMatchObject({
      outcome: "unknown",
      providerRaw: {
        error: { code: "invalid_response" },
        response: { output: { task_id: "job-known" } },
      },
    });
    expect(JSON.stringify(error)).not.toContain("offline-secret");
  });
  it("uses the OpenAI images SDK on the same workspace host and preserves image extensions/usage", async () => {
    const { client, fetch } = setup(async () => Response.json(imageResult));
    const body = {
      ...image,
      image: ["https://cdn.example.test/ref.png"],
      seed: 7,
      watermark: false,
    };
    const capture = vi.fn();
    expect(await client.imageGeneration(body, { captureUpstream: capture })).toEqual(imageResult);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://workspace.example.test/compatible-mode/v1/images/generations",
    );
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(capture).toHaveBeenCalledWith(init?.body);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer offline-secret");
    expect(init?.redirect).toBe("manual");
  });
  it.each([
    { response_format: "b64_json" },
    { mask: "x" },
    { stream: true },
    { partial_images: 1 },
    { size: "256x256" },
    { size: "32x8192" },
    { image: [] },
    { image: Array(4).fill("https://cdn.example.test/ref.png") },
    { model: "qwen-image-2.1-pro", negative_prompt: "x" },
    { n: 7 },
    { image: "https://cdn.example.test/ref.png", prompt_extend_mode: "agent" },
  ])("rejects unsupported image options before sending: %j", async (change) => {
    const { client, fetch } = setup(async () => Response.json(imageResult));
    await expect(client.imageGeneration({ ...image, ...change })).rejects.toMatchObject({
      outcome: "not_sent",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("accepts ten references for the 2.1 image profile", async () => {
    const { client } = setup(async () => Response.json(imageResult));
    await expect(
      client.imageGeneration({
        ...image,
        model: "qwen-image-2.1-turbo",
        image: Array(10).fill("https://cdn.example.test/ref.png"),
      }),
    ).resolves.toEqual(imageResult);
  });
  it("uses native async Wan creation and bounded task polling without downloading artifacts", async () => {
    const result = {
      output: {
        task_id: "job-1",
        task_status: "SUCCEEDED",
        video_url: "https://cdn.example.test/v.mp4",
      },
      usage: { output_video_duration: 5 },
    };
    const { client, fetch } = setup(async () =>
      Response.json(fetch.mock.calls.length === 1 ? accepted : result),
    );
    expect(await client.videoGeneration(video)).toEqual(accepted);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${config.baseUrl}/services/aigc/video-generation/video-synthesis`,
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-dashscope-async")).toBe("enable");
    expect(await client.videoRetrieve("job-1")).toEqual(result);
    expect(String(fetch.mock.calls[1]?.[0])).toBe(`${config.baseUrl}/tasks/job-1`);
    expect(normalizeBailianTask(result, "video")).toMatchObject({
      id: "job-1",
      status: "succeeded",
      url: result.output.video_url,
      usage: result.usage,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves failed task status and refuses incomplete success or mismatched IDs", async () => {
    const failed = {
      output: {
        task_id: "job-1",
        task_status: "FAILED",
        code: "InvalidParameter",
        message: "bad input",
      },
    };
    const { client } = setup(async () => Response.json(failed));
    expect(normalizeBailianTask(await client.videoRetrieve("job-1"), "video").status).toBe(
      "failed",
    );
    const incomplete = setup(async () =>
      Response.json({ output: { task_id: "job-1", task_status: "SUCCEEDED" } }),
    );
    await expect(incomplete.client.videoRetrieve("job-1")).rejects.toMatchObject({
      outcome: "unknown",
    });
    await expect(client.videoRetrieve("different")).rejects.toMatchObject({ outcome: "unknown" });
  });
  it.each([
    { model: "wan2.6-t2v" },
    { parameters: { duration: 31 } },
    {
      input: {
        media: [
          { type: "first_frame", url: "https://cdn.example.test/i.png" },
          { type: "reference_audio", url: "https://cdn.example.test/a.mp3" },
        ],
      },
    },
  ])("rejects unsupported Wan profiles and combinations: %j", async (change) => {
    const { client, fetch } = setup(async () => Response.json(accepted));
    await expect(client.videoGeneration({ ...video, ...change })).rejects.toMatchObject({
      outcome: "not_sent",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps per-file ASR failures and usage; never downloads result URLs", async () => {
    const result = {
      output: {
        task_id: "job-1",
        task_status: "SUCCEEDED",
        results: [
          {
            file_url: "https://cdn.example.test/a.mp3",
            subtask_status: "SUCCEEDED",
            transcription_url: "https://cdn.example.test/a.json",
          },
          {
            file_url: "https://cdn.example.test/b.mp3",
            subtask_status: "FAILED",
            code: "InvalidFile",
            message: "invalid audio",
          },
        ],
      },
      usage: { duration: 12 },
    };
    const { client, fetch } = setup(async () =>
      Response.json(fetch.mock.calls.length === 1 ? accepted : result),
    );
    const body = {
      model: "qwen-audio-3.1-asr-flash-filetrans",
      input: { file_urls: ["https://cdn.example.test/a.mp3"] },
      parameters: { channel_id: [0], language_hints: ["zh", "en"] },
    };
    expect(await client.transcriptionCreate(body)).toEqual(accepted);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${config.baseUrl}/services/audio/asr/transcription`,
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(body);
    const raw = await client.transcriptionRetrieve("job-1");
    expect(raw).toEqual(result);
    expect(normalizeBailianTask(raw, "transcription")).toMatchObject({
      status: "partial",
      results: result.output.results,
      usage: result.usage,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("handles the distinct Qwen3 filetrans single-file contract", async () => {
    const result = {
      output: {
        task_id: "job-1",
        task_status: "SUCCEEDED",
        result: { transcription_url: "https://cdn.example.test/a.json" },
      },
      usage: { seconds: 8 },
    };
    const { client } = setup(async () => Response.json(result));
    expect(
      await client.transcriptionCreate({
        model: "qwen3-asr-flash-filetrans",
        input: { file_url: "https://cdn.example.test/a.mp3" },
      }),
    ).toEqual(result);
    expect(normalizeBailianTask(result, "transcription")).toMatchObject({
      status: "succeeded",
      results: [result.output.result],
      usage: { seconds: 8 },
    });
    await expect(
      client.transcriptionCreate({
        model: "qwen3-asr-flash-filetrans",
        input: { file_urls: ["https://cdn.example.test/a.mp3"] },
      }),
    ).rejects.toMatchObject({ outcome: "not_sent" });
  });
  it("gateway normalization validates IDs and any returned model without inventing expiry", () => {
    const result = {
      output: {
        task_id: "job-1",
        task_status: "SUCCEEDED",
        video_url: "https://cdn.example.test/v.mp4",
      },
    };
    expect(parseBailianCreated(accepted)).toBe("job-1");
    expect(parseBailianCreated({ output: { task_id: "job-1" } })).toBeNull();
    expect(normalizeBailianVideo(result, "job-1", "wan3.0-video")).toMatchObject({
      status: "done",
      video: { url: result.output.video_url },
    });
    expect(normalizeBailianVideo(result, "job-2", "wan3.0-video")).toBeNull();
    expect(
      normalizeBailianVideo({ ...result, model: "wrong" }, "job-1", "wan3.0-video"),
    ).toBeNull();
    expect(
      normalizeBailianVideo(
        { output: { task_id: "job-1", task_status: "UNKNOWN" } },
        "job-1",
        "wan3.0-video",
      ),
    ).toBeNull();
    expect(
      normalizeBailianTranscription(
        {
          output: {
            task_id: "job-1",
            task_status: "SUCCEEDED",
            results: [{ subtask_status: "FAILED", code: "InvalidFile" }],
          },
        },
        "job-1",
        "fun-asr",
      ),
    ).toMatchObject({ status: "failed" });
  });
});

describe("short ASR Chat profile", () => {
  it.each([
    "https://cdn.example.test/a.mp3",
    "data:audio/wav;base64,UklGRg==",
  ])("preserves input_audio and ASR options without inventing format for %s", (data) => {
    const body = {
      model: "qwen3-asr-flash",
      messages: [
        { role: "system", content: "Names: Alice" },
        { role: "user", content: [{ type: "input_audio", input_audio: { data } }] },
      ],
      asr_options: { language: "en", enable_itn: false },
      stream: true,
      stream_options: { include_usage: true },
    };
    expect(parseBailianShortAsrRequest(body)).toEqual(body);
  });
  it("rejects ordinary Chat, invalid data, and inactive stream_options", () => {
    expect(() =>
      parseBailianShortAsrRequest({
        model: "qwen3-asr-flash",
        messages: [{ role: "user", content: "text" }],
      }),
    ).toThrow();
    for (const data of ["UklGRg==", "data:audio/wav;base64,%%%", "file:///tmp/a.mp3"]) {
      expect(() =>
        parseBailianShortAsrRequest({
          model: "qwen3-asr-flash",
          messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data } }] }],
        }),
      ).toThrow();
    }
  });
});
