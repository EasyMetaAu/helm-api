import { type ProviderClient, UpstreamError } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { createBodyMemoryAdmission } from "../runtime/memory-admission.js";
import type { MessagesIdentity } from "./messages.js";
import type { RecordServedDeps } from "./payload-capture.js";
import { registerTtsRoute, type TtsRouteDeps } from "./tts.js";

const identity = { keyId: "key", accountId: "acct" } as MessagesIdentity;

function setup(over: Partial<TtsRouteDeps> = {}) {
  const ttsSpeech = vi
    .fn()
    .mockResolvedValue({ audio: new Uint8Array([1, 2, 3]), contentType: "audio/mpeg" });
  const ttsVoices = vi.fn().mockResolvedValue({ voices: [{ id: "eve" }] });
  const deps: TtsRouteDeps = {
    auth: { resolve: async (key) => (key === "k" ? identity : null) },
    resolve: () => ({ ttsSpeech, ttsVoices }) as unknown as ProviderClient,
    ...over,
  };
  const app = new Hono<AppEnv>();
  registerTtsRoute(app, deps);
  return { app, ttsSpeech, ttsVoices };
}

describe("TTS routes", () => {
  it("requires a Helm API key", async () => {
    const { app } = setup();
    expect((await app.request("/v1/tts/voices")).status).toBe(401);
  });

  it("returns voices and audio", async () => {
    const { app, ttsSpeech, ttsVoices } = setup();
    const voices = await app.request("/v1/tts/voices", { headers: { Authorization: "Bearer k" } });
    expect(voices.status).toBe(200);
    expect(await voices.json()).toEqual({ voices: [{ id: "eve" }] });
    const speech = await app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", voice_id: "eve" }),
    });
    expect(speech.status).toBe(200);
    expect(speech.headers.get("content-type")).toContain("audio/mpeg");
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(ttsVoices).toHaveBeenCalledOnce();
    expect(ttsSpeech).toHaveBeenCalledWith({ text: "hello", voice_id: "eve" }, expect.anything());
  });

  it("rejects malformed speech input and unavailable providers", async () => {
    const { app } = setup({ resolve: () => null });
    const noProvider = await app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(noProvider.status).toBe(503);
    const malformed = await setup().app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(malformed.status).toBe(400);
  });

  it("applies the optional rate limiter", async () => {
    const rateLimiter = {
      check: vi.fn().mockResolvedValue({
        allowed: false,
        retryAfterSeconds: 2,
        limit: 10,
        remaining: 0,
        resetSeconds: 2,
        limitedBy: "rpm",
      }),
    };
    const { app } = setup({ rateLimiter });
    const response = await app.request("/v1/tts/voices", {
      headers: { Authorization: "Bearer k" },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-ratelimit-limit")).toBe("10");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(response.headers.get("x-ratelimit-reset")).toBe("2");
  });

  it("publishes rate-limit headers on an allowed request", async () => {
    const rateLimiter = {
      check: vi.fn().mockResolvedValue({
        allowed: true,
        retryAfterSeconds: 0,
        limit: 10,
        remaining: 9,
        resetSeconds: 60,
        limitedBy: null,
      }),
    };
    const response = await setup({ rateLimiter }).app.request("/v1/tts/voices", {
      headers: { Authorization: "Bearer k" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("10");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("9");
    expect(response.headers.get("x-ratelimit-reset")).toBe("60");
  });

  it("fails closed before a paid POST when the key is over budget", async () => {
    const budget = {
      requests: 10,
      tokens: null,
      spendUsd: null,
      windowSeconds: null,
      behavior: "degrade" as const,
      degradeLane: "economy",
    };
    const budgetGate = {
      check: vi.fn().mockResolvedValue({
        overBudget: true,
        limitedBy: "requests",
        behavior: "degrade",
        degradeLane: "economy",
      }),
    };
    const { app, ttsSpeech } = setup({
      auth: {
        resolve: async (key) =>
          key === "k" ? ({ ...identity, caps: { budget } } as MessagesIdentity) : null,
      },
      budgetGate,
    });
    const response = await app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(response.status).toBe(429);
    expect(ttsSpeech).not.toHaveBeenCalled();
  });

  it("rejects spend-capped keys until TTS pricing exists", async () => {
    const budget = {
      requests: null,
      tokens: null,
      spendUsd: 1,
      windowSeconds: null,
      behavior: "reject" as const,
      degradeLane: null,
    };
    const { app, ttsSpeech } = setup({
      auth: {
        resolve: async (key) =>
          key === "k" ? ({ ...identity, caps: { budget } } as MessagesIdentity) : null,
      },
    });
    const response = await app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(response.status).toBe(422);
    expect(ttsSpeech).not.toHaveBeenCalled();
  });

  it("settles one request and records body-free audio metadata with the OAuth account", async () => {
    const budget = {
      requests: 10,
      tokens: null,
      spendUsd: null,
      windowSeconds: null,
      behavior: "reject" as const,
      degradeLane: null,
    };
    const settleBudget = vi.fn();
    const recordOAuthUsage = vi.fn();
    const enqueuePayload = vi.fn();
    const enqueueTelemetry = vi.fn();
    const record = {
      telemetry: { insert: vi.fn() },
      redact: (decision: unknown) => decision,
      now: () => 100,
      capturePayloads: () => true,
      writes: { enqueuePayload, enqueueTelemetry },
    } as unknown as RecordServedDeps;
    const { app } = setup({
      auth: {
        resolve: async (key) =>
          key === "k"
            ? ({
                ...identity,
                keyPrefix: "helm_live_tt",
                caps: { budget, requestContentMode: "payload" },
              } as MessagesIdentity)
            : null,
      },
      budgetGate: {
        check: vi.fn().mockResolvedValue({
          overBudget: false,
          limitedBy: null,
          behavior: "reject",
          degradeLane: null,
        }),
      },
      settleBudget,
      record,
      captureServingAccount: async (call) => ({
        result: await call(),
        servingAccount: { providerId: "xai", account: "oauth-a" },
      }),
      recordOAuthUsage,
    });
    const response = await app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", voice_id: "eve" }),
    });
    expect(response.status).toBe(200);
    expect(settleBudget).toHaveBeenCalledOnce();
    expect(settleBudget).toHaveBeenCalledWith(
      "key",
      budget,
      { requests: 1, tokens: 0, costUsd: null },
      expect.any(Number),
    );
    expect(recordOAuthUsage).toHaveBeenCalledWith(
      { providerId: "xai", account: "oauth-a" },
      "xai/tts",
      { tokens: 0, costUsd: null },
    );
    expect(enqueueTelemetry.mock.calls[0]?.[0].decision).toMatchObject({
      requested_model: "tts",
      serving_account: { provider_id: "xai", account: "oauth-a" },
      final: { model_alias: "xai/tts", status: "ok" },
    });
    expect(JSON.parse(enqueuePayload.mock.calls[0]?.[0].responseJson)).toEqual({
      content_type: "audio/mpeg",
      bytes: 3,
    });
  });

  it("preserves client-abort and timeout classifications", async () => {
    const abort = new Error("client aborted");
    abort.name = "AbortError";
    const aborted = setup({
      resolve: () => ({
        ttsVoices: vi.fn(),
        ttsSpeech: vi.fn().mockRejectedValue(abort),
      }),
    });
    const abortResponse = await aborted.app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(abortResponse.status).toBe(499);

    const timedOut = setup({
      resolve: () => ({
        ttsVoices: vi.fn(),
        ttsSpeech: vi.fn().mockRejectedValue(new UpstreamError("timeout", "upstream timed out")),
      }),
    });
    const timeoutResponse = await timedOut.app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(timeoutResponse.status).toBe(504);
  });

  it("renders memory admission failures as retryable server errors", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1024,
      jsonAmplification: 1,
      minRequestChargeBytes: 1,
    });
    memoryAdmission.pause();
    const response = await setup({ memoryAdmission }).app.request("/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({
      error: { type: "server_error", code: "database_maintenance" },
    });
  });
});
