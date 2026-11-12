import type { MediaSpendRecord } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { registerAudioTranscriptionsRoute } from "./audio-transcriptions.js";

describe("multipart transcription boundary", () => {
  it("reports an unknown dispatched outcome with its durable operation id", async () => {
    const app = new Hono<AppEnv>();
    const transcribe = vi.fn().mockRejectedValue(new Error("connection lost"));
    const record: MediaSpendRecord = {
      id: "operation-1",
      keyId: "k",
      alias: "asr/model",
      providerModel: "gpt-transcribe",
      state: "reserved",
      reservedUsd: 0.01,
      costUsd: null,
      capacity: 1,
      windowMs: 60000,
      admittedAtMs: 0,
      anchorMs: null,
      usage: null,
    };
    const settle = vi.fn().mockResolvedValue({ ...record, state: "outcome_unknown" });
    registerAudioTranscriptionsRoute(app, {
      auth: { resolve: async () => ({ keyId: "k", accountId: "a" }) },
      concurrencyGate: { acquire: async () => ({ ok: true, release: vi.fn() }) },
      resolve: () => ({
        client: { transcribe },
        model: "gpt-transcribe",
        alias: "asr/model",
        lane: "asr",
        customModel: false,
      }),
      accounting: { reserve: async () => record, settle },
    });
    const form = new FormData();
    form.set("model", "asr");
    form.set("file", new File(["wave"], "a.wav", { type: "audio/wav" }));
    const response = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer key" },
      body: form,
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "outcome_unknown", operation_id: record.id },
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(record, undefined, undefined, false);
  });
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
