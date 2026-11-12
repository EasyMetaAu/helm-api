import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { type AudioSpeechRouteDeps, registerAudioSpeechRoute } from "./audio-speech.js";

const body = { model: "speech-fast", input: "Hello", voice: "voice" };
function setup(caps: Record<string, unknown> = {}) {
  const speech = vi.fn().mockResolvedValue({
    audio: new Uint8Array([1, 2]),
    contentType: "audio/mpeg",
    usage: { usage_characters: 5, usage_voice_count: 1 },
  });
  const release = vi.fn();
  const identity = { keyId: "k", accountId: "a", caps };
  const resolve = vi.fn().mockReturnValue({
    client: { ttsSpeech: speech },
    model: "speech-2.8-hd",
    alias: "minimax/speech",
    lane: "speech-fast",
    customModel: false,
  });
  const deps: AudioSpeechRouteDeps = {
    auth: { resolve: async (k) => (k === "key" ? identity : null) },
    resolve,
    concurrencyGate: { acquire: async () => ({ ok: true, release }) },
  };
  const app = new Hono<AppEnv>();
  registerAudioSpeechRoute(app, deps);
  const call = (data = body, auth = "Bearer key") =>
    app.request("/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: auth },
      body: JSON.stringify(data),
    });
  return { call, speech, release, resolve, identity, deps };
}
describe("audio speech route", () => {
  it.each([
    undefined,
    24000,
  ])("uses the selected provider default only when sample_rate is omitted (%s)", async (sampleRate) => {
    const x = setup();
    x.resolve.mockReturnValue({ ...x.resolve(), defaultSampleRate: 22050 });
    const result = await x.call({
      ...body,
      ...(sampleRate === undefined ? {} : { sample_rate: sampleRate }),
    });
    expect(result.status).toBe(200);
    expect(x.speech.mock.calls[0]?.[0].sample_rate).toBe(sampleRate ?? 22050);
  });
  it("keeps the existing sample rate when no provider default is supplied", async () => {
    const x = setup();
    expect((await x.call()).status).toBe(200);
    expect(x.speech.mock.calls[0]?.[0].sample_rate).toBe(32000);
  });
  it("preserves successful paid audio when accounting fails", async () => {
    const x = setup();
    x.deps.record = async () => {
      throw new Error("telemetry unavailable");
    };
    const response = await x.call();
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2]);
    expect(x.speech).toHaveBeenCalledTimes(1);
    expect(x.release).toHaveBeenCalledTimes(1);
  });
  it("resolves lane with identity and invokes wire model", async () => {
    const x = setup();
    const result = await x.call();
    expect(result.status).toBe(200);
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([1, 2]);
    expect(x.resolve).toHaveBeenCalledWith("speech-fast", x.identity);
    expect(x.speech.mock.calls[0]?.[0].model).toBe("speech-2.8-hd");
    expect(x.release).toHaveBeenCalledTimes(1);
  });
  it.each([
    { budget: { spendUsd: 1 } },
    { budget: { weeklyAnchor: "2026-11-08T16:00:00Z", tokens: 100 } },
    { allowedLanes: [] },
    { blockedModels: ["MINIMAX/*"] },
  ])("rejects key restrictions before paid work", async (caps) => {
    const x = setup(caps);
    expect((await x.call()).status).toBeGreaterThanOrEqual(400);
    expect(x.speech).not.toHaveBeenCalled();
  });
  it("rejects client policy and concrete-model overrides", async () => {
    const policy = setup({ clientPolicy: { allowed_clients: ["codex_app"] } });
    expect((await policy.call()).status).toBe(403);
    const custom = setup();
    custom.resolve.mockReturnValue({ ...custom.resolve(), customModel: true });
    expect((await custom.call()).status).toBe(403);
    expect(custom.speech).not.toHaveBeenCalled();
  });
  it("releases an unconsumed HTTP stream on lease abort", async () => {
    const x = setup();
    const controller = new AbortController();
    x.deps.concurrencyGate = {
      acquire: async () => ({ ok: true, release: x.release, signal: controller.signal }),
    };
    x.resolve.mockReturnValue({
      ...x.resolve(),
      client: {
        ttsSpeech: x.speech,
        async *streamSpeech() {
          yield { type: "audio", sequence: 0, audio: new Uint8Array([1]) };
          yield { type: "completed", sequence: 1 };
        },
      },
    });
    const response = await x.call({ ...body, stream: true } as typeof body);
    expect(response.status).toBe(200);
    expect(x.release).not.toHaveBeenCalled();
    controller.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(x.release).toHaveBeenCalledTimes(1);
    await expect(response.body?.cancel()).rejects.toThrow("aborted");
    expect(x.release).toHaveBeenCalledTimes(1);
  });
  it("does not call upstream when the acquired lease is already aborted", async () => {
    const x = setup();
    const controller = new AbortController();
    controller.abort();
    x.deps.concurrencyGate = {
      acquire: async () => ({ ok: true, signal: controller.signal, release: x.release }),
    };
    expect((await x.call()).status).toBe(499);
    expect(x.speech).not.toHaveBeenCalled();
    expect(x.release).toHaveBeenCalledTimes(1);
  });
  it("holds a streaming lease through audio and records usage at completion", async () => {
    const x = setup();
    const record = vi.fn();
    x.deps.record = record;
    x.resolve.mockReturnValue({
      ...x.resolve(),
      client: {
        ttsSpeech: x.speech,
        async *streamSpeech() {
          yield { type: "audio", sequence: 0, audio: new Uint8Array([1]) };
          yield {
            type: "usage",
            sequence: 1,
            usage: { usage_characters: 5, usage_voice_count: 1 },
          };
          yield { type: "completed", sequence: 2 };
        },
      },
    });
    const response = await x.call({ ...body, stream: true } as typeof body);
    expect(x.release).not.toHaveBeenCalled();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1]);
    expect(x.release).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        usage: { usage_characters: 5, usage_voice_count: 1 },
      }),
    );
  });
  it("requires authentication and rejects unsupported parameters", async () => {
    const x = setup();
    expect((await x.call(body, "bad")).status).toBe(401);
    expect((await x.call({ ...body, instructions: "unsupported" } as typeof body)).status).toBe(
      400,
    );
    expect(x.speech).not.toHaveBeenCalled();
  });
});

describe("structured speech response", () => {
  it("returns audio and actual alignment only when JSON is requested", async () => {
    const x = setup();
    x.speech.mockResolvedValueOnce({
      audio: new Uint8Array([1, 2]),
      contentType: "audio/mpeg",
      usage: { usage_characters: 5, usage_voice_count: 1 },
      timestamps: [{ text: "Hello", startMs: 10, endMs: 200 }],
    } as never);
    const response = await x.call({
      ...body,
      output: "json",
      timestamps: "sentence",
    } as typeof body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      audio: "AQI=",
      contentType: "audio/mpeg",
      timestamps: [{ text: "Hello", startMs: 10, endMs: 200 }],
    });
  });
  it("rejects timestamp requests on binary responses before paid generation", async () => {
    const x = setup();
    expect((await x.call({ ...body, timestamps: "word" } as typeof body)).status).toBe(422);
    expect(x.speech).not.toHaveBeenCalled();
  });
});

describe("speech spend reservation", () => {
  it("reserves before generation and returns durable accounting reference", async () => {
    const x = setup({ budget: { spendUsd: 1 } });
    const reserved = {
      id: "op",
      keyId: "k",
      alias: "minimax/speech",
      providerModel: "speech-2.8-hd",
      state: "reserved",
      reservedUsd: 0.1,
      costUsd: null,
      capacity: 1,
      windowMs: 86400000,
      admittedAtMs: 0,
      anchorMs: null,
      usage: null,
    } as const;
    const reserve = vi.fn(async () => reserved);
    const settle = vi.fn(async () => ({ ...reserved, state: "settled" as const, costUsd: 0.01 }));
    x.deps.accounting = { reserve, settle, get: async () => null };
    x.deps.budgetGate = {
      check: async () => ({
        overBudget: false,
        limitedBy: null,
        behavior: "reject",
        degradeLane: null,
      }),
    };
    const response = await x.call({ ...body, output: "json" } as typeof body);
    expect(response.status).toBe(200);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      x.speech.mock.invocationCallOrder[0] ?? 0,
    );
    expect(await response.json()).toMatchObject({
      accounting: { operationId: "op", state: "settled", costUsd: 0.01 },
    });
  });
  it("does not send paid work when reservation fails", async () => {
    const x = setup();
    x.deps.accounting = {
      reserve: async () => {
        throw new Error("store unavailable");
      },
      settle: async () => null,
      get: async () => null,
    };
    expect((await x.call()).status).toBeGreaterThanOrEqual(500);
    expect(x.speech).not.toHaveBeenCalled();
  });
});
