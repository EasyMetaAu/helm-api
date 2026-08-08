import type { CircuitBreaker, ProviderClient } from "@helm/core";
import { UpstreamError } from "@helm/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { createBodyMemoryAdmission } from "../runtime/memory-admission.js";
import { type InteractionsRouteDeps, registerInteractionsRoute } from "./interactions.js";
import type { MessagesIdentity } from "./messages.js";
import type { RecordServedDeps } from "./payload-capture.js";

// Always-CLOSED breaker — fallback control flow is covered in image-chain.test.ts.
function closedBreaker(): CircuitBreaker {
  return {
    canAttempt: () => ({ allow: true, probe: false }),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordAbort: vi.fn(),
  } as unknown as CircuitBreaker;
}

// A generateContent native response: text + image parts + image-token usage.
const NATIVE = {
  candidates: [
    {
      content: {
        parts: [
          { text: "Here is your image:" },
          { inlineData: { mimeType: "image/png", data: "GEMIMG" } },
        ],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1120 },
};

const BUDGET_CAPS = {
  requests: null,
  tokens: null,
  spendUsd: 5,
  windowSeconds: null,
  behavior: "reject",
  degradeLane: null,
};

function setup(
  over: Partial<InteractionsRouteDeps> = {},
  contextIds?: { requestId: string; traceId: string },
  requestContentMode?: "none" | "payload" | "session",
) {
  const nativePassthrough = vi.fn().mockResolvedValue(NATIVE);
  const client = { nativePassthrough } as unknown as ProviderClient;
  const enqueuePayload = vi.fn();
  const enqueueTelemetry = vi.fn();
  const record = {
    telemetry: { insert: vi.fn() },
    redact: (d: unknown) => d,
    now: () => 0,
    capturePayloads: () => true,
    writes: { enqueuePayload, enqueueTelemetry },
  } as unknown as RecordServedDeps;

  const deps: InteractionsRouteDeps = {
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
    resolveImageChain: (model) => {
      if (model === "gemini-3.1-flash-image")
        return {
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
        };
      if (model === "gpt-image-2")
        return {
          ok: true,
          laneName: "image",
          candidateChain: ["gpt-image-2"],
          targets: [
            { client, providerModel: "openai/gpt-image-2", alias: "gpt-image-2", kind: "openai" },
          ],
        };
      return { ok: false, status: 404 };
    },
    breaker: closedBreaker(),
    costOf: () => 0.0672,
    record,
    ...over,
  };

  const app = new Hono<AppEnv>();
  if (contextIds !== undefined) {
    app.use("*", async (c, next) => {
      c.set("request_id", contextIds.requestId);
      c.set("trace_id", contextIds.traceId);
      await next();
    });
  }
  registerInteractionsRoute(app, deps);
  return { app, nativePassthrough, enqueuePayload, enqueueTelemetry };
}

function post(app: Hono<AppEnv>, body: unknown, key = "k") {
  return app.request("/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("registerInteractionsRoute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("translates input→generateContent, returns the interactions steps shape + records cost", async () => {
    const { app, nativePassthrough, enqueueTelemetry } = setup();
    const res = await post(app, {
      model: "gemini-3.1-flash-image",
      input: "a red apple",
      response_format: { type: "image", aspect_ratio: "16:9", image_size: "2K" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-helm-lane")).toBe("image");
    expect(res.headers.get("x-helm-final-model")).toBe("gemini-3.1-flash-image");

    const json = (await res.json()) as {
      id: string;
      steps: Array<{
        type: string;
        content: Array<{ type: string; data?: string; text?: string }>;
      }>;
    };
    expect(json.id).toMatch(/^int_/);
    const content = json.steps[0]?.content ?? [];
    expect(content.find((b) => b.type === "image")?.data).toBe("GEMIMG"); // full image to client
    expect(content.find((b) => b.type === "text")?.text).toBe("Here is your image:");

    // upstream got a generateContent call: wire model + responseModalities IMAGE + imageConfig
    expect(nativePassthrough).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.1-flash-image",
        contents: [{ role: "user", parts: [{ text: "a red apple" }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
        },
      }),
      expect.anything(),
    );

    const decision = enqueueTelemetry.mock.calls[0]?.[0].decision;
    expect(decision.lane.selected_lane).toBe("image");
    expect(decision.final.model_alias).toBe("gemini-3.1-flash-image");
    expect(decision.usage.completion_tokens).toBe(1120);
    expect(decision.provider_attempts[0].cost_usd).toBe(0.0672);
  });

  it("builds the interaction id from the internal request_id, not the client trace_id", async () => {
    const { app } = setup(
      {},
      { requestId: "server-request-123", traceId: "client-controlled-trace" },
    );

    const res = await post(app, {
      model: "gemini-3.1-flash-image",
      input: "a red apple",
    });
    const json = (await res.json()) as { id: string };

    expect(res.status).toBe(200);
    expect(json.id).toBe("int_server-request-123");
    expect(json.id).not.toBe("int_client-controlled-trace");
  });

  it("does not enforce the former hard body limit before JSON parsing", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    const { app, nativePassthrough } = setup({ memoryAdmission });

    const res = await post(app, { model: "gemini-3.1-flash-image", input: "a red apple" });

    expect(res.status).toBe(200);
    expect(nativePassthrough).toHaveBeenCalledOnce();
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("does not return Gemini capacity 503 when historical request capacity is exhausted", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1,
      jsonAmplification: 1,
    });
    const { app, nativePassthrough } = setup({ memoryAdmission });

    const res = await post(app, { model: "gemini-3.1-flash-image", input: "a red apple" });

    expect(res.status).toBe(200);
    expect(nativePassthrough).toHaveBeenCalled();
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("releases its memory lease after a successful interactions request", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1000,
      jsonAmplification: 1,
    });
    const { app } = setup({ memoryAdmission });

    expect(
      (await post(app, { model: "gemini-3.1-flash-image", input: "a red apple" })).status,
    ).toBe(200);
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("releases its memory lease when interactions JSON is malformed", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1000,
      jsonAmplification: 1,
    });
    const { app } = setup({ memoryAdmission });

    const res = await app.request("/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": "k", "Content-Type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("translates an array input with text + image blocks into generateContent parts", async () => {
    const { app, nativePassthrough } = setup();
    await post(app, {
      model: "gemini-3.1-flash-image",
      input: [
        { type: "text", text: "edit this" },
        { type: "image", mime_type: "image/jpeg", data: "INPUTIMG" },
      ],
    });
    expect(nativePassthrough).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          {
            role: "user",
            parts: [
              { text: "edit this" },
              { inlineData: { mimeType: "image/jpeg", data: "INPUTIMG" } },
            ],
          },
        ],
      }),
      expect.anything(),
    );
  });

  it("forwards generation_config (thinking_level → thinkingConfig) while forcing IMAGE output", async () => {
    const { app, nativePassthrough } = setup();
    await post(app, {
      model: "gemini-3.1-flash-image",
      input: "a cat",
      generation_config: { thinking_level: "high", temperature: 0.5 },
    });
    const [body] = nativePassthrough.mock.calls[0] as [
      { generationConfig: Record<string, unknown> },
    ];
    expect(body.generationConfig).toMatchObject({
      responseModalities: ["TEXT", "IMAGE"], // forced, always present
      thinkingConfig: { thinkingLevel: "high" }, // snake input → camel generateContent
      temperature: 0.5, // other fields ride through
    });
  });

  it("captures the FULL image verbatim (the store externalizes it to payload_blobs)", async () => {
    // No route-level strip: the store's externalizeImages content-addresses the image
    // into payload_blobs (lean request_payloads) AND makes it viewable in the admin.
    const { app, enqueuePayload } = setup();
    await post(app, { model: "gemini-3.1-flash-image", input: "a cat" });
    const payload = enqueuePayload.mock.calls[0]?.[0];
    const stored = JSON.parse(payload.responseJson) as {
      steps: Array<{ content: Array<{ type: string; data?: string }> }>;
    };
    const img = stored.steps[0]?.content.find((b) => b.type === "image");
    expect(img?.data).toBe("GEMIMG"); // full image handed to capture
  });

  it("per-key metadata-only mode overrides enabled system payload capture", async () => {
    const { app, enqueuePayload } = setup({}, undefined, "none");
    const res = await post(app, { model: "gemini-3.1-flash-image", input: "a cat" });

    expect(res.status).toBe(200);
    expect(enqueuePayload).not.toHaveBeenCalled();
  });

  it("returns 401 without a valid key", async () => {
    const { app } = setup();
    const res = await post(app, { model: "gemini-3.1-flash-image", input: "x" }, "wrong");
    expect(res.status).toBe(401);
  });

  it("rejects a direct Gemini image model that is blocked for the key", async () => {
    const { app, nativePassthrough, enqueueTelemetry } = setup({
      auth: {
        resolve: async (cred) =>
          cred === "k"
            ? ({
                keyId: "key1",
                accountId: "acct",
                keyPrefix: "helm_live_xy",
                caps: { budget: BUDGET_CAPS, blockedModels: ["GEMINI-3.1-*-IMAGE"] },
              } as MessagesIdentity)
            : null,
      },
    });

    const res = await post(app, { model: "gemini-3.1-flash-image", input: "x" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; status: string } };
    expect(body.error.message).toContain("blocked for this key");
    expect(body.error.status).toBe("INVALID_ARGUMENT");
    expect(nativePassthrough).not.toHaveBeenCalled();
    expect(enqueueTelemetry).not.toHaveBeenCalled();
  });

  it("removes blocked Gemini image candidates from a lane before fallback execution", async () => {
    const blockedNativePassthrough = vi.fn().mockResolvedValue(NATIVE);
    const allowedNativePassthrough = vi.fn().mockResolvedValue(NATIVE);
    const blockedClient = {
      nativePassthrough: blockedNativePassthrough,
    } as unknown as ProviderClient;
    const allowedClient = {
      nativePassthrough: allowedNativePassthrough,
    } as unknown as ProviderClient;
    const { app, enqueueTelemetry } = setup({
      auth: {
        resolve: async (cred) =>
          cred === "k"
            ? ({
                keyId: "key1",
                accountId: "acct",
                keyPrefix: "helm_live_xy",
                caps: { budget: BUDGET_CAPS, blockedModels: ["GEMINI-IMAGE-PRI*"] },
              } as MessagesIdentity)
            : null,
      },
      resolveImageChain: (model) =>
        model === "image-lane"
          ? {
              ok: true,
              laneName: "image-lane",
              candidateChain: ["gemini-image-primary", "gemini-image-fallback"],
              targets: [
                {
                  client: blockedClient,
                  providerModel: "gemini-image-primary",
                  alias: "gemini-image-primary",
                  kind: "gemini",
                },
                {
                  client: allowedClient,
                  providerModel: "gemini-image-fallback",
                  alias: "gemini-image-fallback",
                  kind: "gemini",
                },
              ],
            }
          : { ok: false, status: 404 },
      costOf: (alias) => (alias === "gemini-image-fallback" ? 0.07 : null),
    });

    const res = await post(app, { model: "image-lane", input: "x" });

    expect(res.status).toBe(200);
    expect(blockedNativePassthrough).not.toHaveBeenCalled();
    expect(allowedNativePassthrough).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-image-fallback" }),
      expect.anything(),
    );
    expect(res.headers.get("x-helm-final-model")).toBe("gemini-image-fallback");

    const decision = enqueueTelemetry.mock.calls[0]?.[0].decision;
    expect(decision.lane.candidate_chain).toEqual(["gemini-image-fallback"]);
    expect(decision.provider_attempts.map((a: { alias: string }) => a.alias)).toEqual([
      "gemini-image-fallback",
    ]);
  });

  it("returns 404 for a model that is not a configured image model", async () => {
    const { app } = setup();
    const res = await post(app, { model: "not-an-image-model", input: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an OpenAI image model (→ use /v1/images/generations)", async () => {
    const { app, nativePassthrough } = setup();
    const res = await post(app, { model: "gpt-image-2", input: "x" });
    expect(res.status).toBe(400);
    expect(nativePassthrough).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body (missing input)", async () => {
    const { app } = setup();
    const res = await post(app, { model: "gemini-3.1-flash-image" });
    expect(res.status).toBe(400);
  });

  it("maps an ambiguous UpstreamError to outcome_unknown without replaying the paid write", async () => {
    const { app, nativePassthrough, enqueueTelemetry } = setup();
    nativePassthrough.mockRejectedValueOnce(new UpstreamError("upstream_error", "boom", null, 502));
    const res = await post(app, { model: "gemini-3.1-flash-image", input: "x" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: 503,
        message: "image create outcome is unknown",
        status: "INTERNAL",
      },
    });
    expect(nativePassthrough).toHaveBeenCalledOnce();
    const decision = enqueueTelemetry.mock.calls[0]?.[0].decision;
    expect(decision.final.status).toBe("error");
    expect(decision.final.error_reason).toBe("outcome_unknown");
    expect(decision.provider_attempts[0].error_class).toBe("upstream_error");
    expect(decision.provider_attempts[0].cost_usd).toBeNull();
  });

  it("enforces the per-key budget: over budget (reject) → 429, no upstream call", async () => {
    const { app, nativePassthrough } = setup({
      budgetGate: {
        check: async () => ({
          overBudget: true,
          behavior: "reject" as const,
          limitedBy: null,
          degradeLane: null,
        }),
      },
    });
    const res = await post(app, { model: "gemini-3.1-flash-image", input: "x" });
    expect(res.status).toBe(429);
    expect(nativePassthrough).not.toHaveBeenCalled();
  });

  it("settles the served cost + tokens against the budget", async () => {
    const settleBudget = vi.fn();
    const { app } = setup({ settleBudget });
    await post(app, { model: "gemini-3.1-flash-image", input: "a cat" });
    expect(settleBudget).toHaveBeenCalledOnce();
    const [, , usage] = settleBudget.mock.calls[0] as [
      string,
      unknown,
      { requests: number; tokens: number; costUsd: number | null },
    ];
    expect(usage).toEqual({ requests: 1, tokens: 1129, costUsd: 0.0672 }); // 9 + 1120
  });

  it("returns 503 when a configured image provider is unavailable (missing credential)", async () => {
    const { app, nativePassthrough } = setup({
      resolveImageChain: () => ({ ok: false, status: 503 }),
    });
    const res = await post(app, { model: "gemini-3.1-flash-image", input: "x" });
    expect(res.status).toBe(503);
    expect(nativePassthrough).not.toHaveBeenCalled();
  });
});
