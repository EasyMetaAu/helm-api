import { describe, expect, it } from "vitest";
import { InteractionsRequestSchema } from "./interactions-schema.js";

describe("InteractionsRequestSchema", () => {
  it.each([
    ["inline", true],
    ["uri", false],
  ] as const)("validates image delivery %s", (delivery, success) => {
    expect(
      InteractionsRequestSchema.safeParse({
        model: "gemini-image",
        input: "draw",
        response_format: { type: "image", delivery },
      }).success,
    ).toBe(success);
  });
  it("parses a string input", () => {
    const r = InteractionsRequestSchema.safeParse({
      model: "gemini-3.1-flash-image",
      input: "a red apple",
    });
    expect(r.success).toBe(true);
  });

  it("parses an array input with text + image blocks", () => {
    const r = InteractionsRequestSchema.safeParse({
      model: "gemini-3.1-flash-image",
      input: [
        { type: "text", text: "make them smile" },
        { type: "image", mime_type: "image/png", data: "AAAA" },
      ],
      response_format: { type: "image", aspect_ratio: "16:9", image_size: "2K" },
    });
    expect(r.success).toBe(true);
  });

  it("requires a non-empty model and input", () => {
    expect(InteractionsRequestSchema.safeParse({ model: "gemini-3.1-flash-image" }).success).toBe(
      false,
    );
    expect(InteractionsRequestSchema.safeParse({ input: "x" }).success).toBe(false);
    expect(InteractionsRequestSchema.safeParse({ model: "", input: "x" }).success).toBe(false);
    expect(
      InteractionsRequestSchema.safeParse({ model: "gemini-3.1-flash-image", input: "" }).success,
    ).toBe(false);
    expect(
      InteractionsRequestSchema.safeParse({ model: "gemini-3.1-flash-image", input: [] }).success,
    ).toBe(false);
  });

  it("rejects fields the generateContent adapter cannot represent", () => {
    for (const extra of [
      { previous_interaction_id: "int_1" },
      { tools: [{ type: "google_search" }] },
    ]) {
      expect(
        InteractionsRequestSchema.safeParse({ model: "gemini-image", input: "x", ...extra })
          .success,
      ).toBe(false);
    }
  });
});
