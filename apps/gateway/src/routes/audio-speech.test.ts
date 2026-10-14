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
