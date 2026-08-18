import { describe, expect, it } from "vitest";
import {
  GrokImagineImageGenerationRequestSchema,
  ImageEditRequestSchema,
  ImageGenerationRequestSchema,
  ImageGenerationResponseSchema,
} from "./images-schema.js";

describe("ImageEditRequestSchema", () => {
  it("accepts Grok single-image and multi-reference URL carriers", () => {
    expect(
      ImageEditRequestSchema.safeParse({
        model: "grok-imagine-image-quality",
        prompt: "restyle",
        image: { url: "data:image/png;base64,AAA=" },
      }).success,
    ).toBe(true);
    expect(
      ImageEditRequestSchema.safeParse({
        model: "grok-imagine-image-quality",
        prompt: "combine",
        images: [{ url: "https://example.test/a.png" }, { url: "https://example.test/b.png" }],
      }).success,
    ).toBe(true);
  });

  it("accepts the Codex JSON image_url carrier", () => {
    expect(
      ImageEditRequestSchema.safeParse({
        model: "gpt-image-2",
        prompt: "add a hat",
        images: [{ image_url: "data:image/png;base64,AAA=" }],
      }).success,
    ).toBe(true);
  });

  it("requires at least one image", () => {
    expect(
      ImageEditRequestSchema.safeParse({ model: "gpt-image-2", prompt: "add a hat", images: [] })
        .success,
    ).toBe(false);
  });
});

describe("ImageGenerationRequestSchema", () => {
  it("parses a minimal {model, prompt}", () => {
    expect(
      ImageGenerationRequestSchema.safeParse({ model: "gpt-image-2", prompt: "a cat" }).success,
    ).toBe(true);
  });

  it("requires a non-empty model and prompt", () => {
    expect(ImageGenerationRequestSchema.safeParse({ model: "gpt-image-2" }).success).toBe(false);
    expect(ImageGenerationRequestSchema.safeParse({ prompt: "a cat" }).success).toBe(false);
    expect(ImageGenerationRequestSchema.safeParse({ model: "", prompt: "a cat" }).success).toBe(
      false,
    );
    expect(
      ImageGenerationRequestSchema.safeParse({ model: "gpt-image-2", prompt: "" }).success,
    ).toBe(false);
  });

  it("accepts the optional generation params", () => {
    const r = ImageGenerationRequestSchema.safeParse({
      model: "gpt-image-2",
      prompt: "x",
      n: 1,
      size: "1024x1024",
      quality: "high",
      response_format: "b64_json",
    });
    expect(r.success).toBe(true);
  });

  it("passes through unknown fields verbatim (loose object)", () => {
    const r = ImageGenerationRequestSchema.safeParse({
      model: "gpt-image-2",
      prompt: "x",
      style: "vivid",
      moderation: "low",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).style).toBe("vivid");
      expect((r.data as Record<string, unknown>).moderation).toBe("low");
    }
  });
});

describe("GrokImagineImageGenerationRequestSchema", () => {
  it("accepts only the proven prompt-only fast-image contract", () => {
    expect(
      GrokImagineImageGenerationRequestSchema.safeParse({
        model: "grok-imagine-image",
        prompt: "a cat",
      }).success,
    ).toBe(true);
    expect(
      GrokImagineImageGenerationRequestSchema.safeParse({
        model: "grok-imagine-image",
        prompt: "a cat",
        n: 4,
        aspect_ratio: "16:9",
        resolution: "1k",
        response_format: "b64_json",
      }).success,
    ).toBe(false);
    expect(
      GrokImagineImageGenerationRequestSchema.safeParse({
        model: "grok-imagine-image-quality",
        prompt: "a cat",
      }).success,
    ).toBe(false);
  });

  it("rejects unverified Grok web image fields before a paid create", () => {
    expect(
      GrokImagineImageGenerationRequestSchema.safeParse({
        model: "grok-imagine-image",
        prompt: "a cat",
        n: 5,
      }).success,
    ).toBe(false);
    expect(
      GrokImagineImageGenerationRequestSchema.safeParse({
        model: "grok-imagine-image",
        prompt: "a cat",
        resolution: "2k",
      }).success,
    ).toBe(false);
  });
});

describe("ImageGenerationResponseSchema", () => {
  it("accepts the OpenAI Images response with image-token usage", () => {
    const r = ImageGenerationResponseSchema.safeParse({
      created: 0,
      data: [{ b64_json: "AAAA" }],
      usage: { input_tokens: 15, output_tokens: 196, output_tokens_details: { image_tokens: 196 } },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.usage?.output_tokens).toBe(196);
  });
});
