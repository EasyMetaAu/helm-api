import { describe, expect, it, vi } from "vitest";
import {
  createMiniMaxVideoClient,
  normalizeMiniMaxVideo,
  normalizeMiniMaxVideoTask,
  parseMiniMaxVideoCreated,
} from "./minimax-video.js";

const config = { baseUrl: "https://api.example.test", apiKey: "offline-secret" };
const body = {
  model: "MiniMax-H3",
  content: [{ type: "text", text: "A bird" }],
  resolution: "2K",
  duration: 4,
  ratio: "16:9",
};
describe("MiniMax v2 video", () => {
  it("checks the pinned model and task ID at the gateway boundary", () => {
    const raw = { task: { id: "job-1", model: "MiniMax-H3", status: "running" } };
    expect(normalizeMiniMaxVideo(raw, "job-1", "MiniMax-H3")).toMatchObject({
      status: "in_progress",
    });
    expect(normalizeMiniMaxVideo(raw, "job-1", "MiniMax-H3-Max")).toBeNull();
    expect(normalizeMiniMaxVideo(raw, "job-2", "MiniMax-H3")).toBeNull();
    expect(
      normalizeMiniMaxVideo({ task: { id: "job-1", status: "running" } }, "job-1", "MiniMax-H3"),
    ).toBeNull();
    expect(parseMiniMaxVideoCreated({ task_id: "job-1" })).toBe("job-1");
    expect(parseMiniMaxVideoCreated({ id: "job-1" })).toBeNull();
  });
  it("creates once and queries v2 native task envelopes with real usage", async () => {
    const result = {
      task: {
        id: "job-1",
        model: "MiniMax-H3",
        status: "succeeded",
        content: { url: "https://cdn.example.test/v.mp4" },
        usage: { total_seconds: 4, input_seconds: 0, output_seconds: 4 },
      },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ task_id: "job-1" }))
      .mockResolvedValueOnce(Response.json(result));
    const client = createMiniMaxVideoClient({ config, fetch });
    expect(await client.videoGeneration(body)).toEqual({ task_id: "job-1" });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${config.baseUrl}/v2/video_generation`);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(body);
    expect(await client.videoRetrieve("job-1")).toEqual(result);
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      `${config.baseUrl}/v2/query/video_generation/job-1`,
    );
    expect(normalizeMiniMaxVideoTask(result)).toMatchObject({
      id: "job-1",
      status: "succeeded",
      url: result.task.content.url,
      usage: result.task.usage,
    });
  });
  it.each([
    { model: "MiniMax-H3-Max" },
    { model: "MiniMax-Hailuo-02" },
    { resolution: "480P" },
    { ratio: "adaptive" },
    { extra: { prompt_expansion_mode: "quality" } },
    {
      content: [
        { type: "text", text: "Bird" },
        {
          type: "image_url",
          image_url: { url: "https://cdn.example.test/i.png" },
          role: "first_frame",
        },
        {
          type: "audio_url",
          audio_url: { url: "https://cdn.example.test/a.mp3" },
          role: "reference_audio",
        },
      ],
    },
  ])("rejects model-specific invalid input without silent model substitution: %j", async (change) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createMiniMaxVideoClient({ config, fetch }).videoGeneration({ ...body, ...change }),
    ).rejects.toMatchObject({ outcome: "not_sent" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("supports Max reference audio with native extra options", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ task_id: "job-1" }));
    await createMiniMaxVideoClient({ config, fetch }).videoGeneration({
      ...body,
      model: "MiniMax-H3-Max",
      resolution: "480P",
      duration: 5,
      content: [
        ...body.content,
        {
          type: "audio_url",
          audio_url: { url: "https://cdn.example.test/a.mp3" },
          role: "reference_audio",
        },
      ],
      extra: { prompt_expansion_mode: "quality" },
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe("MiniMax-H3-Max");
  });
  it("returns failed tasks, rejects malformed successes and mismatched query IDs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      Response.json({
        task: {
          id: "job-1",
          status: "failed",
          error: { code: "moderation", message: "blocked" },
        },
      }),
    );
    const client = createMiniMaxVideoClient({ config, fetch });
    expect(normalizeMiniMaxVideoTask(await client.videoRetrieve("job-1")).status).toBe("failed");
    await expect(client.videoRetrieve("job-2")).rejects.toMatchObject({ outcome: "unknown" });
    expect(() =>
      normalizeMiniMaxVideoTask({ task: { id: "job-1", status: "succeeded" } }),
    ).toThrow();
  });
});
