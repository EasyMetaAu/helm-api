import { describe, expect, it } from "vitest";
import { ImageGenerationRequestSchema, ImageGenerationResponseSchema } from "./images-schema.js";

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
