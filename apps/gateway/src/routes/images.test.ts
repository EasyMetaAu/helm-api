import type { CircuitBreaker, ProviderClient } from "@helm/core";
import { UpstreamError } from "@helm/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArkMediaClient } from "../../../../packages/core/src/provider/ark.js";
import type { AppEnv } from "../app.js";
import { createBodyMemoryAdmission } from "../runtime/memory-admission.js";
import { type ImagesRouteDeps, registerImagesRoute } from "./images.js";
import type { MessagesIdentity } from "./messages.js";
import type { RecordServedDeps } from "./payload-capture.js";

// A breaker that always allows (CLOSED) — image fallback control flow is unit-tested
// in image-chain.test.ts; these tests exercise the route's HTTP/telemetry glue.
function closedBreaker(): CircuitBreaker {
  return {
    canAttempt: () => ({ allow: true, probe: false }),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordAbort: vi.fn(),
  } as unknown as CircuitBreaker;
}

const UPSTREAM = {
  created: 0,
  data: [{ b64_json: "REALIMAGEBYTES" }],
  usage: { input_tokens: 15, output_tokens: 196, output_tokens_details: { image_tokens: 196 } },
};

// Minimal budget caps so the route's budget gate/settle fire (the gate is a mock, so
// the values are irrelevant — only `caps.budget !== undefined` matters).
const BUDGET_CAPS = {
  requests: null,
  tokens: null,
  spendUsd: 5,
  windowSeconds: null,
  behavior: "reject",
  degradeLane: null,
};

function setup(
  over: Partial<ImagesRouteDeps> = {},
  requestContentMode?: "none" | "payload" | "session",
) {
  const imageGeneration = vi.fn().mockResolvedValue(UPSTREAM);
  const imageEdit = vi.fn().mockResolvedValue(UPSTREAM);
  const client = { imageGeneration, imageEdit } as unknown as ProviderClient;
  const enqueuePayload = vi.fn();
  const enqueueTelemetry = vi.fn();
  const record = {
    telemetry: { insert: vi.fn() },
    redact: (d: unknown) => d,
    now: () => 0,
    capturePayloads: () => true,
    writes: { enqueuePayload, enqueueTelemetry },
  } as unknown as RecordServedDeps;

  const deps: ImagesRouteDeps = {
    auth: {
      resolve: async (cred) =>
        cred === "k"
          ? ({
              keyId: "key1",
              accountId: "acct",
              keyPrefix: "helm_live_xy",
              caps: { budget: BUDGET_CAPS, requestContentMode },
            } as MessagesIdentity)
          : null,
    },
    resolveImageChain: (model) =>
      model === "gpt-image-2"
        ? {
            ok: true,
            laneName: "image",
            candidateChain: ["gpt-image-2"],
            targets: [
              { client, providerModel: "openai/gpt-image-2", alias: "gpt-image-2", kind: "openai" },
            ],
          }
        : { ok: false, status: 404 },
    breaker: closedBreaker(),
    costOf: () => 0.006,
    record,
    ...over,
  };

  const app = new Hono<AppEnv>();
  registerImagesRoute(app, deps);
  return { app, imageGeneration, imageEdit, enqueuePayload, enqueueTelemetry };
}

function post(app: Hono<AppEnv>, body: unknown, auth = "Bearer k") {
  return app.request("/v1/images/generations", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("registerImagesRoute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves the full image to the client, swaps the wire model, and records cost", async () => {
    const { app, imageGeneration, enqueueTelemetry } = setup();
    const res = await post(app, { model: "gpt-image-2", prompt: "a cat", size: "1024x1024" });

    expect(res.status).toBe(200);
    const json = (await res.json()) as typeof UPSTREAM;
    expect(json.data[0]?.b64_json).toBe("REALIMAGEBYTES"); // client gets the full image
    expect(res.headers.get("x-helm-final-model")).toBe("gpt-image-2");
    expect(res.headers.get("x-helm-provider-model")).toBe("openai/gpt-image-2");
    expect(res.headers.get("x-helm-lane")).toBe("image");

    // upstream got the resolved wire model id, not the client-facing alias
    expect(imageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-image-2", prompt: "a cat", size: "1024x1024" }),
      expect.anything(),
    );

    const decision = enqueueTelemetry.mock.calls[0]?.[0].decision;
    expect(decision.lane.selected_lane).toBe("image");
    expect(decision.final.model_alias).toBe("gpt-image-2");
    expect(decision.provider_attempts[0].cost_usd).toBe(0.006);
    expect(decision.cost_breakdown.total_usd).toBe(0.006);
    expect(decision.usage.completion_tokens).toBe(196);
    expect(decision.usage.prompt_tokens).toBe(15);
  });

  it("attributes an OAuth image to the selected subscription account", async () => {
    const recordOAuthUsage = vi.fn();
    const { app, enqueueTelemetry } = setup({
      captureServingAccount: async (call) => ({
        result: await call(),
        servingAccount: { providerId: "xai", account: "supergrok-a" },
      }),
      recordOAuthUsage,
    });

    expect((await post(app, { model: "gpt-image-2", prompt: "a cat" })).status).toBe(200);
    expect(enqueueTelemetry.mock.calls[0]?.[0].decision.serving_account).toEqual({
      provider_id: "xai",
      account: "supergrok-a",
    });
    expect(recordOAuthUsage).toHaveBeenCalledWith(
      { providerId: "xai", account: "supergrok-a" },
      "gpt-image-2",
      { tokens: 211, costUsd: 0.006 },
    );
  });

  it("records the selected OAuth account when an image POST outcome is unknown", async () => {
    const imageGeneration = vi.fn(async (_body, options) => {
      await options?.onAccountSelected?.("supergrok-a");
      throw new Error("socket closed after POST");
    });
    const client = { imageGeneration } as unknown as ProviderClient;
    const { app, enqueueTelemetry } = setup({
      resolveImageChain: () => ({
        ok: true,
        laneName: "image",
        candidateChain: ["xai/grok-imagine-image-quality"],
        targets: [
          {
            client,
            providerModel: "grok-imagine-image-quality",
            alias: "xai/grok-imagine-image-quality",
            kind: "openai",
          },
        ],
      }),
    });

    const response = await post(app, {
      model: "grok-imagine-image-quality",
      prompt: "a cat",
    });

    expect(response.status).toBe(503);
    expect(imageGeneration).toHaveBeenCalledOnce();
    expect(enqueueTelemetry.mock.calls[0]?.[0]?.decision.serving_account).toEqual({
      provider_id: "xai",
      account: "supergrok-a",
    });
  });

  it("forwards supported Grok image options in one paid create", async () => {
    const imageGeneration = vi.fn().mockResolvedValue(UPSTREAM);
    const client = { imageGeneration } as unknown as ProviderClient;
    const { app } = setup({
      resolveImageChain: () => ({
        ok: true,
        laneName: "grok-imagine-image",
        candidateChain: ["xai/grok-imagine-image"],
        targets: [
          {
            client,
            providerModel: "grok-imagine-image",
            alias: "xai/grok-imagine-image",
            kind: "openai",
          },
        ],
      }),
    });

    const response = await post(app, {
      model: "grok-imagine-image",
      prompt: "a cat",
      n: 4,
      aspect_ratio: "16:9",
    });

    expect(response.status).toBe(200);
    expect(imageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "grok-imagine-image",
        prompt: "a cat",
        n: 4,
        aspect_ratio: "16:9",
      }),
      expect.anything(),
    );
  });

  it("treats an empty Grok image response as one ambiguous paid write", async () => {
    const imageGeneration = vi.fn().mockResolvedValue({ data: [] });
    const client = { imageGeneration } as unknown as ProviderClient;
    const { app } = setup({
      resolveImageChain: () => ({
        ok: true,
        laneName: "grok-imagine-image-quality",
        candidateChain: ["xai/grok-imagine-image-quality"],
        targets: [
          {
            client,
            providerModel: "grok-imagine-image-quality",
            alias: "xai/grok-imagine-image-quality",
            kind: "openai",
          },
        ],
      }),
    });

    const response = await post(app, {
      model: "grok-imagine-image-quality",
      prompt: "a cat",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(imageGeneration).toHaveBeenCalledOnce();
  });

  it("treats whitespace-only Grok image carriers as one ambiguous paid write", async () => {
    const imageGeneration = vi.fn().mockResolvedValue({
      data: [{ b64_json: " \t " }, { url: "  " }],
    });
    const client = { imageGeneration } as unknown as ProviderClient;
    const { app } = setup({
      resolveImageChain: () => ({
        ok: true,
        laneName: "grok-imagine-image-quality",
        candidateChain: ["xai/grok-imagine-image-quality"],
        targets: [
          {
            client,
            providerModel: "grok-imagine-image-quality",
            alias: "xai/grok-imagine-image-quality",
            kind: "openai",
          },
        ],
      }),
    });

    const response = await post(app, {
      model: "grok-imagine-image-quality",
      prompt: "a cat",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(imageGeneration).toHaveBeenCalledOnce();
  });

  it("rejects unpriced image media before a paid call for a spend-capped key", async () => {
    const { app, imageGeneration } = setup({ isPriced: () => false });

    const response = await post(app, { model: "gpt-image-2", prompt: "a cat" });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "media_pricing_unavailable" },
    });
    expect(imageGeneration).not.toHaveBeenCalled();
  });

  it("forwards Codex JSON image edits through the existing image chain", async () => {
    const { app, imageEdit } = setup();
    const res = await app.request("/v1/images/edits", {
      method: "POST",
      headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: "add a red hat",
        images: [{ image_url: "data:image/png;base64,AAA=" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(imageEdit).toHaveBeenCalledWith(
      {
        kind: "json",
        body: expect.objectContaining({ model: "openai/gpt-image-2", prompt: "add a red hat" }),
      },
      expect.anything(),
    );
  });

  it("forwards multipart image edits without losing binary bytes", async () => {
    const { app, imageEdit, enqueueTelemetry } = setup();
    const body = new FormData();
    body.set("model", "gpt-image-2");
    body.set("prompt", "add snow");
    body.append("image[]", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png");

    const request = new Request("http://helm.test/v1/images/edits", {
      method: "POST",
      headers: { Authorization: "Bearer k" },
      body,
    });
    const wireBytes = (await request.clone().arrayBuffer()).byteLength;
    const res = await app.request(request);

    expect(res.status).toBe(200);
    const edit = imageEdit.mock.calls[0]?.[0] as {
      kind: string;
      fields: Array<{ name: string; value: string | Uint8Array }>;
    };
    expect(edit.kind).toBe("multipart");
    expect(edit.fields).toEqual(
      expect.arrayContaining([
        { name: "model", value: "openai/gpt-image-2" },
        expect.objectContaining({ name: "image[]", filename: "a.png" }),
      ]),
    );
    const image = edit.fields.find((field) => field.name === "image[]");
    expect([...((image?.value as Uint8Array) ?? [])]).toEqual([1, 2, 3]);
    expect(enqueueTelemetry.mock.calls[0]?.[0].decision.request_body_bytes).toBe(wireBytes);
  });

  it("captures the FULL image verbatim (the store externalizes it to payload_blobs)", async () => {
    // The route no longer strips: it captures the full body. The DB-bloat guard moved
    // to the store layer (externalizeImages → content-addressed payload_blobs), which
    // ALSO makes the image rehydratable + viewable in the admin detail page.
    const { app, enqueuePayload } = setup();
    await post(app, { model: "gpt-image-2", prompt: "a cat" });

    const payload = enqueuePayload.mock.calls[0]?.[0];
    const stored = JSON.parse(payload.responseJson) as typeof UPSTREAM;
    expect(stored.data[0]?.b64_json).toBe("REALIMAGEBYTES"); // full image handed to capture
    expect(stored.usage.output_tokens).toBe(196); // metadata/usage preserved
  });

  it("per-key metadata-only mode overrides enabled system payload capture", async () => {
    const { app, enqueuePayload } = setup({}, "none");
    const res = await post(app, { model: "gpt-image-2", prompt: "a cat" });

    expect(res.status).toBe(200);
    expect(enqueuePayload).not.toHaveBeenCalled();
  });

  it("returns 401 without a valid key", async () => {
    const { app } = setup();
    const res = await post(app, { model: "gpt-image-2", prompt: "x" }, "Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("does not enforce the former hard body limit before JSON parsing", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    const { app, imageGeneration } = setup({ memoryAdmission });

    const res = await post(app, { model: "gpt-image-2", prompt: "a cat" });

    expect(res.status).toBe(200);
    expect(imageGeneration).toHaveBeenCalledOnce();
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("does not return OpenAI capacity 503 when historical request capacity is exhausted", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1,
      jsonAmplification: 1,
    });
    const { app, imageGeneration } = setup({ memoryAdmission });

    const res = await post(app, { model: "gpt-image-2", prompt: "a cat" });

    expect(res.status).toBe(200);
    expect(imageGeneration).toHaveBeenCalled();
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("releases its memory lease after a successful image request", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1000,
      jsonAmplification: 1,
    });
    const { app } = setup({ memoryAdmission });

    expect((await post(app, { model: "gpt-image-2", prompt: "a cat" })).status).toBe(200);
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("releases its memory lease when image JSON is malformed", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1000,
      jsonAmplification: 1,
    });
    const { app } = setup({ memoryAdmission });

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("rejects a direct image model that is blocked for the key", async () => {
    const { app, imageGeneration, enqueueTelemetry } = setup({
      auth: {
        resolve: async (cred) =>
          cred === "k"
            ? ({
                keyId: "key1",
                accountId: "acct",
                keyPrefix: "helm_live_xy",
                caps: { budget: BUDGET_CAPS, blockedModels: ["GPT-IMAGE-*"] },
              } as MessagesIdentity)
            : null,
      },
    });

    const res = await post(app, { model: "gpt-image-2", prompt: "x" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.message).toContain("blocked for this key");
    expect(body.error.code).toBe("model_blocked");
    expect(imageGeneration).not.toHaveBeenCalled();
    expect(enqueueTelemetry).not.toHaveBeenCalled();
  });

  it("removes blocked image candidates from an image lane before fallback execution", async () => {
    const blockedImageGeneration = vi.fn().mockResolvedValue(UPSTREAM);
    const allowedImageGeneration = vi.fn().mockResolvedValue(UPSTREAM);
    const blockedClient = { imageGeneration: blockedImageGeneration } as unknown as ProviderClient;
    const allowedClient = { imageGeneration: allowedImageGeneration } as unknown as ProviderClient;
    const { app, enqueueTelemetry } = setup({
      auth: {
        resolve: async (cred) =>
          cred === "k"
            ? ({
                keyId: "key1",
                accountId: "acct",
                keyPrefix: "helm_live_xy",
                caps: { budget: BUDGET_CAPS, blockedModels: ["GPT-IMAGE-PRI*"] },
              } as MessagesIdentity)
            : null,
      },
      resolveImageChain: (model) =>
        model === "image-lane"
          ? {
              ok: true,
              laneName: "image-lane",
              candidateChain: ["gpt-image-primary", "gpt-image-fallback"],
              targets: [
                {
                  client: blockedClient,
                  providerModel: "openai/gpt-image-primary",
                  alias: "gpt-image-primary",
                  kind: "openai",
                },
                {
                  client: allowedClient,
                  providerModel: "openai/gpt-image-fallback",
                  alias: "gpt-image-fallback",
                  kind: "openai",
                },
              ],
            }
          : { ok: false, status: 404 },
      costOf: (alias) => (alias === "gpt-image-fallback" ? 0.007 : null),
    });

    const res = await post(app, { model: "image-lane", prompt: "x" });

    expect(res.status).toBe(200);
    expect(blockedImageGeneration).not.toHaveBeenCalled();
    expect(allowedImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-image-fallback", prompt: "x" }),
      expect.anything(),
    );
    expect(res.headers.get("x-helm-final-model")).toBe("gpt-image-fallback");

    const decision = enqueueTelemetry.mock.calls[0]?.[0].decision;
    expect(decision.lane.candidate_chain).toEqual(["gpt-image-fallback"]);
    expect(decision.provider_attempts.map((a: { alias: string }) => a.alias)).toEqual([
      "gpt-image-fallback",
    ]);
  });

  it("returns 404 for a model that is not a configured image model", async () => {
    const { app } = setup();
    const res = await post(app, { model: "not-an-image-model", prompt: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid body (missing prompt)", async () => {
    const { app } = setup();
    const res = await post(app, { model: "gpt-image-2" });
    expect(res.status).toBe(400);
  });

  it("maps an ambiguous UpstreamError to outcome_unknown and records an error decision", async () => {
    const { app, imageGeneration, enqueueTelemetry } = setup();
    imageGeneration.mockRejectedValueOnce(new UpstreamError("upstream_error", "boom", null, 400));
    const res = await post(app, { model: "gpt-image-2", prompt: "x" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    const decision = enqueueTelemetry.mock.calls[0]?.[0].decision;
    expect(decision.final.status).toBe("error");
    expect(decision.provider_attempts[0].status).toBe("error");
    expect(decision.provider_attempts[0].cost_usd).toBeNull();
  });

  it("maps a ZenMux invalid_params 400 to an OpenAI invalid-request response", async () => {
    const { app, imageGeneration, enqueueTelemetry } = setup();
    const raw = {
      error: {
        code: "400",
        type: "invalid_params",
        message: "Unknown parameter: 'response_format'.",
      },
    };
    imageGeneration.mockRejectedValueOnce(
      new UpstreamError("upstream_error", "upstream returned 400", raw, 400),
    );

    const res = await post(app, {
      model: "gpt-image-2",
      prompt: "x",
      response_format: "b64_json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        message: "Unknown parameter: 'response_format'.",
        type: "invalid_request_error",
        code: "invalid_request",
        param: null,
      },
    });
    expect(enqueueTelemetry.mock.calls[0]?.[0].decision).toMatchObject({
      final: { status: "error", error_reason: "invalid_request" },
      provider_attempts: [
        {
          error_class: "invalid_request",
          error_detail: { upstream_status: 400, provider_raw: raw },
        },
      ],
    });
  });

  it("enforces the per-key budget: over budget (reject) → 429, no upstream call", async () => {
    const { app, imageGeneration } = setup({
      budgetGate: {
        check: async () => ({
          overBudget: true,
          behavior: "reject" as const,
          limitedBy: null,
          degradeLane: null,
        }),
      },
    });
    const res = await post(app, { model: "gpt-image-2", prompt: "x" });
    expect(res.status).toBe(429);
    expect(imageGeneration).not.toHaveBeenCalled();
  });

  it("settles the served image cost + tokens against the budget", async () => {
    const settleBudget = vi.fn();
    const { app } = setup({ settleBudget });
    await post(app, { model: "gpt-image-2", prompt: "a cat" });
    expect(settleBudget).toHaveBeenCalledOnce();
    const [, , usage] = settleBudget.mock.calls[0] as [
      string,
      unknown,
      { requests: number; tokens: number; costUsd: number | null },
    ];
    expect(usage).toEqual({ requests: 1, tokens: 211, costUsd: 0.006 }); // 15 input + 196 output
  });

  it("returns 503 when a configured image provider is unavailable (missing credential)", async () => {
    const { app, imageGeneration } = setup({
      resolveImageChain: () => ({ ok: false, status: 503 }),
    });
    const res = await post(app, { model: "gpt-image-2", prompt: "x" });
    expect(res.status).toBe(503);
    expect(imageGeneration).not.toHaveBeenCalled();
  });

  it("serves a Gemini image model via generateContent → uniform b64_json shape + cost", async () => {
    const native = {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "image/png", data: "GEMIMG" } }] } },
      ],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 1120 },
    };
    const nativePassthrough = vi.fn().mockResolvedValue(native);
    const client = { nativePassthrough } as unknown as ProviderClient;
    const enqueueTelemetry = vi.fn();
    const record = {
      telemetry: { insert: vi.fn() },
      redact: (d: unknown) => d,
      now: () => 0,
      capturePayloads: () => false,
      writes: { enqueuePayload: vi.fn(), enqueueTelemetry },
    } as unknown as RecordServedDeps;
    const app = new Hono<AppEnv>();
    registerImagesRoute(app, {
      auth: {
        resolve: async (cred) =>
          cred === "k" ? ({ keyId: "k1", accountId: "a" } as MessagesIdentity) : null,
      },
      resolveImageChain: () => ({
        ok: true,
        laneName: "image",
        candidateChain: ["gemini-3.1-flash-image"],
        targets: [
          {
            client,
            providerModel: "gemini-3.1-flash-image",
            alias: "gemini-3.1-flash-image",
            kind: "gemini",
          },
        ],
      }),
      breaker: closedBreaker(),
      costOf: () => 0.0672,
      record,
    });

    const res = await post(app, { model: "gemini-3.1-flash-image", prompt: "a cat" });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ b64_json?: string }> };
    expect(json.data[0]?.b64_json).toBe("GEMIMG"); // inlineData → b64_json (OpenAI shape)

    // built a generateContent request with responseModalities IMAGE
    expect(nativePassthrough).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.1-flash-image",
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      expect.anything(),
    );
    const decision = enqueueTelemetry.mock.calls[0]?.[0].decision;
    expect(decision.final.model_alias).toBe("gemini-3.1-flash-image");
    expect(decision.usage.completion_tokens).toBe(1120); // candidatesTokenCount → output tokens
    expect(decision.provider_attempts[0].cost_usd).toBe(0.0672);
  });
});

describe("Images Gemini translation fidelity", () => {
  it.each([
    { n: 2 },
    { size: "1024x1024" },
    { quality: "high" },
    { response_format: "url" },
    { background: "transparent" },
    { output_format: "jpeg" },
    { future_image_option: true },
  ])("rejects unsupported generation options before inference: %j", async (options) => {
    const nativePassthrough = vi.fn();
    const { app } = setup({
      resolveImageChain: () => ({
        ok: true,
        laneName: "image",
        candidateChain: ["gemini-image"],
        targets: [
          {
            kind: "gemini",
            alias: "gemini-image",
            providerModel: "gemini-image",
            client: { nativePassthrough } as unknown as ProviderClient,
          },
        ],
      }),
    });
    const response = await post(app, { model: "gemini-image", prompt: "a cat", ...options });
    expect(response.status).toBe(400);
    expect(nativePassthrough).not.toHaveBeenCalled();
  });
});

describe("Ark Seedream image generation", () => {
  const flash = "doubao-seedream-5-0-flash-260915";
  const pro = "doubao-seedream-5-0-pro-260628";
  const source = "https://media.example.com/source.png";
  function arkSetup(
    providerModel = flash,
    options: {
      spendCapped?: boolean;
      error?: Error;
      result?: Record<string, unknown>;
      priced?: boolean;
    } = {},
  ) {
    const result = options.result ?? {
      model: providerModel,
      created: 1,
      data: [{ url: source, size: "1024x1024", output_format: "png" }],
      usage: { input_images: 0, generated_images: 1, output_tokens: 4096, total_tokens: 4096 },
    };
    const create = options.error
      ? vi.fn().mockRejectedValue(options.error)
      : vi.fn().mockResolvedValue(result);
    const fallback = vi.fn().mockResolvedValue(result);
    const imageEdit = vi.fn().mockResolvedValue(result);
    const costOf = vi.fn().mockReturnValue(null);
    const fixture = setup({
      auth: {
        resolve: async () =>
          ({
            keyId: "ark-key",
            accountId: "acct",
            caps: options.spendCapped ? { budget: BUDGET_CAPS } : {},
          }) as MessagesIdentity,
      },
      resolveImageChain: () => ({
        ok: true,
        laneName: "image",
        candidateChain: ["ark-primary", "ark-fallback"],
        targets: [
          {
            client: { imageGeneration: create, imageEdit } as unknown as ProviderClient,
            providerModel,
            alias: "ark-primary",
            kind: "openai",
          },
          {
            client: { imageGeneration: fallback, imageEdit } as unknown as ProviderClient,
            providerModel,
            alias: "ark-fallback",
            kind: "openai",
          },
        ],
      }),
      isPriced: options.priced === undefined ? undefined : () => options.priced === true,
      costOf,
    });
    return { ...fixture, create, fallback, imageEdit, result, costOf };
  }
  it.each([
    [flash, flash],
    [pro, pro],
    ["ark/seedream-5.0-flash", flash],
    ["ark/seedream-5.0-pro", pro],
    ["seedream-flash", flash],
    ["seedream-pro", pro],
    ["configured-custom-alias", flash],
  ])("validates after resolving public model %s", async (model, wire) => {
    const fixture = arkSetup(wire);
    const body = {
      model,
      prompt: "湖面",
      image: [source, source],
      size: "1.5K",
      response_format: "url",
    };
    const res = await post(fixture.app, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fixture.result);
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(
      { ...body, model: wire },
      expect.anything(),
    );
    expect(fixture.fallback).not.toHaveBeenCalled();
  });
  it.each([
    flash,
    pro,
  ])("preserves automatic layer input/output and metadata for %s", async (model) => {
    const result = {
      model,
      created: 1,
      data: [
        { url: source, size: "1024x1024", output_format: "jpeg", z_index: 0 },
        {
          url: source,
          size: "512x512",
          output_format: "png",
          z_index: 1,
          bounding_box: { absolute: [0, 0, 512, 512], normalized: [0, 0, 500, 500] },
          name: "主体",
          description: "前景主体",
        },
      ],
      usage: { input_images: 1, generated_images: 2, output_tokens: 5120, total_tokens: 5120 },
    };
    const fixture = arkSetup(model, { result });
    const body = {
      model: "configured-layer-alias",
      image: source,
      layer_decomposition: true,
      size: "auto",
    };
    const res = await post(fixture.app, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({ ...body, model }, expect.anything());
    const payload = fixture.enqueuePayload.mock.calls[0]?.[0];
    expect(JSON.parse(payload.responseJson)).toEqual(result);
  });
  it.each([
    { stream: true },
    { n: 1 },
    { tools: [] },
    { sequential_image_generation: "disabled" },
    { image: Array(11).fill(source) },
    { image: "http://example.com/a.png" },
    { size: "4K" },
    { layer_decomposition: true, image: [source, source] },
    { unexpected: true },
  ])("rejects unsupported parameters behind arbitrary aliases before POST: %j", async (fields) => {
    const fixture = arkSetup();
    expect((await post(fixture.app, { model: "any-alias", prompt: "x", ...fields })).status).toBe(
      400,
    );
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.fallback).not.toHaveBeenCalled();
  });
  it("does not relax prompt requirements for non-Ark targets", async () => {
    const fixture = setup();
    expect(
      (await post(fixture.app, { model: "gpt-image-2", layer_decomposition: true, image: source }))
        .status,
    ).toBe(400);
    expect(fixture.imageGeneration).not.toHaveBeenCalled();
  });
  it.each([
    "doubao-seedance-2-5-260628",
    "doubao-seed3d-2-0-260328",
  ])("rejects wrong media capability %s", async (model) => {
    const fixture = arkSetup(model);
    expect((await post(fixture.app, { model: "alias", prompt: "x" })).status).toBe(400);
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it("rejects Ark multipart/JSON edits surface even if the client exposes imageEdit", async () => {
    const fixture = arkSetup();
    const res = await fixture.app.request("/v1/images/edits", {
      method: "POST",
      headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream-flash", prompt: "Edit", image: { url: source } }),
    });
    expect(res.status).toBe(400);
    expect(fixture.imageEdit).not.toHaveBeenCalled();
  });
  it.each([
    false,
    true,
    undefined,
  ])("rejects spend-capped Ark even when pricing hook says %s", async (priced) => {
    const fixture = arkSetup(flash, { spendCapped: true, priced });
    const res = await post(fixture.app, { model: "seedream-flash", prompt: "x" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "media_pricing_unavailable" } });
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it("rejects a plain image returned for layer decomposition without replay", async () => {
    const fixture = arkSetup();
    const res = await post(fixture.app, { model: flash, image: source, layer_decomposition: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.fallback).not.toHaveBeenCalled();
  });
  it("rejects the wrong delivery carrier without replay", async () => {
    const fixture = arkSetup();
    const res = await post(fixture.app, { model: flash, prompt: "x", response_format: "b64_json" });
    expect(res.status).toBe(503);
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.fallback).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { model: flash, created: 1, data: [{ url: source }] },
    { model: pro, created: 1, data: [{ url: source, size: "1024x1024", output_format: "png" }] },
  ])("rejects malformed or wrong-model success without a second POST", async (result) => {
    const fixture = arkSetup(flash, { result });
    const res = await post(fixture.app, { model: flash, prompt: "x" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.fallback).not.toHaveBeenCalled();
  });
});

describe("Ark route through SDK with offline HTTP boundary", () => {
  const models = ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro-260628"] as const;
  function sdkFixture(model: string, fetch: typeof globalThis.fetch) {
    const media = createArkMediaClient({
      config: {
        baseUrl: "https://ark.example.test/api/v3",
        apiKey: "offline-ark-test-key",
        timeoutMs: 1000,
      },
      fetch,
    });
    const fallback = vi.fn();
    const fixture = setup({
      auth: {
        resolve: async () =>
          ({ keyId: "ark-key", accountId: "acct", caps: {} }) as MessagesIdentity,
      },
      resolveImageChain: () => ({
        ok: true,
        laneName: "image",
        candidateChain: ["ark-primary", "ark-fallback"],
        targets: [
          {
            client: media as unknown as ProviderClient,
            providerModel: model,
            alias: "ark-primary",
            kind: "openai",
          },
          {
            client: { imageGeneration: fallback } as unknown as ProviderClient,
            providerModel: model,
            alias: "ark-fallback",
            kind: "openai",
          },
        ],
      }),
      isPriced: () => false,
      costOf: () => {
        throw new Error("Ark must not use chat token pricing");
      },
    });
    return { ...fixture, fallback };
  }
  it.each(models)("serves %s through the real SDK with exactly one mock POST", async (model) => {
    const result = {
      model,
      created: 1,
      data: [{ b64_json: "AAAA", size: "1024x1024", output_format: "png" }],
      usage: { generated_images: 1, input_images: 0, output_tokens: 4096, total_tokens: 4096 },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(result));
    const fixture = sdkFixture(model, fetch);
    const body = {
      model: "public-image-alias",
      prompt: "湖面",
      response_format: "b64_json",
      output_format: "png",
    };
    const res = await post(fixture.app, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://ark.example.test/api/v3/images/generations");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ ...body, model });
    expect(fixture.fallback).not.toHaveBeenCalled();
  });
  it.each(
    models.flatMap((model) => [400, 429, 503, 0].map((status) => [model, status] as const)),
  )("handles %s HTTP %s without duplicate POST or leaking error text", async (model, status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      if (status === 0) throw new Error("Connection lost");
      return Response.json(
        {
          error: {
            code: "SetLimitExceeded",
            message: "account-linked detail offline-ark-test-key",
          },
        },
        { status },
      );
    });
    const fixture = sdkFixture(model, fetch);
    const res = await post(fixture.app, { model, prompt: "x" });
    expect(res.status).toBe(status === 400 || status === 429 ? status : 503);
    const response = await res.text();
    expect(response).toContain(
      status === 400 || status === 429 ? "SetLimitExceeded" : "outcome_unknown",
    );
    expect(response).not.toContain("account-linked");
    expect(response).not.toContain("offline-ark-test-key");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fixture.fallback).not.toHaveBeenCalled();
  });
  it("times out after one SDK POST and does not send a fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
        else
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
      });
    });
    const fixture = sdkFixture(models[0], fetch);
    const res = await post(fixture.app, { model: models[0], prompt: "x" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fixture.fallback).not.toHaveBeenCalled();
  });
});
