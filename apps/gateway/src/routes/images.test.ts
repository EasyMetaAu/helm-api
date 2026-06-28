import type { CircuitBreaker, ProviderClient } from "@helm/core";
import { UpstreamError } from "@helm/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
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
  const client = { imageGeneration } as unknown as ProviderClient;
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
  return { app, imageGeneration, enqueuePayload, enqueueTelemetry };
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
