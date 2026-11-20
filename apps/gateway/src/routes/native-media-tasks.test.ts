import {
  type BudgetCaps,
  createSqliteDb,
  createTranscriptionAccounting,
  normalizeBailianTranscription,
  type ResponsesRegistryRecord,
  SqliteBudgetStore,
} from "@helm/core";
import { BailianTranscriptionRequestSchema, MediaPricingSchema } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const Created = z.object({ request_id: z.string(), status: z.string() });
const Failed = z.object({ error: z.object({ code: z.string(), operation_id: z.string() }) });

import type { AppEnv } from "../app.js";
import type { NativeMediaTaskProfile } from "./native-media-tasks.js";
import type { RecordServedDeps } from "./payload-capture.js";
import { registerMediaTaskRoutes, type VideoCreateTarget, type VideosRouteDeps } from "./videos.js";

const fingerprint = "a".repeat(64);
function setup(kind: "video" | "transcription" = "video", record?: RecordServedDeps) {
  let now = 1000;
  let key = "key-a";
  let budget: BudgetCaps | undefined;
  let currentFingerprint = fingerprint;
  const records = new Map<string, ResponsesRegistryRecord>();
  const create = vi.fn(async () => ({ id: "upstream-1" }));
  const retrieve = vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      id: "upstream-1",
      status: "done",
    }),
  );
  const profile: NativeMediaTaskProfile = {
    profile: "bailian",
    endpointIdentity: fingerprint,
    queryTtlMs: 86400000,
    validate: (body) => {
      if (!body.prompt) throw new Error("prompt required");
      return body;
    },
    parseCreated: (body) => (typeof body.id === "string" ? body.id : null),
    normalize: (body, id) =>
      body.id === id
        ? {
            status: "done",
            ...(kind === "video"
              ? { video: { url: "https://cdn.example/video.mp4" } }
              : { transcription: { results: [{ text: "hello" }] } }),
          }
        : null,
  };
  const target: VideoCreateTarget = {
    nativeTask: profile,
    providerAlias: "bailian/video",
    providerName: "bailian",
    providerModel: "wan3.0-video",
    providerAccount: "account-a",
    laneName: "video-standard",
    client: { create },
  };
  const put = vi.fn(async (r: ResponsesRegistryRecord) => {
    records.set(r.responseId, r);
  });
  const deps: VideosRouteDeps = {
    record,
    auth: { resolve: async () => ({ accountId: "owner", keyId: key, caps: { budget } }) },
    resolver: {
      create: async () => target,
      poll: async () => ({
        nativeTask: { ...profile, endpointIdentity: currentFingerprint },
        retrieve,
      }),
    },
    registry: {
      get: async (id) => records.get(id) ?? null,
      put,
      putIfAbsent: async (r) => {
        if (records.has(r.responseId)) return false;
        await put(r);
        return true;
      },
    },
    now: () => now,
  };
  const app = new Hono<AppEnv>();
  registerMediaTaskRoutes(app, deps, kind);
  const root = kind === "video" ? "/v1/videos" : "/v1/audio/transcription-jobs";
  const post = (operation?: string) =>
    app.request(root + (kind === "video" ? "/generations" : ""), {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        ...(operation ? { "X-Helm-Transcription-Operation": operation } : {}),
      },
      body: JSON.stringify({ model: "video-standard", prompt: "hello" }),
    });
  return {
    app,
    deps,
    root,
    records,
    create,
    retrieve,
    profile,
    target,
    post,
    setKey: (v: string) => {
      key = v;
    },
    setBudget: (caps: BudgetCaps) => {
      budget = caps;
    },
    setTime: (v: number) => {
      now = v;
    },
    setFingerprint: (v: string) => {
      currentFingerprint = v;
    },
    put,
  };
}
describe("native media task route", () => {
  it.each([
    "fun-asr",
    "qwen3-asr-flash-filetrans",
  ])("enforces the priced channel limit for %s before dispatching", async (model) => {
    const db = createSqliteDb(":memory:");
    try {
      const t = setup("transcription");
      t.target.providerModel = model;
      t.profile.validate = (body, model) =>
        BailianTranscriptionRequestSchema.parse({ ...body, model });
      const accounting = createTranscriptionAccounting(new SqliteBudgetStore(db), {
        defaultWindowSeconds: 86400,
        defaultDegradeLane: "economy",
      });
      t.deps.transcriptionAccounting = accounting;
      t.setBudget({
        requests: null,
        tokens: null,
        spendUsd: 1,
        windowSeconds: 86400,
        behavior: "reject",
        degradeLane: null,
        admittedAtMs: Date.now(),
      });
      t.target.pricing = MediaPricingSchema.parse({
        currency: "USD",
        region: "fixture",
        providerModel: t.target.providerModel,
        basis: "official_list_price",
        source: "https://example.test/price",
        verifiedOn: "2026-11-20",
        rates: [{ direction: "input_audio", unit: "second", price: 0.001, conditions: {} }],
        notes: [],
        billing: { asyncJobCeiling: { accountId: "account-a", costUsd: 0.3, maxChannels: 1 } },
      });
      const post = (id: string, channels?: number[]) =>
        t.app.request(t.root, {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
            "X-Helm-Transcription-Operation": id,
          },
          body: JSON.stringify({
            model: "video-standard",
            input:
              model === "fun-asr"
                ? { file_urls: ["https://example.test/sample.wav"] }
                : { file_url: "https://example.test/sample.wav" },
            ...(channels ? { parameters: { channel_id: channels } } : {}),
          }),
        });
      const rejected = "asr_86fad6c3-43de-44c9-925d-ce79d88c6651";
      const response = await post(rejected, [0, 1]);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "media_pricing_unavailable" } });
      expect(t.create).not.toHaveBeenCalled();
      const lookup = await t.app.request(t.root + "/operations/" + rejected);
      expect(await lookup.json()).toMatchObject({ state: "not_sent" });
      const reserve = vi.spyOn(accounting, "reserveAsync");
      expect((await post("asr_86fad6c3-43de-44c9-925d-ce79d88c6652")).status).toBe(200);
      expect(reserve).toHaveBeenLastCalledWith(expect.objectContaining({ channelCount: 1 }));
      expect((await post("asr_86fad6c3-43de-44c9-925d-ce79d88c6653", [1])).status).toBe(200);
      expect(t.create).toHaveBeenCalledTimes(2);
      const originalProfile = t.profile.profile;
      t.profile.profile = "doubao";
      expect((await post("asr_86fad6c3-43de-44c9-925d-ce79d88c6654", [0])).status).toBe(422);
      expect(t.create).toHaveBeenCalledTimes(2);
      t.profile.profile = originalProfile;
    } finally {
      db.$sqlite.close();
    }
  });

  it("reserves a proven per-job ceiling before any paid POST and retains unknown cost", async () => {
    const db = createSqliteDb(":memory:");
    try {
      const t = setup("transcription");
      const store = new SqliteBudgetStore(db);
      t.deps.transcriptionAccounting = createTranscriptionAccounting(store, {
        defaultWindowSeconds: 86400,
        defaultDegradeLane: "economy",
      });
      t.setBudget({
        requests: null,
        tokens: null,
        spendUsd: 0.5,
        windowSeconds: 86400,
        behavior: "reject",
        degradeLane: null,
        admittedAtMs: 1000,
      });
      const first = "asr_86fad6c3-43de-44c9-925d-ce79d88c6628";
      const second = "asr_86fad6c3-43de-44c9-925d-ce79d88c6629";
      const third = "asr_86fad6c3-43de-44c9-925d-ce79d88c6630";
      expect((await t.post(first)).status).toBe(422);
      t.target.pricing = MediaPricingSchema.parse({
        currency: "USD",
        region: "fixture",
        providerModel: t.target.providerModel,
        basis: "official_list_price",
        source: "https://example.test/price",
        verifiedOn: "2026-11-19",
        rates: [{ direction: "input_audio", unit: "second", price: 0.001, conditions: {} }],
        notes: [],
        billing: { asyncJobCeiling: { accountId: "account-a", costUsd: 0.3 } },
      });
      expect((await t.post()).status).toBe(400);
      t.create.mockRejectedValueOnce({ outcome: "not_sent" });
      const refused = await t.post(first);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ error: { code: "upstream_not_sent" } });
      const read = async (id: string) => (await t.app.request(`${t.root}/operations/${id}`)).json();
      expect(await read(first)).toMatchObject({
        state: "not_sent",
        accounting: { state: "settled", costUsd: 0 },
      });

      let remainingAtDispatch: number | undefined;
      t.create.mockImplementationOnce(async () => {
        remainingAtDispatch = (await store.peek("key-a", "usd", 0.5, 86400000, 1000)).remaining;
        throw new Error("reply lost");
      });
      expect((await t.post(second)).status).toBe(503);
      expect(remainingAtDispatch).toBeCloseTo(0.2);
      expect(await read(second)).toMatchObject({
        state: "outcome_unknown",
        accounting: { state: "outcome_unknown", reservedUsd: 0.3, costUsd: null },
      });
      const exhausted = await t.post(third);
      expect(exhausted.status).toBe(429);
      expect(await exhausted.json()).toMatchObject({
        error: { code: "budget_exceeded", message: "usage budget exceeded" },
      });
      expect(t.create).toHaveBeenCalledTimes(2);

      t.setKey("key-b");
      const accepted = await t.post(third);
      expect(accepted.status).toBe(200);
      const task = Created.parse(await accepted.json());
      expect(await read(third)).toMatchObject({
        state: "accepted",
        accounting: { state: "reserved" },
      });
      const poll = () => t.app.request(`${t.root}/${task.request_id}`);
      expect((await poll()).status).toBe(200);
      expect(await read(third)).toMatchObject({
        state: "accepted",
        accounting: { state: "outcome_unknown", reservedUsd: 0.3, costUsd: null },
      });
      const usage = { type: "duration", seconds: 3.56 };
      const normalize = t.profile.normalize;
      t.profile.normalize = (body, id, model) => ({
        ...normalize(body, id, model),
        usage: { ...usage, privateField: "must not be retained" },
      });
      expect((await poll()).status).toBe(200);
      expect(await read(third)).toMatchObject({
        state: "accepted",
        accounting: { state: "outcome_unknown", reservedUsd: 0.3, costUsd: null, usage },
      });
      expect(await read(third)).toMatchObject({ accounting: { usage } });
      t.profile.normalize = normalize;
      expect((await poll()).status).toBe(200);
      expect(await read(third)).toMatchObject({ accounting: { usage } });
      expect(JSON.stringify(await read(third))).not.toContain("privateField");
      expect(t.create).toHaveBeenCalledTimes(3);
    } finally {
      db.$sqlite.close();
    }
  });

  it.each([
    false,
    true,
  ])("omits signed ASR content from capture on success and error (error: %s)", async (failed) => {
    const enqueueTelemetry = vi.fn();
    const enqueuePayload = vi.fn();
    const enqueueSession = vi.fn();
    const t = setup("transcription", {
      now: () => 1000,
      redact: (value: unknown) => value,
      capturePayloads: () => true,
      captureSessions: () => true,
      telemetry: { insert: vi.fn() },
      writes: { enqueueTelemetry, enqueuePayload, enqueueSession },
    } as unknown as RecordServedDeps);
    const fileUrl = "https://files.example.test/sound.wav?signature=private-capability";
    if (failed) t.create.mockRejectedValueOnce(new Error("connection lost"));
    else t.create.mockImplementationOnce(async () => ({ id: "upstream-1", echoedUrl: fileUrl }));
    const body = JSON.stringify({
      model: "video-standard",
      prompt: "fixture",
      input: { file_url: fileUrl },
    });
    const res = await t.app.request(t.root, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(failed ? 503 : 200);
    expect(t.create).toHaveBeenCalledWith(
      expect.objectContaining({ input: { file_url: fileUrl } }),
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
    expect(enqueueTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          request_content_mode: "none",
          request_body_bytes: Buffer.byteLength(body),
        }),
      }),
    );
    expect(enqueuePayload).not.toHaveBeenCalled();
    expect(enqueueSession).not.toHaveBeenCalled();
    expect(JSON.stringify([...t.records.values(), ...enqueueTelemetry.mock.calls])).not.toContain(
      "private-capability",
    );
  });

  it("recovers a caller-known operation after the entire create response is lost", async () => {
    const t = setup("transcription");
    const operation = "asr_86fad6c3-43de-44c9-925d-ce79d88c6628";
    const path = `${t.root}/operations/${operation}`;
    await t.post(operation); // The caller discards the entire response.
    const lookup = await t.app.request(path);
    expect(lookup.status).toBe(200);
    expect(lookup.headers.get("cache-control")).toBe("no-store");
    expect(await lookup.json()).toMatchObject({
      operation_id: operation,
      state: "accepted",
      request_id: expect.any(String),
    });
    const replay = await t.post(operation);
    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({
      error: { code: "outcome_unknown", operation_id: operation },
    });
    expect(t.create).toHaveBeenCalledTimes(1);
    t.setKey("other");
    expect((await t.app.request(path)).status).toBe(404);
    expect((await t.post(operation)).status).toBe(200);
    expect(t.create).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed operation headers before calling the transcription provider", async () => {
    const t = setup("transcription");
    expect((await t.post("wrong")).status).toBe(400);
    expect(t.create).not.toHaveBeenCalled();
  });

  it("does not mistake a reserved provider ID for a submitted request after a definite refusal", async () => {
    const t = setup("transcription");
    t.profile.clientAssignedRequestId = true;
    t.create.mockRejectedValueOnce({ outcome: "not_sent" });
    const operation = "asr_86fad6c3-43de-44c9-925d-ce79d88c6628";
    expect((await t.post(operation)).status).toBe(503);
    const lookup = await t.app.request(`${t.root}/operations/${operation}`);
    expect(await lookup.json()).toEqual({
      operation_id: operation,
      state: "not_sent",
      upstream_task_known: false,
    });
    expect(t.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    [false, true],
    [true, true],
    [true, false],
  ])("omits signed ASR content (error: %s, capture enabled: %s)", async (failed, capture) => {
    const enqueueTelemetry = vi.fn();
    const enqueuePayload = vi.fn();
    const enqueueSession = vi.fn();
    const t = setup("transcription", {
      now: () => 1000,
      redact: (value: unknown) => value,
      capturePayloads: () => capture,
      captureSessions: () => capture,
      telemetry: { insert: vi.fn() },
      writes: { enqueueTelemetry, enqueuePayload, enqueueSession },
    } as unknown as RecordServedDeps);
    const fileUrl = "https://files.example.test/sound.wav?signature=private-capability";
    if (failed) t.create.mockRejectedValueOnce(new Error("connection lost"));
    else t.create.mockImplementationOnce(async () => ({ id: "upstream-1", echoedUrl: fileUrl }));
    const body = JSON.stringify({
      model: "video-standard",
      prompt: "fixture",
      input: { file_url: fileUrl },
    });
    const res = await t.app.request(t.root, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(failed ? 503 : 200);
    expect(t.create).toHaveBeenCalledWith(
      expect.objectContaining({ input: { file_url: fileUrl } }),
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
    expect(enqueueTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          request_content_mode: "none",
          request_body_bytes: Buffer.byteLength(body),
        }),
      }),
    );
    expect(enqueuePayload).not.toHaveBeenCalled();
    expect(enqueueSession).not.toHaveBeenCalled();
    expect(JSON.stringify([...t.records.values(), ...enqueueTelemetry.mock.calls])).not.toContain(
      "private-capability",
    );
  });

  it.each([
    "video",
    "transcription",
  ] as const)("creates and retrieves %s with a private upstream ID", async (kind) => {
    const t = setup(kind);
    const response = await t.post();
    expect(response.status).toBe(200);
    const result = Created.parse(await response.json());
    expect(result.request_id).not.toBe("upstream-1");
    expect(result.status).toBe("queued");
    const poll = await t.app.request(`${t.root}/${result.request_id}`);
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ request_id: result.request_id, status: "done" });
    expect(t.retrieve).toHaveBeenCalledWith("upstream-1", expect.any(AbortSignal));
    expect(t.create).toHaveBeenCalledTimes(1);
  });
  it("settles Fun-ASR by supplier duration even if the transcript download fails", async () => {
    const t = setup("transcription");
    const applyAsyncMediaCost = vi.fn().mockResolvedValue(true);
    const insert = vi.fn();
    t.deps.record = {
      telemetry: { insert, applyAsyncMediaCost },
      capturePayloads: () => false,
      redact: (decision: unknown) => decision,
      now: () => 1000,
    } as unknown as RecordServedDeps;
    t.deps.mediaPricing = () => ({
      currency: "CNY",
      region: "cn-beijing",
      providerModel: "fun-asr",
      basis: "official_list_price",
      verifiedOn: "2026-11-20",
      source: "https://example.test/pricing",
      rates: [{ direction: "input_audio", unit: "second", price: 0.00022, conditions: {} }],
      notes: [],
    });
    t.target.providerModel = "fun-asr";
    t.profile.normalize = normalizeBailianTranscription;
    t.profile.materialize = vi.fn().mockRejectedValue(new Error("signed link expired"));
    t.retrieve.mockResolvedValue({
      output: {
        task_id: "upstream-1",
        task_status: "SUCCEEDED",
        results: [
          {
            subtask_status: "SUCCEEDED",
            transcription_url: "https://example.test/transcript?signature=private",
          },
        ],
      },
      usage: { duration: 15 },
    });
    const created = Created.parse(await (await t.post()).json());
    const poll = await t.app.request(`${t.root}/${created.request_id}`);
    expect(poll.status).toBe(502);
    expect(applyAsyncMediaCost).toHaveBeenCalledOnce();
    const settlement = applyAsyncMediaCost.mock.calls[0]?.[0];
    expect(settlement).toMatchObject({
      kind: "transcription",
      keyId: "key-a",
      requestId: insert.mock.calls[0]?.[0]?.decision.request_id,
      providerModel: "fun-asr",
      cost: { currency: "CNY", cost_usd: null },
    });
    expect(settlement.cost.amount).toBeCloseTo(0.0033);
    expect(JSON.stringify(settlement)).not.toContain("signature");
  });

  it("denies other keys without querying the provider", async () => {
    const t = setup();
    const r = Created.parse(await (await t.post()).json());
    t.setKey("other");
    expect((await t.app.request(`${t.root}/${r.request_id}`)).status).toBe(404);
    expect(t.retrieve).not.toHaveBeenCalled();
  });
  it("denies changed endpoint or credential generation without querying", async () => {
    const t = setup();
    const r = Created.parse(await (await t.post()).json());
    t.setFingerprint("b".repeat(64));
    expect((await t.app.request(`${t.root}/${r.request_id}`)).status).toBe(409);
    expect(t.retrieve).not.toHaveBeenCalled();
  });
  it("expires querying separately from the durable record", async () => {
    const t = setup();
    const r = Created.parse(await (await t.post()).json());
    t.setTime(86401000);
    expect((await t.app.request(`${t.root}/${r.request_id}`)).status).toBe(410);
    expect(t.records.has(`video:${r.request_id}`)).toBe(true);
    expect(t.retrieve).not.toHaveBeenCalled();
  });
  it("returns a durable operation ID and never retries an unknown create", async () => {
    const t = setup();
    t.create.mockRejectedValueOnce(new Error("response lost"));
    const response = await t.post();
    expect(response.status).toBe(503);
    const r = Failed.parse(await response.json());
    expect(r.error.code).toBe("outcome_unknown");
    expect(r.error.operation_id).toBeTruthy();
    expect(t.records.has(`video-create:${r.error.operation_id}`)).toBe(true);
    expect(t.create).toHaveBeenCalledTimes(1);
    const operation = await t.app.request(`${t.root}/operations/${r.error.operation_id}`);
    expect(operation.status).toBe(200);
    expect(await operation.json()).toMatchObject({
      operation_id: r.error.operation_id,
      state: "outcome_unknown",
    });
    t.setKey("other");
    expect((await t.app.request(`${t.root}/operations/${r.error.operation_id}`)).status).toBe(404);
  });
  it("does not send on failed durable reservation", async () => {
    const t = setup();
    t.put.mockRejectedValueOnce(new Error("store down"));
    expect((await t.post()).status).toBe(503);
    expect(t.create).not.toHaveBeenCalled();
  });
  it("never retries after upstream accepted but task binding failed", async () => {
    const t = setup();
    let writes = 0;
    t.put.mockImplementation(async (r) => {
      writes++;
      if (r.responseId.startsWith("video:")) throw new Error("disk");
      t.records.set(r.responseId, r);
    });
    const response = await t.post();
    expect(response.status).toBe(503);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(writes).toBeGreaterThan(1);
    expect(JSON.stringify([...t.records.values()])).toContain("upstream-1");
  });
  it("retains a task ID from a malformed upstream acceptance without replay", async () => {
    const t = setup();
    t.create.mockRejectedValueOnce({
      outcome: "unknown",
      providerRaw: { response: { output: { task_id: "recovery-id" } } },
    });
    const response = await t.post();
    expect(response.status).toBe(503);
    expect(JSON.stringify([...t.records.values()])).toContain("recovery-id");
    expect(t.create).toHaveBeenCalledTimes(1);
  });
  it("releases operation-query concurrency even for missing operations", async () => {
    const t = setup();
    const release = vi.fn(async () => {});
    t.deps.concurrencyGate = { acquire: async () => ({ ok: true, release }) };
    expect((await t.app.request(`${t.root}/operations/missing`)).status).toBe(404);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("recovers a known paid task after public mapping persistence fails", async () => {
    const t = setup();
    const original = t.deps.registry.putIfAbsent;
    let fail = true;
    t.deps.registry.putIfAbsent = async (record) => {
      if (record.responseId.startsWith("video:") && fail) throw new Error("disk");
      return original(record);
    };
    const response = await t.post();
    const failed = Failed.parse(await response.json());
    fail = false;
    const recovered = await t.app.request(`${t.root}/operations/${failed.error.operation_id}`);
    const result = z.object({ request_id: z.string() }).parse(await recovered.json());
    expect((await t.app.request(`${t.root}/${result.request_id}`)).status).toBe(200);
    expect(t.create).toHaveBeenCalledTimes(1);
  });
});

it("persists a client-assigned ASR id before submit and recovers unknown submissions by query", async () => {
  const t = setup("transcription");
  t.profile.clientAssignedRequestId = true;
  let submittedId: string | undefined;
  t.target.client.create = async (_body, _signal, _account, id) => {
    submittedId = id;
    const stored = [...t.records.values()][0];
    expect(stored?.status).toContain(id);
    throw new Error("response connection lost");
  };
  const failed = Failed.parse(await (await t.post()).json());
  expect(submittedId).toBeTruthy();
  const recovered = await t.app.request(`${t.root}/operations/${failed.error.operation_id}`);
  const result = z.object({ request_id: z.string() }).parse(await recovered.json());
  t.retrieve.mockResolvedValue({ id: submittedId ?? "", status: "done" });
  expect((await t.app.request(`${t.root}/${result.request_id}`)).status).toBe(200);
  expect(t.retrieve).toHaveBeenCalledWith(submittedId, expect.any(AbortSignal));
});
