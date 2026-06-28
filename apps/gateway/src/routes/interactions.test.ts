import type { ProviderClient } from "@helm/core";
import { UpstreamError } from "@helm/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { type InteractionsRouteDeps, registerInteractionsRoute } from "./interactions.js";
import type { MessagesIdentity } from "./messages.js";
import type { RecordServedDeps } from "./payload-capture.js";

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

function setup(over: Partial<InteractionsRouteDeps> = {}) {
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
              caps: { budget: BUDGET_CAPS },
            } as MessagesIdentity)
          : null,
    },
    resolveImageTarget: (model) => {
      if (model === "gemini-3.1-flash-image")
        return {
          client,
          providerModel: "gemini-3.1-flash-image",
          alias: "gemini-3.1-flash-image",
          kind: "gemini",
        };
      if (model === "gpt-image-2")
        return {
          client,
          providerModel: "openai/gpt-image-2",
          alias: "gpt-image-2",
          kind: "openai",
        };
      return null;
    },
    costOf: () => 0.0672,
    record,
    ...over,
  };

  const app = new Hono<AppEnv>();
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

  it("strips the base64 image from the captured payload (DB-bloat guard)", async () => {
    const { app, enqueuePayload } = setup();
    await post(app, { model: "gemini-3.1-flash-image", input: "a cat" });
    const payload = enqueuePayload.mock.calls[0]?.[0];
    const stored = JSON.parse(payload.responseJson) as {
      steps: Array<{ content: Array<{ type: string; data?: string }> }>;
    };
    const img = stored.steps[0]?.content.find((b) => b.type === "image");
    expect(img?.data).toBe("[image omitted]");
  });

  it("returns 401 without a valid key", async () => {
    const { app } = setup();
    const res = await post(app, { model: "gemini-3.1-flash-image", input: "x" }, "wrong");
    expect(res.status).toBe(401);
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

  it("maps an UpstreamError to its status and records an error decision", async () => {
    const { app, nativePassthrough, enqueueTelemetry } = setup();
    nativePassthrough.mockRejectedValueOnce(new UpstreamError("upstream_error", "boom", null, 502));
    const res = await post(app, { model: "gemini-3.1-flash-image", input: "x" });
    expect(res.status).toBe(502);
    const decision = enqueueTelemetry.mock.calls[0]?.[0].decision;
    expect(decision.final.status).toBe("error");
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
      resolveImageTarget: () => ({ kind: "unavailable" }),
    });
    const res = await post(app, { model: "gemini-3.1-flash-image", input: "x" });
    expect(res.status).toBe(503);
    expect(nativePassthrough).not.toHaveBeenCalled();
  });
});
