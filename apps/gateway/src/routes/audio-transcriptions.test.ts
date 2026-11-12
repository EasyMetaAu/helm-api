import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { registerAudioTranscriptionsRoute } from "./audio-transcriptions.js";

describe("multipart transcription boundary", () => {
  it.each([
    undefined,
    { allowedLanes: [] },
    {
      budget: {
        spendUsd: 1,
        requests: null,
        tokens: null,
        windowSeconds: null,
        behavior: "reject" as const,
        degradeLane: null,
      },
    },
  ])("enforces permissions before paid work (%j)", async (caps) => {
    const app = new Hono<AppEnv>();
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello" });
    const release = vi.fn();
    registerAudioTranscriptionsRoute(app, {
      auth: { resolve: async () => ({ keyId: "k", accountId: "a", caps }) },
      concurrencyGate: { acquire: async () => ({ ok: true, release }) },
      resolve: () => ({
        client: { transcribe },
        model: "gpt-transcribe",
        alias: "oa/asr",
        lane: "asr",
        customModel: false,
      }),
    });
    const form = new FormData();
    form.set("model", "asr");
    form.set("file", new File(["wave"], "a.wav", { type: "audio/wav" }));
    form.append("languages[]", "en");
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer key" },
      body: form,
    });
    expect(res.status).toBe(caps ? (caps.allowedLanes ? 403 : 422) : 200);
    expect(transcribe).toHaveBeenCalledTimes(caps ? 0 : 1);
    if (!caps) {
      expect(await res.json()).toEqual({ text: "Hello" });
      expect(release).toHaveBeenCalledTimes(1);
    }
  });
});
