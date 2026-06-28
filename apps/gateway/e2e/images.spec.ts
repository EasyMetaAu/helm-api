import { expect, test } from "@playwright/test";

// POST /v1/images/generations (OpenAI Images API) → the gpt-image-2 alias resolves
// to the zenmux provider, forwarded to the mock's /images/generations. Proves the
// route registration, auth, config resolution, and verbatim round-trip end-to-end.
const TEST_KEY = "helm_live_e2e_testkey";
const AUTH = { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" };

test.describe("images e2e", () => {
  test("generates an image and routes to the configured image provider/model", async ({
    request,
  }) => {
    const res = await request.post("/v1/images/generations", {
      headers: AUTH,
      data: { model: "gpt-image-2", prompt: "a cat", size: "1024x1024" },
    });
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ b64_json?: string }>;
      usage: { output_tokens: number };
    };
    expect(typeof body.data[0]?.b64_json).toBe("string");
    expect((body.data[0]?.b64_json ?? "").length).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBe(196);

    // The client-facing `gpt-image-2` resolved to the zenmux wire id, lane `image`.
    expect(res.headers()["x-helm-final-model"]).toBe("gpt-image-2");
    expect(res.headers()["x-helm-provider-model"]).toBe("openai/gpt-image-2");
    expect(res.headers()["x-helm-lane"]).toBe("image");
  });

  test("serves a Gemini image model via the SAME endpoint (unified, no allow_custom_model)", async ({
    request,
  }) => {
    // k_e2e is a plain root key (NOT allow_custom_model) — proving image gen is
    // decoupled from the chat-routing gate. The route translates to generateContent
    // and maps the inlineData response back to b64_json.
    const res = await request.post("/v1/images/generations", {
      headers: AUTH,
      data: { model: "gemini-3.1-flash-image", prompt: "a leaf" },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: Array<{ b64_json?: string }> };
    expect(typeof body.data[0]?.b64_json).toBe("string");
    expect((body.data[0]?.b64_json ?? "").length).toBeGreaterThan(0);
    expect(res.headers()["x-helm-final-model"]).toBe("gemini-3.1-flash-image");
  });

  test("an unknown image model is a 404 (not a 5xx)", async ({ request }) => {
    const res = await request.post("/v1/images/generations", {
      headers: AUTH,
      data: { model: "no-such-image-model", prompt: "x" },
    });
    expect(res.status()).toBe(404);
  });

  test("a missing API key is rejected (401, no anonymous access)", async ({ request }) => {
    const res = await request.post("/v1/images/generations", {
      headers: { "Content-Type": "application/json" },
      data: { model: "gpt-image-2", prompt: "x" },
    });
    expect(res.status()).toBe(401);
  });
});
