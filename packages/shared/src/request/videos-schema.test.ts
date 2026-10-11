import { describe, expect, it } from "vitest";
import { CapabilitiesSchema } from "../catalog/schema.js";
import {
  VideoExtensionRequestSchema,
  VideoGenerationRequestSchema,
  VideoGenerationResponseSchema,
  VideoRetrieveResponseSchema,
} from "./videos-schema.js";

describe("VideoGenerationRequestSchema", () => {
  const pinned = {
    model: "grok-imagine-video-1.5",
    image: { url: "data:image/png;base64,AAA=" },
    last_frame: { url: "https://example.test/end.png" },
    reference_audios: [{ voice_id: "eve" }],
    duration: 12,
    resolution: "720p",
  };

  it.each([
    "grok-imagine-video-1.5",
    "xai/grok-imagine-video-1.5",
  ])("accepts official pinned endpoints with a voice and optional prompt for %s", (model) => {
    for (const prompt of [undefined, "", "Speak with <AUDIO_0>"]) {
      const body = { ...pinned, model, ...(prompt === undefined ? {} : { prompt }) };
      expect(VideoGenerationRequestSchema.parse(body)).toEqual(body);
    }
  });

  it("accepts first-only and last-only pins combined with reference images and voice", () => {
    for (const pin of ["image", "last_frame"]) {
      const { image, last_frame, ...base } = pinned;
      const body = {
        ...base,
        [pin]: pin === "image" ? image : last_frame,
        reference_images: [{ url: "https://example.test/person.png" }],
      };
      expect(VideoGenerationRequestSchema.parse(body)).toEqual(body);
    }
  });

  it("supports the existing images alias with frame pins without accepting ambiguous aliases", () => {
    const body = { ...pinned, images: [{ url: "https://example.test/person.png" }] };
    expect(VideoGenerationRequestSchema.parse(body)).toEqual(body);
    expect(
      VideoGenerationRequestSchema.safeParse({ ...body, reference_images: body.images }).success,
    ).toBe(false);
  });

  it("rejects invalid new frame combinations before any paid request", () => {
    const { image, last_frame, ...noPins } = pinned;
    for (const body of [
      noPins,
      { ...pinned, model: "grok-imagine-video" },
      { ...pinned, model: "grok-imagine-video-1.5-preview" },
      { ...pinned, last_frame: { url: "" } },
      { ...pinned, last_frame: { url: "x", unknown: true } },
      { ...pinned, duration: 30 },
      { ...pinned, resolution: "1080p" },
      { ...pinned, reference_audios: [{ url: "https://example.test/private.wav" }] },
      { ...pinned, reference_audios: [{ voice_id: " " }] },
      { ...pinned, reference_audios: Array.from({ length: 4 }, () => ({ voice_id: "eve" })) },
      { ...pinned, reference_images: [] },
      { ...pinned, output: { upload_url: "https://example.test/upload" } },
    ])
      expect(VideoGenerationRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([1, 8, 15, 30])("accepts duration %s across every generation shape", (duration) => {
    const bodies = [
      { model: "grok-imagine-video", prompt: "waves", duration },
      {
        model: "grok-imagine-video-1.5",
        prompt: "move",
        image: { url: "https://example.test/source.png" },
        duration,
        resolution: "720p",
      },
      {
        model: "grok-imagine-video-1.5",
        prompt: "connect <IMAGE_0> and <IMAGE_1>",
        reference_images: [
          { url: "https://example.test/one.png" },
          { url: "https://example.test/two.png" },
        ],
        aspect_ratio: "16:9",
        duration,
        resolution: "720p",
      },
      {
        model: "grok-imagine-video-1.5",
        prompt: "connect <IMAGE_0> and <IMAGE_1>",
        images: [{ url: "https://example.test/one.png" }, { url: "https://example.test/two.png" }],
        aspect_ratio: "16:9",
        duration,
        resolution: "720p",
      },
    ];

    for (const body of bodies)
      expect(VideoGenerationRequestSchema.safeParse(body).success).toBe(true);
  });

  it("accepts the minimal Sub2API-compatible prompt-only video contract", () => {
    for (const model of ["grok-imagine-video", "xai/grok-imagine-video"]) {
      expect(
        VideoGenerationRequestSchema.safeParse({
          model,
          prompt: "waves rolling across a neon ocean",
        }).success,
      ).toBe(true);
    }
  });

  it("accepts prompt-only video options", () => {
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video",
        prompt: "waves rolling across a neon ocean",
        aspect_ratio: "16:9",
        duration: 15,
        resolution: "1080p",
        audio: true,
      }).success,
    ).toBe(true);
  });

  it("accepts the official single-image options, including an empty prompt", () => {
    for (const model of [
      "grok-imagine-video-1.5-preview",
      "xai/grok-imagine-video-1.5-preview",
      "grok-imagine-video-1.5",
      "xai/grok-imagine-video-1.5",
    ]) {
      expect(
        VideoGenerationRequestSchema.safeParse({
          model,
          prompt: "",
          image: { url: "data:image/png;base64,AAA=" },
          aspect_ratio: "4:3",
          duration: 12,
          resolution: "1080p",
        }).success,
      ).toBe(true);
    }
  });

  it("accepts one reference image with aspect ratio and a preset voice", () => {
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video-1.5",
        prompt: "have <IMAGE_0> speak with <AUDIO_0>",
        reference_images: [{ url: "https://example.test/one.png" }],
        reference_audios: [{ voice_id: "eve" }],
        aspect_ratio: "3:4",
        duration: 8,
        resolution: "720p",
      }).success,
    ).toBe(true);
  });

  it("rejects unsupported shapes and ZDR output instead of silently forwarding them", () => {
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video-1.5-preview",
        prompt: "text only is unsupported by the image-to-video model",
        duration: 6,
        resolution: "480p",
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video-1.5",
        prompt: "too many voices",
        reference_images: [{ url: "https://example.test/one.png" }],
        reference_audios: ["ara", "eve", "leo", "rex"].map((voice_id) => ({ voice_id })),
        aspect_ratio: "16:9",
        duration: 6,
        resolution: "480p",
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video",
        prompt: "unsupported duration",
        duration: 16,
        resolution: "720p",
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video",
        prompt: "wrong model for one image",
        image: { url: "https://example.test/image.png" },
        duration: 6,
        resolution: "480p",
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video",
        prompt: "base model is wrong for references",
        reference_images: [
          { url: "https://example.test/one.png" },
          { url: "https://example.test/two.png" },
        ],
        aspect_ratio: "16:9",
        duration: 6,
        resolution: "480p",
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video-1.5",
        prompt: "x",
        reference_images: [],
        aspect_ratio: "16:9",
        duration: 6,
        resolution: "480p",
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video-1.5",
        prompt: "x",
        reference_images: [{ url: "https://example.test/one.png" }],
        reference_audios: [{ voice_id: "" }],
        aspect_ratio: "16:9",
        duration: 6,
        resolution: "480p",
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video-1.5-preview",
        prompt: "",
        image: { url: "https://example.test/image.png" },
        duration: 6,
        resolution: "480p",
        output: { upload_url: "https://example.test/upload" },
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video-1.5",
        prompt: "ambiguous references",
        reference_images: [
          { url: "https://example.test/one.png" },
          { url: "https://example.test/two.png" },
        ],
        images: [
          { url: "https://example.test/three.png" },
          { url: "https://example.test/four.png" },
        ],
        aspect_ratio: "16:9",
        duration: 30,
        resolution: "720p",
      }).success,
    ).toBe(false);
  });
});

describe("VideoExtensionRequestSchema", () => {
  it.each([
    "grok-imagine-video",
    "xai/grok-imagine-video",
  ])("accepts the strict extension contract for %s", (model) => {
    expect(
      VideoExtensionRequestSchema.safeParse({
        model,
        prompt: "continue the camera movement",
        video: { url: "https://example.test/source.mp4" },
        duration: 30,
      }).success,
    ).toBe(true);
  });

  it.each([
    { prompt: "", video: { url: "https://example.test/source.mp4" }, duration: 30 },
    { prompt: "continue", video: { url: "" }, duration: 30 },
    { prompt: "continue", video: { url: "https://example.test/source.mp4" }, duration: 29 },
    {
      prompt: "continue",
      video: { url: "https://example.test/source.mp4" },
      duration: 30,
      output: { upload_url: "https://example.test/upload" },
    },
  ])("rejects an invalid extension shape", (fields) => {
    expect(
      VideoExtensionRequestSchema.safeParse({ model: "grok-imagine-video", ...fields }).success,
    ).toBe(false);
  });
});

describe("video response schemas", () => {
  it("requires a non-empty upstream request id from a start response", () => {
    expect(VideoGenerationResponseSchema.safeParse({ request_id: "req_123" }).success).toBe(true);
    expect(VideoGenerationResponseSchema.safeParse({ request_id: "" }).success).toBe(false);
  });

  it("accepts 202 poll bodies and preserves unknown statuses", () => {
    const parsed = VideoRetrieveResponseSchema.safeParse({ status: "processing", progress: 40 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.progress).toBe(40);
    expect(VideoRetrieveResponseSchema.safeParse({ status: 202 }).success).toBe(false);
  });

  it("requires a non-blank video URL for a completed task", () => {
    expect(
      VideoRetrieveResponseSchema.safeParse({
        status: "done",
        video: { url: "https://cdn.example.test/video.mp4" },
      }).success,
    ).toBe(true);
    expect(VideoRetrieveResponseSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(
      VideoRetrieveResponseSchema.safeParse({ status: "done", video: { url: "  " } }).success,
    ).toBe(false);
    expect(VideoRetrieveResponseSchema.safeParse({ status: " " }).success).toBe(false);
  });
});

describe("video catalog capability", () => {
  it("retains explicit outputVideo independently from input modalities", () => {
    const parsed = CapabilitiesSchema.parse({
      supportsTools: false,
      jsonOutput: "none",
      supportsVision: false,
      supportsStreaming: false,
      modalities: ["video"],
      outputVideo: true,
      maxContextTokens: 0,
      maxOutputTokens: null,
    });
    expect(parsed.outputVideo).toBe(true);
  });
});
