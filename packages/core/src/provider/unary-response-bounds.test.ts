import { describe, expect, it, vi } from "vitest";
import { createResponseWorkAdmission } from "../runtime/response-work-admission.js";
import { createAnthropicClient } from "./anthropic.js";
import { createGeminiClient } from "./gemini.js";
import { createOpenAIClient, type ProviderClient, type UpstreamError } from "./openai.js";

const CAPACITY_BYTES = 32;

function admission() {
  return createResponseWorkAdmission({
    capacityBytes: CAPACITY_BYTES,
    jsonAmplification: 1,
    minChargeBytes: 1,
  });
}

function declaredOversizedResponse(status = 200) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      status,
      headers: {
        "content-type": status === 201 ? "application/sdp" : "application/json",
        "content-length": String(CAPACITY_BYTES + 1),
        ...(status === 201 ? { location: "/v1/realtime/calls/rtc_test" } : {}),
      },
    }),
    cancelled: () => cancelled,
  };
}

function chunkedOversizedResponse() {
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`{"text":"${"x".repeat(CAPACITY_BYTES)}`));
      controller.enqueue(encoder.encode('"}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "application/json" } }),
    cancelled: () => cancelled,
  };
}

async function expectBoundedFailure(
  run: (client: ProviderClient) => Promise<unknown>,
  makeClient: (
    fetch: typeof globalThis.fetch,
    work: ReturnType<typeof admission>,
  ) => ProviderClient,
  response: ReturnType<typeof declaredOversizedResponse>,
) {
  const work = admission();
  const fetch = vi.fn(async () => response.response);
  const client = makeClient(fetch, work);

  await expect(run(client)).rejects.toMatchObject({
    errorClass: "upstream_error",
    providerRaw: { error: { code: "response_body_too_large", limit_bytes: CAPACITY_BYTES } },
  } satisfies Partial<UpstreamError>);
  expect(response.cancelled()).toBe(true);
  expect(work.reservedBytes).toBe(0);
}

const openAIUnaryCalls: Array<[string, (client: ProviderClient) => Promise<unknown>, number]> = [
  ["chat completion", (client) => client.chatCompletion({ model: "m", messages: [] }), 200],
  [
    "image generation",
    (client) => {
      if (!client.imageGeneration) throw new Error("missing imageGeneration");
      return client.imageGeneration({ model: "image" });
    },
    200,
  ],
  [
    "image edit",
    (client) => {
      if (!client.imageEdit) throw new Error("missing imageEdit");
      return client.imageEdit({ kind: "json", body: { model: "image" } });
    },
    200,
  ],
  [
    "video generation",
    (client) => {
      if (!client.videoGeneration) throw new Error("missing videoGeneration");
      return client.videoGeneration({ model: "video" });
    },
    200,
  ],
  [
    "video retrieve",
    (client) => {
      if (!client.videoRetrieve) throw new Error("missing videoRetrieve");
      return client.videoRetrieve("video_1");
    },
    200,
  ],
  [
    "Realtime SDP",
    (client) => {
      if (!client.realtimeCall) throw new Error("missing realtimeCall");
      return client.realtimeCall({
        endpoint: "realtime",
        query: "",
        sdp: "v=0",
        session: { model: "gpt-realtime" },
        headers: {},
      });
    },
    201,
  ],
];

describe("bounded unary provider responses", () => {
  it.each(
    openAIUnaryCalls,
  )("rejects oversized OpenAI %s bodies before reading", async (_name, run, status) => {
    await expectBoundedFailure(
      run,
      (fetch, responseWorkAdmission) =>
        createOpenAIClient({
          config: { baseUrl: "https://openai.test/v1", apiKey: "key" },
          fetch,
          responseWorkAdmission,
        }),
      declaredOversizedResponse(status),
    );
  });

  it.each([
    [
      "chat completion",
      (client: ProviderClient) => client.chatCompletion({ model: "m", messages: [] }),
    ],
    [
      "native passthrough",
      (client: ProviderClient) => {
        if (!client.nativePassthrough) throw new Error("missing nativePassthrough");
        return client.nativePassthrough({ model: "m", messages: [] });
      },
    ],
    [
      "token count",
      (client: ProviderClient) => {
        if (!client.countTokens) throw new Error("missing countTokens");
        return client.countTokens({ model: "m", messages: [] });
      },
    ],
  ])("rejects oversized Anthropic %s bodies before reading", async (_name, run) => {
    await expectBoundedFailure(
      run,
      (fetch, responseWorkAdmission) =>
        createAnthropicClient({
          config: { baseUrl: "https://anthropic.test", apiKey: "key" },
          fetch,
          responseWorkAdmission,
        }),
      declaredOversizedResponse(),
    );
  });

  it.each([
    [
      "chat completion",
      (client: ProviderClient) => client.chatCompletion({ model: "m", messages: [] }),
    ],
    [
      "native passthrough",
      (client: ProviderClient) => {
        if (!client.nativePassthrough) throw new Error("missing nativePassthrough");
        return client.nativePassthrough({ model: "m", contents: [] });
      },
    ],
    [
      "token count",
      (client: ProviderClient) => {
        if (!client.countTokens) throw new Error("missing countTokens");
        return client.countTokens({ model: "m", contents: [] });
      },
    ],
  ])("rejects oversized Gemini %s bodies before reading", async (_name, run) => {
    await expectBoundedFailure(
      run,
      (fetch, responseWorkAdmission) =>
        createGeminiClient({
          config: { baseUrl: "https://gemini.test/v1beta", apiKey: "key" },
          fetch,
          responseWorkAdmission,
        }),
      declaredOversizedResponse(),
    );
  });

  it.each([
    [
      "OpenAI",
      (fetch: typeof globalThis.fetch, responseWorkAdmission: ReturnType<typeof admission>) =>
        createOpenAIClient({
          config: { baseUrl: "https://openai.test/v1", apiKey: "key" },
          fetch,
          responseWorkAdmission,
        }),
    ],
    [
      "Anthropic",
      (fetch: typeof globalThis.fetch, responseWorkAdmission: ReturnType<typeof admission>) =>
        createAnthropicClient({
          config: { baseUrl: "https://anthropic.test", apiKey: "key" },
          fetch,
          responseWorkAdmission,
        }),
    ],
    [
      "Gemini",
      (fetch: typeof globalThis.fetch, responseWorkAdmission: ReturnType<typeof admission>) =>
        createGeminiClient({
          config: { baseUrl: "https://gemini.test/v1beta", apiKey: "key" },
          fetch,
          responseWorkAdmission,
        }),
    ],
  ])("cancels chunked %s overflow and releases shared capacity", async (_name, makeClient) => {
    const response = chunkedOversizedResponse();
    await expectBoundedFailure(
      (client) => client.chatCompletion({ model: "m", messages: [] }),
      makeClient,
      response,
    );
  });
});
