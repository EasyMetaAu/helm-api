import { expect, test } from "@playwright/test";
import {
  CAPTURE_PATH,
  TOOL_CALL_SENTINEL,
  type UpstreamCapture,
} from "./fixtures/mock-upstream.js";

// e2e.gemini — black-box the WHOLE Gemini protocol-translation chain over real
// HTTP into a real gateway + the deterministic OpenAI-shaped mock upstream (issue
// #34). The unit tests prove the transformer / route / pipeline in isolation; this
// proves the seams hold end-to-end across the two high-risk paths docs/05 calls
// out: snapshot streaming SSE and tool-calls (CLAUDE.md §Testing / docs/05).
//
// We assert BOTH sides of the translation:
//   (a) the client RESPONSE matches the Gemini wire shape (candidates[].content.
//       parts, finishReason, usageMetadata);
//   (b) the request the gateway forwarded UPSTREAM is the unified normalized
//       (OpenAI-Chat IR) shape — read back from the mock's capture endpoint —
//       proving nativeIn → IR → nativeOut (one hub, not N×N direct), with the
//       PATH model backfilled (not the transformer's default "gemini").
//
// Auth uses x-goog-api-key (Gemini SDK default), NOT Authorization: Bearer.

const TEST_KEY = "helm_live_e2e_testkey";
const GEMINI_AUTH = { "x-goog-api-key": TEST_KEY, "Content-Type": "application/json" };

const MOCK_BASE_URL = `http://127.0.0.1:${process.env.MOCK_PORT ?? "8181"}`;

async function lastUpstreamRequest(request: {
  get: (url: string) => Promise<{ json: () => Promise<UpstreamCapture> }>;
}): Promise<UpstreamCapture> {
  const res = await request.get(`${MOCK_BASE_URL}${CAPTURE_PATH}`);
  return res.json();
}

test.describe("Gemini client → upstream", () => {
  test("non-stream: generateContent round-trip + normalized upstream request", async ({
    request,
  }) => {
    const res = await request.post("/v1beta/models/gemini-2.0-flash:generateContent", {
      headers: GEMINI_AUTH,
      data: {
        contents: [{ role: "user", parts: [{ text: "translate this sentence to french: hello" }] }],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // (a) client sees the native Gemini shape.
    expect(Array.isArray(body.candidates)).toBeTruthy();
    expect(body.candidates[0].content.role).toBe("model");
    expect(typeof body.candidates[0].content.parts[0].text).toBe("string");
    expect(body.candidates[0].finishReason).toBe("STOP");

    // (b) upstream got the normalized OpenAI-Chat request with a RESOLVED provider
    // model (not the path-derived "gemini-2.0-flash" and not the default "gemini").
    const upstream = await lastUpstreamRequest(request);
    expect(Array.isArray(upstream.body.messages)).toBeTruthy();
    expect(typeof upstream.body.model).toBe("string");
    expect(upstream.body.model).not.toBe("gemini");
  });

  test("LiteLLM-compatible /models alias accepts path-style model names", async ({ request }) => {
    const res = await request.post("/models/google/gemini-2.5-pro:generateContent", {
      headers: GEMINI_AUTH,
      data: {
        contents: [{ role: "user", parts: [{ text: "translate this sentence to french: hello" }] }],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.candidates[0].content.role).toBe("model");

    const upstream = await lastUpstreamRequest(request);
    expect(Array.isArray(upstream.body.messages)).toBeTruthy();
    expect(upstream.body.model).not.toBe("gemini");
  });

  test("stream: alt=sse emits snapshot data frames with NO event: name and NO [DONE]", async ({
    request,
  }) => {
    const res = await request.post(
      "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
      {
        headers: GEMINI_AUTH,
        data: {
          contents: [
            { role: "user", parts: [{ text: "translate this sentence to french: hola" }] },
          ],
        },
      },
    );
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const text = await res.text();
    // Gemini wire form: nameless data: frames, NO event: names, NO [DONE].
    expect(text).toContain("data:");
    expect(text).not.toContain("event:");
    expect(text).not.toContain("[DONE]");
    // never leak a raw OpenAI chunk through the Gemini surface.
    expect(text).not.toContain("chat.completion.chunk");
    // each frame is a full snapshot carrying candidates[].
    expect(text).toContain("candidates");
    // the terminal snapshot carries the mapped finishReason.
    expect(text).toContain("STOP");
  });

  test("streamGenerateContent streams even without alt=sse", async ({ request }) => {
    const res = await request.post("/v1beta/models/gemini-2.0-flash:streamGenerateContent", {
      headers: GEMINI_AUTH,
      data: {
        contents: [{ role: "user", parts: [{ text: "translate this sentence to french: hola" }] }],
      },
    });
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("candidates");
    expect(text).not.toContain("[DONE]");
  });

  test("tool-call: upstream function call → client sees a functionCall part", async ({
    request,
  }) => {
    const res = await request.post("/v1beta/models/gemini-2.0-flash:generateContent", {
      headers: GEMINI_AUTH,
      data: {
        contents: [
          { role: "user", parts: [{ text: `look up the weather ${TOOL_CALL_SENTINEL}` }] },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                description: "get the weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            ],
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const parts = body.candidates[0].content.parts as Array<{
      functionCall?: { name: string; args: Record<string, unknown> };
    }>;
    const fc = parts.find((p) => p.functionCall)?.functionCall;
    expect(fc).toBeDefined();
    expect(fc?.name).toBe("get_weather");
    // arguments parsed into an object (docs/05 pit #3).
    expect(typeof fc?.args).toBe("object");
  });
});

test.describe("Gemini auth + error envelopes", () => {
  test("missing key on generateContent is rejected (401 UNAUTHENTICATED envelope)", async ({
    request,
  }) => {
    const res = await request.post("/v1beta/models/gemini-2.0-flash:generateContent", {
      headers: { "Content-Type": "application/json" },
      data: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error.status).toBe("UNAUTHENTICATED");
    expect(body.error.code).toBe(401);
  });

  test("a non-generateContent operation returns 404 (Gemini NOT_FOUND envelope)", async ({
    request,
  }) => {
    const res = await request.post("/v1beta/models/gemini-2.0-flash:countTokens", {
      headers: GEMINI_AUTH,
      data: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error.status).toBe("NOT_FOUND");
  });

  test("a structurally invalid body returns 400 INVALID_ARGUMENT", async ({ request }) => {
    const res = await request.post("/v1beta/models/gemini-2.0-flash:generateContent", {
      headers: GEMINI_AUTH,
      // contents is required by the Gemini schema; an empty object fails the parse.
      data: { not: "a gemini request" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.status).toBe("INVALID_ARGUMENT");
  });
});
