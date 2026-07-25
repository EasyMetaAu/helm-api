import type { CircuitBreaker, ProviderClient } from "@helm/core";
import { UpstreamError } from "@helm/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function setup(over: Partial<ImagesRouteDeps> = {}) {
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
              caps: { budget: BUDGET_CAPS },
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
    const { app, imageEdit } = setup();
    const body = new FormData();
    body.set("model", "gpt-image-2");
    body.set("prompt", "add snow");
    body.append("image[]", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png");

    const res = await app.request("/v1/images/edits", {
      method: "POST",
      headers: { Authorization: "Bearer k" },
      body,
    });

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

  it("returns 401 without a valid key", async () => {
    const { app } = setup();
    const res = await post(app, { model: "gpt-image-2", prompt: "x" }, "Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("rejects an over-capacity body before JSON parsing and releases its lease", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      maxWireBytes: 10,
      jsonAmplification: 6,
    });
    const { app, imageGeneration } = setup({ memoryAdmission });

    const res = await post(app, { model: "gpt-image-2", prompt: "a cat" });

    expect(res.status).toBe(413);
    expect((await res.json()) as unknown).toMatchObject({
      error: { type: "invalid_request_error", code: "request_too_large" },
    });
    expect(imageGeneration).not.toHaveBeenCalled();
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("returns an OpenAI 503 with Retry-After when runtime request capacity is busy", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1,
      maxWireBytes: 1000,
      jsonAmplification: 1,
    });
    const { app, imageGeneration } = setup({ memoryAdmission });

    const res = await post(app, { model: "gpt-image-2", prompt: "a cat" });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await res.json()) as unknown).toMatchObject({
      error: { type: "server_error", code: "server_overloaded" },
    });
    expect(imageGeneration).not.toHaveBeenCalled();
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("releases its memory lease after a successful image request", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1000,
      maxWireBytes: 1000,
      jsonAmplification: 1,
    });
    const { app } = setup({ memoryAdmission });

    expect((await post(app, { model: "gpt-image-2", prompt: "a cat" })).status).toBe(200);
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("releases its memory lease when image JSON is malformed", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1000,
      maxWireBytes: 1000,
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

  it("maps an UpstreamError to 502 and records an error decision", async () => {
    const { app, imageGeneration, enqueueTelemetry } = setup();
    imageGeneration.mockRejectedValueOnce(new UpstreamError("upstream_error", "boom", null, 400));
    const res = await post(app, { model: "gpt-image-2", prompt: "x" });

    expect(res.status).toBe(502);
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
