import {
  AudioTranscriptionError,
  createSpeechAccounting,
  createSqliteDb,
  createTranscriptionAccounting,
  SqliteBudgetStore,
} from "@helm/core";
import type { MediaSpendRecord } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { registerAudioSpeechRoute } from "./audio-speech.js";
import { registerAudioTranscriptionsRoute } from "./audio-transcriptions.js";

describe("multipart transcription boundary", () => {
  it.each([
    [new Error("connection lost"), 502, "outcome_unknown", false],
    [new AudioTranscriptionError("provider_unavailable", 503), 503, "provider_unavailable", true],
  ] as const)("records operation state on transcription error %s", async (cause, status, code, notSent) => {
    const app = new Hono<AppEnv>();
    const transcribe = vi.fn().mockRejectedValue(cause);
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
      accounting: { get: async () => null, reserve: async () => record, settle },
    });
    const form = new FormData();
    form.set("model", "asr");
    form.set("file", new File(["wave"], "a.wav", { type: "audio/wav" }));
    const response = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer key" },
      body: form,
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      error: { code, operation_id: record.id },
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(record, undefined, undefined, notSent);
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

it("a caller operation survives racing submissions and stays private to the key", async () => {
  const db = createSqliteDb(":memory:");
  try {
    const store = new SqliteBudgetStore(db);
    const config = { defaultWindowSeconds: 86400, defaultDegradeLane: "economy" };
    const ledger = createTranscriptionAccounting(store, config);
    let readers = 0;
    let readsComplete: () => void;
    const bothRead = new Promise<void>((resolve) => {
      readsComplete = resolve;
    });
    const get = async (id: string, key: string) => {
      const record = await ledger.get(id, key);
      readers++;
      if (readers === 2) readsComplete();
      if (readers <= 2) await bothRead;
      return record;
    };
    const app = new Hono<AppEnv>();
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello" });
    const shared = {
      auth: {
        resolve: async (key: string | null) => (key ? { keyId: key, accountId: "same" } : null),
      },
      concurrencyGate: { acquire: async () => ({ ok: true as const, release: vi.fn() }) },
    };
    registerAudioSpeechRoute(app, {
      ...shared,
      accounting: createSpeechAccounting(store, config),
      resolve: () => null,
    });
    registerAudioTranscriptionsRoute(app, {
      ...shared,
      accounting: { ...ledger, get },
      resolve: () => ({
        client: { transcribe },
        alias: "gpu/whisperx",
        model: "whisperx",
        lane: "gpu",
        customModel: false,
      }),
    });
    const handle = "asr_0ad3295c-3f46-4a74-8e76-1f22b5d9795a";
    const headers = { Authorization: "Bearer first", "X-Helm-Transcription-Operation": handle };
    const submit = () => {
      const body = new FormData();
      body.set("model", "gpu");
      body.set("file", new File(["test"], "clip.wav", { type: "audio/wav" }));
      return app.request("/v1/audio/transcriptions", { method: "POST", body, headers });
    };
    const responses = await Promise.all([submit(), submit()]);
    const success = responses.find((r) => r.status === 200);
    const duplicate = responses.find((r) => r.status === 409);
    expect(await success?.json()).toMatchObject({ accounting: { operationId: handle } });
    expect(await duplicate?.json()).toMatchObject({
      error: { code: "operation_exists", operation_id: handle },
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const path = `/v1/audio/operations/${handle}`;
    const receipt = await app.request(path, { headers: { Authorization: "Bearer first" } });
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ operationId: handle, state: "outcome_unknown" });
    const foreign = await app.request(path, { headers: { Authorization: "Bearer second" } });
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("cache-control")).toBe("no-store");
  } finally {
    db.$sqlite.close();
  }
});
