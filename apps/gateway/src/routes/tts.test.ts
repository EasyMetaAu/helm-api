import type { ProviderClient } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import type { MessagesIdentity } from "./messages.js";
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
      check: vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 2 }),
    };
    const { app } = setup({ rateLimiter });
    const response = await app.request("/v1/tts/voices", {
      headers: { Authorization: "Bearer k" },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
  });
});
