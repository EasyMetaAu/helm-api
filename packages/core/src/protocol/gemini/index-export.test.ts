import { describe, expect, it } from "vitest";
import * as core from "../../index.js";

// Guards the wiring contract issue #34 step 1 requires: the Gemini transformer +
// its routing/error/type surface must be reachable from the @helm/core barrel, or
// the gateway can never mount a Gemini endpoint. Before this change `grep gemini
// index.ts` was zero hits.
describe("@helm/core barrel exports the Gemini surface", () => {
  it("exposes the transformer with the 5-member contract + name/endPoint", () => {
    expect(core.geminiTransformer.name).toBe("gemini");
    expect(core.geminiTransformer.endPoint).toBe(core.GEMINI_ENDPOINT);
    for (const m of [
      "transformRequestOut",
      "transformResponseOut",
      "transformRequestIn",
      "transformResponseIn",
    ] as const) {
      expect(typeof core.geminiTransformer[m]).toBe("function");
    }
    expect(typeof core.geminiTransformer.transformStreamOut).toBe("function");
    expect(typeof core.geminiTransformer.transformStreamIn).toBe("function");
  });

  it("exposes the path parser + auth header constant", () => {
    expect(core.GEMINI_API_KEY_HEADER).toBe("x-goog-api-key");
    const parsed = core.parseGeminiPath("/v1beta/models/gemini-2.0-flash:generateContent", "");
    expect(parsed).toEqual({ model: "gemini-2.0-flash", stream: false });
  });

  it("exposes the error factory + wire schemas", () => {
    const err = core.makeGeminiError({
      error_class: "invalid_request",
      message: "bad",
      trace_id: "t1",
    });
    expect(err.body.error.status).toBe("INVALID_ARGUMENT");
    expect(typeof core.GeminiGenerateContentRequestSchema.parse).toBe("function");
    expect(typeof core.GeminiSSEEventSchema.parse).toBe("function");
  });
});
