import { describe, expect, it } from "vitest";
import { CapabilitiesSchema } from "../catalog/schema.js";
import {
  VideoGenerationRequestSchema,
  VideoGenerationResponseSchema,
  VideoRetrieveResponseSchema,
} from "./videos-schema.js";

describe("VideoGenerationRequestSchema", () => {
  it("accepts the single-image Grok video contract, including an empty prompt", () => {
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video-1.5-preview",
        prompt: "",
        image: { url: "data:image/png;base64,AAA=" },
        duration: 6,
        resolution: "480p",
      }).success,
    ).toBe(true);
  });

  it("accepts 2-7 reference images for the multi-image contract", () => {
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video",
        prompt: "make them move",
        reference_images: [
          { url: "https://example.test/one.png" },
          { url: "https://example.test/two.png" },
        ],
        aspect_ratio: "16:9",
        duration: 10,
        resolution: "720p",
      }).success,
    ).toBe(true);
  });

  it("rejects unsupported shapes and ZDR output instead of silently forwarding them", () => {
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
        model: "grok-imagine-video-1.5-preview",
        prompt: "wrong model for references",
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
        model: "grok-imagine-video-1.5-preview",
        prompt: "",
        image: { url: "https://example.test/image.png" },
        duration: 5,
        resolution: "480p",
      }).success,
    ).toBe(false);
    expect(
      VideoGenerationRequestSchema.safeParse({
        model: "grok-imagine-video",
        prompt: "x",
        reference_images: [{ url: "https://example.test/one.png" }],
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
