import { expect, test } from "@playwright/test";

// Gemini-SDK image generation, two official surfaces, both reaching the same
// gemini-3.1-flash-image model on the mock's generateContent endpoint:
//   Part 1 — native `:generateContent` with responseModalities IMAGE. The model is
//            MODEL-PINNED (capabilities.outputImage) so it routes to its native
//            provider via passthrough (→ inlineData) instead of a `gemini-*flash*`
//            glob swallowing it onto a text lane. Works for ANY key.
//   Part 2 — `POST /v1beta/interactions` (the SDK's interactions.create), translated
//            to generateContent and mapped back to the `steps[]` shape.
const TEST_KEY = "helm_live_e2e_testkey";
const GOOG = { "x-goog-api-key": TEST_KEY, "Content-Type": "application/json" };

test.describe("gemini image generation e2e", () => {
  test("Part 1: :generateContent for an image model returns inlineData (model-pinned, not text)", async ({
    request,
  }) => {
    const res = await request.post("/v1beta/models/gemini-3.1-flash-image:generateContent", {
      headers: GOOG,
      data: {
        contents: [{ role: "user", parts: [{ text: "a leaf" }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{ content: { parts: Array<{ inlineData?: { data?: string } }> } }>;
    };
    const parts = body.candidates[0]?.content.parts ?? [];
    const img = parts.find((p) => typeof p.inlineData?.data === "string");
    expect((img?.inlineData?.data ?? "").length).toBeGreaterThan(0); // a real image, not text
  });

  test("Part 2: /v1beta/interactions generates an image (translated to generateContent)", async ({
    request,
  }) => {
    const res = await request.post("/v1beta/interactions", {
      headers: GOOG,
      data: {
        model: "gemini-3.1-flash-image",
        input: "a leaf",
        response_format: { type: "image", aspect_ratio: "1:1" },
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      id: string;
      steps: Array<{ type: string; content: Array<{ type: string; data?: string }> }>;
    };
    expect(body.id).toMatch(/^int_/);
    const img = body.steps[0]?.content.find((b) => b.type === "image");
    expect(typeof img?.data).toBe("string");
    expect((img?.data ?? "").length).toBeGreaterThan(0);
    expect(res.headers()["x-helm-final-model"]).toBe("gemini-3.1-flash-image");
    expect(res.headers()["x-helm-lane"]).toBe("image");
  });

  test("interactions rejects an OpenAI image model with 400 (→ /v1/images/generations)", async ({
    request,
  }) => {
    const res = await request.post("/v1beta/interactions", {
      headers: GOOG,
      data: { model: "gpt-image-2", input: "x" },
    });
    expect(res.status()).toBe(400);
  });

  test("interactions rejects a TEXT Gemini model with 404 (only outputImage models)", async ({
    request,
  }) => {
    // zenmux-vertex/gemini-3.5-flash is a gemini-protocol alias WITH nativePassthrough
    // but it is NOT an image model (no capabilities.outputImage) → 404, not accepted.
    const res = await request.post("/v1beta/interactions", {
      headers: GOOG,
      data: { model: "zenmux-vertex/gemini-3.5-flash", input: "x" },
    });
    expect(res.status()).toBe(404);
  });

  test("interactions without a key is 401", async ({ request }) => {
    const res = await request.post("/v1beta/interactions", {
      headers: { "Content-Type": "application/json" },
      data: { model: "gemini-3.1-flash-image", input: "x" },
    });
    expect(res.status()).toBe(401);
  });
});
