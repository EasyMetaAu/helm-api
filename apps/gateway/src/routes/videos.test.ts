import type { ResponsesRegistryRecord } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import type { MessagesIdentity } from "./messages.js";
import type { RecordServedDeps } from "./payload-capture.js";
import { registerVideosRoute, type VideosRouteDeps } from "./videos.js";

const identity: MessagesIdentity = { keyId: "key_1", accountId: "acct_1" };

function record(responseId: string, status = "in_progress"): ResponsesRegistryRecord {
  return {
    responseId,
    accountId: identity.accountId,
    keyId: identity.keyId,
    providerAlias: "xai/grok-imagine-video",
    providerName: "xai",
    providerModel: "grok-imagine-video",
    providerProtocol: null,
    providerAccount: "oauth-a",
    selectedLane: "video",
    createdAt: 1000,
    expiresAt: 2000,
    status,
  };
}

function setup(over: Partial<VideosRouteDeps> = {}) {
  const records = new Map<string, ResponsesRegistryRecord>();
  const create = vi.fn().mockResolvedValue({ request_id: "vid_1", status: "queued" });
  const retrieve = vi.fn().mockResolvedValue({
    request_id: "vid_1",
    status: "done",
    video: { url: "https://cdn.example.test/video.mp4" },
  });
  const enqueuePayload = vi.fn();
  const enqueueTelemetry = vi.fn();
  const record = {
    telemetry: { insert: vi.fn() },
    redact: (decision: unknown) => decision,
    now: () => 0,
    capturePayloads: () => true,
    writes: { enqueuePayload, enqueueTelemetry },
  } as unknown as RecordServedDeps;
  const put = vi.fn(async (value: ResponsesRegistryRecord) => {
    records.set(value.responseId, value);
  });
  const putIfAbsent = vi.fn(async (value: ResponsesRegistryRecord) => {
    if (records.has(value.responseId)) return false;
    records.set(value.responseId, value);
    return true;
  });
  const registry: VideosRouteDeps["registry"] = {
    put,
    putIfAbsent,
    get: vi.fn(async (id: string) => records.get(id) ?? null),
  };
  const deps: VideosRouteDeps = {
    auth: { resolve: async (credential) => (credential === "k" ? identity : null) },
    registry,
    resolver: {
      create: async (body) => ({
        providerAlias: `xai/${String(body.model).replace(/^xai\//, "")}`,
        providerName: "xai",
        providerModel: String(body.model).replace(/^xai\//, ""),
        providerAccount: "oauth-a",
        client: { create },
      }),
      poll: async () => ({ retrieve }),
    },
    record,
    ...over,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("request_id", "req_1");
    await next();
  });
  registerVideosRoute(app, deps);
  return {
    app,
    create,
    retrieve,
    registry,
    records,
    put,
    putIfAbsent,
    enqueuePayload,
    enqueueTelemetry,
  };
}

function post(app: Hono<AppEnv>, body?: Record<string, unknown>) {
  return app.request("/v1/videos/generations", {
    method: "POST",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: JSON.stringify(
      body ?? {
        model: "grok-imagine-video-1.5-preview",
        prompt: "a red kite",
        image: { url: "https://example.test/kite.png" },
        duration: 6,
        resolution: "480p",
      },
    ),
  });
}

function extend(app: Hono<AppEnv>, body?: Record<string, unknown>) {
  return app.request("/v1/videos/extensions", {
    method: "POST",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: JSON.stringify(
      body ?? {
        model: "grok-imagine-video",
        prompt: "continue the camera movement",
        video: { url: "https://example.test/source.mp4" },
        duration: 30,
      },
    ),
  });
}

describe("registerVideosRoute", () => {
  it("forwards first/last frames and preset voice together exactly once", async () => {
    const { app, create, putIfAbsent } = setup();
    const body = {
      model: "grok-imagine-video-1.5",
      image: { url: "data:image/png;base64,AAA=" },
      last_frame: { url: "https://example.test/end.png" },
      reference_audios: [{ voice_id: "eve" }],
      duration: 12,
      resolution: "720p",
    };
    expect((await post(app, body)).status).toBe(200);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      body,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(putIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: "video-create:req_1", keyId: identity.keyId }),
    );
    expect(putIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: "video:vid_1", keyId: identity.keyId }),
    );
  });

  it("normalizes images without dropping frame pins or preset voice", async () => {
    const { app, create } = setup();
    const body = {
      model: "grok-imagine-video-1.5",
      image: { url: "https://example.test/start.png" },
      last_frame: { url: "https://example.test/end.png" },
      reference_audios: [{ voice_id: "eve" }],
      images: [{ url: "https://example.test/person.png" }],
      duration: 12,
      resolution: "720p",
    };
    expect((await post(app, body)).status).toBe(200);
    const { images, ...rest } = body;
    expect(create).toHaveBeenCalledExactlyOnceWith(
      { ...rest, reference_images: images },
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("rejects unsupported frame options before the provider is called", async () => {
    const { app, create } = setup();
    expect(
      (
        await post(app, {
          model: "grok-imagine-video-1.5",
          image: { url: "x" },
          last_frame: { url: "y" },
          reference_audios: [{ url: "https://example.test/voice.wav" }],
          duration: 12,
          resolution: "720p",
        })
      ).status,
    ).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["prompt-only", { model: "grok-imagine-video", prompt: "waves", duration: 30 }],
    [
      "single-image",
      {
        model: "grok-imagine-video-1.5",
        prompt: "move",
        image: { url: "https://example.test/source.png" },
        aspect_ratio: "4:3",
        duration: 12,
        resolution: "1080p",
      },
    ],
    [
      "reference_images",
      {
        model: "grok-imagine-video-1.5",
        prompt: "have <IMAGE_0> speak with <AUDIO_0>",
        reference_images: [{ url: "https://example.test/one.png" }],
        reference_audios: [{ voice_id: "eve" }],
        aspect_ratio: "3:4",
        duration: 8,
        resolution: "720p",
      },
    ],
  ])("forwards one supported %s generation with the resolved wire model", async (_name, body) => {
    const { app, create } = setup();

    expect((await post(app, body)).status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(body, expect.any(AbortSignal), expect.any(Function));
  });

  it("normalizes the compatible images field to reference_images before the paid POST", async () => {
    const { app, create } = setup();
    const references = [{ url: "https://example.test/one.png" }];
    const referenceAudios = [{ voice_id: "eve" }];

    expect(
      (
        await post(app, {
          model: "grok-imagine-video-1.5",
          prompt: "have <IMAGE_0> speak with <AUDIO_0>",
          images: references,
          reference_audios: referenceAudios,
          aspect_ratio: "3:4",
          duration: 8,
          resolution: "720p",
        })
      ).status,
    ).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      {
        model: "grok-imagine-video-1.5",
        prompt: "have <IMAGE_0> speak with <AUDIO_0>",
        reference_images: references,
        reference_audios: referenceAudios,
        aspect_ratio: "3:4",
        duration: 8,
        resolution: "720p",
      },
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("runs a valid extension through the same single-write registry contract", async () => {
    const { app, create, putIfAbsent } = setup();
    const body = {
      model: "grok-imagine-video",
      prompt: "continue the camera movement",
      video: { url: "https://example.test/source.mp4" },
      duration: 30,
    };

    expect((await extend(app, body)).status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(body, expect.any(AbortSignal), expect.any(Function));
    expect(putIfAbsent).toHaveBeenCalledTimes(2);
  });

  it("returns outcome_unknown without retrying an ambiguous extension", async () => {
    const { app, create } = setup();
    create.mockRejectedValueOnce(new Error("socket closed after extension POST"));

    const response = await extend(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects an invalid extension before reservation or create", async () => {
    const { app, create, putIfAbsent } = setup();

    expect(
      (
        await extend(app, {
          model: "grok-imagine-video",
          prompt: "",
          video: { url: "" },
          duration: 30,
        })
      ).status,
    ).toBe(400);
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    "generations",
    "extensions",
  ])("rejects missing auth on %s before reservation or create", async (operation) => {
    const { app, create, putIfAbsent } = setup();

    const response = await app.request(`/v1/videos/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    {
      model: "grok-imagine-video",
      prompt: "wrong single-image model",
      image: { url: "https://example.test/kite.png" },
      duration: 6,
      resolution: "480p",
    },
    {
      model: "grok-imagine-video-1.5-preview",
      prompt: "wrong reference-image model",
      reference_images: [
        { url: "https://example.test/one.png" },
        { url: "https://example.test/two.png" },
      ],
      aspect_ratio: "16:9",
      duration: 6,
      resolution: "480p",
    },
  ])("rejects a model/request-shape mismatch before reservation or create", async (body) => {
    const { app, create, putIfAbsent } = setup();

    const response = await post(app, body);

    expect(response.status).toBe(400);
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects concurrency overflow before reservation or create", async () => {
    const { app, create, putIfAbsent } = setup({
      concurrencyGate: {
        acquire: async () => ({ ok: false, reason: "queue_full", retryAfterSeconds: 1 }),
      },
    });

    const response = await post(app);

    expect(response.status).toBe(429);
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("records a successful video start under the Helm request id with provider/account provenance", async () => {
    const { app, enqueuePayload, enqueueTelemetry } = setup({ now: () => 1000 });

    expect((await post(app)).status).toBe(200);

    const decision = enqueueTelemetry.mock.calls[0]?.[0]?.decision;
    expect(decision).toMatchObject({
      request_id: "req_1",
      requested_model: "grok-imagine-video-1.5-preview",
      final: {
        model_alias: "xai/grok-imagine-video-1.5-preview",
        provider_model: "grok-imagine-video-1.5-preview",
        status: "ok",
      },
      serving_account: { provider_id: "xai", account: "oauth-a" },
      cost_breakdown: { total_usd: null },
      provider_attempts: [
        expect.objectContaining({
          alias: "xai/grok-imagine-video-1.5-preview",
          provider_name: "xai",
          provider_model: "grok-imagine-video-1.5-preview",
          upstream_request_ref: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          status: "ok",
          cost_usd: null,
          latency_ms: expect.any(Number),
        }),
      ],
    });
    expect(enqueuePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req_1",
        requestJson: expect.stringContaining('"grok-imagine-video-1.5-preview"'),
        responseJson: JSON.stringify({ request_id: "vid_1", status: "queued" }),
      }),
      undefined,
    );
  });

  it("records an outcome_unknown video create under the Helm request id without a retry", async () => {
    const { app, create, enqueueTelemetry, enqueuePayload } = setup();
    create.mockRejectedValueOnce(new Error("socket closed after POST"));

    const response = await post(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(create).toHaveBeenCalledOnce();
    const decision = enqueueTelemetry.mock.calls[0]?.[0]?.decision;
    expect(decision).toMatchObject({
      request_id: "req_1",
      final: { status: "error", error_reason: "outcome_unknown" },
      serving_account: { provider_id: "xai", account: "oauth-a" },
      provider_attempts: [
        expect.objectContaining({
          status: "error",
          error_class: "outcome_unknown",
          cost_usd: null,
        }),
      ],
    });
    expect(enqueuePayload).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req_1", responseJson: null }),
      undefined,
    );
  });

  it("persists the selected OAuth account before an ambiguous video POST fails", async () => {
    const create = vi.fn(
      async (
        _body: Record<string, unknown>,
        _signal: AbortSignal,
        onAccountSelected?: (account: string) => void | Promise<void>,
      ) => {
        await onAccountSelected?.("oauth-selected");
        throw new Error("socket closed after POST");
      },
    );
    const { app, records, enqueueTelemetry } = setup({
      resolver: {
        create: async () => ({
          providerAlias: "xai/grok-imagine-video-1.5-preview",
          providerName: "xai",
          providerModel: "grok-imagine-video-1.5-preview",
          providerAccount: null,
          client: { create },
        }),
        poll: async () => null,
      },
    });

    const response = await post(app);

    expect(response.status).toBe(503);
    expect(create).toHaveBeenCalledOnce();
    expect(records.get("video-create:req_1")?.providerAccount).toBe("oauth-selected");
    expect(enqueueTelemetry.mock.calls[0]?.[0]?.decision.serving_account).toEqual({
      provider_id: "xai",
      account: "oauth-selected",
    });
  });

  it("only logs video poll lifecycle and terminal state; it does not settle a second spend", async () => {
    const settleBudget = vi.fn();
    const log = vi.fn();
    const { app, enqueueTelemetry, enqueuePayload } = setup({ settleBudget, log });
    await post(app);

    const poll = await app.request("/v1/videos/vid_1", { headers: { Authorization: "Bearer k" } });

    expect(poll.status).toBe(200);
    expect(settleBudget).not.toHaveBeenCalled();
    expect(enqueueTelemetry).toHaveBeenCalledOnce();
    expect(enqueuePayload).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "video.poll.lifecycle",
      expect.objectContaining({ request_id: "req_1", video_request_id: "vid_1", status: "done" }),
    );
  });

  it("logs a failed poll lifecycle without recording a second media decision", async () => {
    const log = vi.fn();
    const { app, retrieve, enqueueTelemetry } = setup({ log });
    await post(app);
    retrieve.mockRejectedValueOnce(new Error("temporary upstream failure"));

    const poll = await app.request("/v1/videos/vid_1", { headers: { Authorization: "Bearer k" } });

    expect(poll.status).toBe(502);
    expect(enqueueTelemetry).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "video.poll.lifecycle",
      expect.objectContaining({
        request_id: "req_1",
        video_request_id: "vid_1",
        status: "upstream_error",
      }),
    );
  });

  it("reserves before one create, maps the trusted request id, and polls through its fixed owner", async () => {
    const { app, create, retrieve, records, put, putIfAbsent } = setup();

    expect((await post(app)).status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(putIfAbsent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        responseId: "video-create:req_1",
        providerAccount: "oauth-a",
        expiresAt: expect.any(Number),
      }),
    );
    const reservation = putIfAbsent.mock.calls[0]?.[0];
    if (reservation === undefined) throw new Error("missing reservation");
    expect(reservation.expiresAt - reservation.createdAt).toBe(24 * 60 * 60 * 1000);
    expect(putIfAbsent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ responseId: "video:vid_1", providerAccount: "oauth-a" }),
    );

    const polled = await app.request("/v1/videos/vid_1", {
      headers: { Authorization: "Bearer k" },
    });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toEqual({
      request_id: "vid_1",
      status: "done",
      video: { url: "https://cdn.example.test/video.mp4" },
    });
    expect(retrieve).toHaveBeenCalledWith("vid_1", expect.any(AbortSignal));
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: "video:vid_1", status: "done" }),
    );
    expect(records.get("video:vid_1")?.providerAccount).toBe("oauth-a");
  });

  it("returns outcome_unknown without a second create when reservation already exists", async () => {
    const { app, create, records } = setup();
    records.set("video-create:req_1", record("video-create:req_1"));

    const response = await post(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns outcome_unknown with zero creates when reservation storage throws", async () => {
    const { app, create, putIfAbsent } = setup();
    putIfAbsent.mockRejectedValueOnce(new Error("reservation store unavailable"));

    const response = await post(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns outcome_unknown after a create when durable id mapping collides", async () => {
    const { app, create, putIfAbsent } = setup();
    putIfAbsent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const response = await post(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(create).toHaveBeenCalledOnce();
  });

  it("returns outcome_unknown after one create when durable id mapping storage throws", async () => {
    const { app, create, putIfAbsent } = setup();
    putIfAbsent.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("mapping failed"));

    const response = await post(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(create).toHaveBeenCalledOnce();
  });

  it("forwards supported prompt-only Grok video options in one paid create", async () => {
    const { app, create, putIfAbsent } = setup();
    const response = await app.request("/v1/videos/generations", {
      method: "POST",
      headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-imagine-video",
        prompt: "waves rolling across a neon ocean",
        aspect_ratio: "16:9",
        duration: 15,
        resolution: "1080p",
        audio: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      {
        model: "grok-imagine-video",
        prompt: "waves rolling across a neon ocean",
        aspect_ratio: "16:9",
        duration: 15,
        resolution: "1080p",
        audio: true,
      },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(putIfAbsent).toHaveBeenCalledTimes(2);
  });

  it("accepts a concrete xAI video alias for a custom-model key with one paid create", async () => {
    const customIdentity: MessagesIdentity = {
      ...identity,
      caps: { allowCustomModel: true },
    };
    const { app, create, putIfAbsent } = setup({
      auth: { resolve: async () => customIdentity },
    });

    const response = await post(app, {
      model: "xai/grok-imagine-video",
      prompt: "waves rolling across a neon ocean",
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(putIfAbsent).toHaveBeenCalledTimes(2);
  });

  it("rejects a concrete xAI video alias for a normal key before reservation", async () => {
    const { app, create, putIfAbsent } = setup();

    const response = await post(app, {
      model: "xai/grok-imagine-video",
      prompt: "waves rolling across a neon ocean",
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(putIfAbsent).not.toHaveBeenCalled();
  });

  it("keeps bearer and prompt out of regular logs and DecisionRecord", async () => {
    const bearer = "super-secret-client-bearer";
    const prompt = "private prompt marker 7f59f2";
    const log = vi.fn();
    const { app, enqueueTelemetry, enqueuePayload } = setup({
      auth: { resolve: async (credential) => (credential === bearer ? identity : null) },
      log,
    });

    const response = await app.request("/v1/videos/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt }),
    });

    expect(response.status).toBe(200);
    const regularEvidence = JSON.stringify({
      decision: enqueueTelemetry.mock.calls[0]?.[0]?.decision,
      logs: log.mock.calls,
    });
    expect(regularEvidence).not.toContain(bearer);
    expect(regularEvidence).not.toContain(prompt);
    // Full prompt capture remains confined to the explicitly enabled payload store.
    expect(enqueuePayload.mock.calls[0]?.[0]?.requestJson).toContain(prompt);
  });

  it("keeps a non-terminal poll status out of the durable terminal state", async () => {
    const { app, retrieve, put } = setup();
    retrieve.mockResolvedValueOnce({ request_id: "vid_1", status: "processing" });
    await post(app);

    const response = await app.request("/v1/videos/vid_1", {
      headers: { Authorization: "Bearer k" },
    });

    expect(response.status).toBe(200);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects malformed done without persisting a terminal state", async () => {
    const { app, retrieve, put } = setup();
    retrieve.mockResolvedValueOnce({ request_id: "vid_1", status: "done" });
    await post(app);

    const response = await app.request("/v1/videos/vid_1", {
      headers: { Authorization: "Bearer k" },
    });

    expect(response.status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a blocked resolved video alias before reservation or create", async () => {
    const blockedIdentity: MessagesIdentity = {
      ...identity,
      caps: { blockedModels: ["xai/grok-imagine-video-1.5-preview"] },
    };
    const { app, create, putIfAbsent } = setup({
      auth: { resolve: async () => blockedIdentity },
    });

    const response = await post(app);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "model_blocked" } });
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed before reservation when a spend-capped key uses unpriced media", async () => {
    const spendCappedIdentity: MessagesIdentity = {
      ...identity,
      caps: {
        budget: {
          requests: null,
          tokens: null,
          spendUsd: 5,
          windowSeconds: null,
          behavior: "reject",
          degradeLane: null,
        },
      },
    };
    const { app, create, putIfAbsent } = setup({
      auth: { resolve: async () => spendCappedIdentity },
    });

    const response = await post(app);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "media_pricing_unavailable" },
    });
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

type ArkPublicTestBody = {
  request_id: string;
  status: string;
  video?: unknown;
  file?: unknown;
  error: { code: string };
};
const arkModel = "doubao-seedance-2-5-260628";
function setupArk(
  options: { identity?: MessagesIdentity; providerName?: string; now?: () => number } = {},
) {
  const who = options.identity ?? { ...identity, caps: { allowCustomModel: true } };
  const records = new Map<string, ResponsesRegistryRecord>();
  const now = options.now ?? (() => 1_000_000);
  const create = vi.fn().mockResolvedValue({ id: "shared-upstream-id" });
  const retrieve = vi.fn().mockResolvedValue({
    id: "shared-upstream-id",
    model: arkModel,
    status: "succeeded",
    updated_at: now() / 1000,
    content: { video_url: "https://cdn.example.test/movie.mp4" },
    error: null,
    usage: null,
  });
  const registry: VideosRouteDeps["registry"] = {
    put: async (row) => {
      records.set(row.responseId, structuredClone(row));
    },
    putIfAbsent: async (row) => {
      if (records.has(row.responseId)) return false;
      records.set(row.responseId, structuredClone(row));
      return true;
    },
    get: async (id, owner) => {
      const row = records.get(id);
      return row &&
        row.accountId === owner.accountId &&
        row.keyId === owner.keyId &&
        row.expiresAt > now()
        ? structuredClone(row)
        : null;
    },
  };
  const resolver: VideosRouteDeps["resolver"] = {
    create: vi.fn(async (body) => ({
      providerType: "ark" as const,
      laneName: body.model === "seedance-video" ? "seedance-video" : undefined,
      providerAlias: "ark/seedance-2.5",
      providerName: options.providerName ?? "ark-main",
      providerModel: arkModel,
      providerAccount: "account-a",
      client: { create },
    })),
    poll: vi.fn(async () => ({ providerType: "ark" as const, providerModel: arkModel, retrieve })),
  };
  const deps: VideosRouteDeps = {
    auth: { resolve: async (key) => (key === "k" ? who : null) },
    registry,
    resolver,
    now,
  };
  const restart = (over: Partial<VideosRouteDeps> = {}) => {
    const app = new Hono<AppEnv>();
    registerVideosRoute(app, { ...deps, ...over });
    return app;
  };
  return { app: restart(), restart, create, retrieve, records, deps, resolver };
}
const arkBody = (model = "seedance-video") => ({
  model,
  content: [{ type: "text", text: "a red kite" }],
  duration: 4,
  resolution: "720p",
  output_format: "mp4",
});
const pollArk = (app: Hono<AppEnv>, id: string) =>
  app.request(`/v1/videos/${id}`, { headers: { Authorization: "Bearer k" } });

describe("Ark video tasks", () => {
  it.each([
    "seedance-video",
    "ark/seedance-2.5",
    "custom/seedance",
    arkModel,
  ])("validates and forwards %s with a public UUID and 7-day owner mapping", async (model) => {
    const { app, create, records } = setupArk();
    const response = await post(app, arkBody(model));
    expect(response.status).toBe(200);
    const data = (await response.json()) as ArkPublicTestBody;
    expect(data.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.request_id).not.toBe("shared-upstream-id");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toEqual({ ...arkBody(model), model: arkModel });
    const row = records.get(`video:${data.request_id}`);
    expect(row).toBeDefined();
    expect((row?.expiresAt ?? 0) - (row?.createdAt ?? 0)).toBe(7 * 86400000);
  });
  it("polls after route restart through the persisted provider/account and original upstream ID", async () => {
    const { app, restart, retrieve, resolver } = setupArk();
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    const response = await pollArk(restart(), request_id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request_id,
      status: "done",
      video: { url: "https://cdn.example.test/movie.mp4" },
    });
    expect(retrieve).toHaveBeenCalledWith("shared-upstream-id", expect.any(AbortSignal));
    expect(resolver.poll).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: "ark-main",
        providerAccount: "account-a",
        providerModel: arkModel,
      }),
    );
  });
  it("rejects another owner or key before upstream polling", async () => {
    const { app, restart, retrieve } = setupArk();
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    for (const who of [
      { ...identity, keyId: "other" },
      { ...identity, accountId: "other" },
    ]) {
      expect(
        (await pollArk(restart({ auth: { resolve: async () => who } }), request_id)).status,
      ).toBe(404);
    }
    expect(retrieve).not.toHaveBeenCalled();
  });
  it("separates repeated provider task IDs by public UUID and fixed provider binding", async () => {
    const { app, records, restart, resolver } = setupArk();
    const first = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    const secondProvider = restart({
      resolver: {
        ...resolver,
        create: async (body, who, operation) => {
          const target = await resolver.create(body, who, operation);
          return target ? { ...target, providerName: "ark-second" } : null;
        },
      },
    });
    const second = (await (await post(secondProvider, arkBody())).json()) as ArkPublicTestBody;
    expect(first.request_id).not.toBe(second.request_id);
    expect(records.has(`video:${first.request_id}`)).toBe(true);
    expect(records.has(`video:${second.request_id}`)).toBe(true);
  });
  it.each([
    "model",
    "id",
    "status",
  ])("fails closed on mismatched/unknown upstream %s", async (field) => {
    const { app, retrieve } = setupArk();
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    retrieve.mockResolvedValue({
      id: "shared-upstream-id",
      model: arkModel,
      status: "succeeded",
      content: { video_url: "https://cdn.example.test/v.mp4" },
      [field]: "wrong",
    });
    const response = await pollArk(app, request_id);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "upstream_error" } });
  });
  it.each([
    "failed",
    "cancelled",
    "expired",
  ])("maps terminal %s without leaking provider error text", async (status) => {
    const { app, retrieve } = setupArk();
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    retrieve.mockResolvedValue({
      id: "shared-upstream-id",
      model: arkModel,
      status,
      error:
        status === "failed"
          ? { code: "SetLimitExceeded", message: "secret-bearer prompt-private" }
          : null,
      content: null,
      usage: null,
    });
    const response = await pollArk(app, request_id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ArkPublicTestBody;
    expect(body.status).toBe(status);
    if (status === "failed") expect(body.error.code).toBe("SetLimitExceeded");
    expect(JSON.stringify(body)).not.toContain("secret-bearer");
    expect(body.video).toBeUndefined();
  });
  it("does not return expired artifact URLs or extend the task's 7-day retention", async () => {
    let now = 1_000_000;
    const { app, retrieve, records } = setupArk({ now: () => now });
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    const expiresAt = records.get(`video:${request_id}`)?.expiresAt;
    now += 25 * 3600000;
    const response = await pollArk(app, request_id);
    expect(await response.json()).toMatchObject({ status: "expired" });
    expect(records.get(`video:${request_id}`)?.expiresAt).toBe(expiresAt);
    now += 7 * 86400000;
    expect((await pollArk(app, request_id)).status).toBe(404);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it("denies spend caps, blocked wire models and invalid frame combinations before create", async () => {
    for (const caps of [{ budget: { spendUsd: 1 } }, { blockedModels: [arkModel] }]) {
      const { app, create } = setupArk({ identity: { ...identity, caps } as MessagesIdentity });
      expect((await post(app, arkBody())).status).toBeGreaterThanOrEqual(400);
      expect(create).not.toHaveBeenCalled();
    }
    const { app, create } = setupArk();
    expect(
      (
        await post(app, {
          ...arkBody(),
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.test/last.png" },
              role: "last_frame",
            },
          ],
        })
      ).status,
    ).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps explicit rejections separate from ambiguous creates without retry", async () => {
    const { UpstreamError } = await import("@helm/core");
    for (const outcome of ["rejected", "unknown"] as const) {
      const { app, create } = setupArk();
      create.mockRejectedValue(
        Object.assign(
          new UpstreamError("upstream_error", "secret", null, outcome === "rejected" ? 429 : 503),
          { outcome },
        ),
      );
      const response = await post(app, arkBody());
      expect(response.status).toBe(outcome === "rejected" ? 429 : 503);
      expect(await response.json()).toMatchObject({
        error: { code: outcome === "rejected" ? "upstream_rejected" : "outcome_unknown" },
      });
      expect(create).toHaveBeenCalledOnce();
    }
  });
});

describe("Ark media boundary regressions", () => {
  it.each([
    {
      ratio: "adaptive",
      content: [
        { type: "text", text: "pan slowly" },
        {
          type: "image_url",
          image_url: { url: "https://input.example.test/first.png" },
          role: "first_frame",
        },
        {
          type: "image_url",
          image_url: { url: "https://input.example.test/last.png" },
          role: "last_frame",
        },
      ],
    },
    {
      omni_reference_task_type: "reference",
      content: [
        { type: "text", text: "combine the references" },
        {
          type: "image_url",
          image_url: { url: "https://input.example.test/i.png" },
          role: "reference_image",
        },
        {
          type: "video_url",
          video_url: { url: "https://input.example.test/v.mp4" },
          role: "reference_video",
        },
        {
          type: "audio_url",
          audio_url: { url: "https://input.example.test/a.wav" },
          role: "reference_audio",
        },
      ],
    },
  ])("preserves pinned frames and mixed reference order through the route", async (changes) => {
    const { app, create } = setupArk();
    const body = { ...arkBody(), ...changes };
    expect((await post(app, body)).status).toBe(200);
    expect(create.mock.calls[0]?.[0]).toEqual({ ...body, model: arkModel });
  });
  it("rejects a stale resolver's provider type/model before polling", async () => {
    const { app, restart, retrieve, resolver } = setupArk();
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    const stale = restart({
      resolver: {
        ...resolver,
        poll: async () => ({ providerType: "ark", providerModel: "wrong", retrieve }),
      },
    });
    expect((await pollArk(stale, request_id)).status).toBe(502);
    expect(retrieve).not.toHaveBeenCalled();
  });
  it("fails closed on tampered persisted provider binding", async () => {
    const { app, records, retrieve } = setupArk();
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    const row = records.get(`video:${request_id}`);
    if (!row) throw new Error("missing mapping");
    row.providerName = "other-provider";
    expect((await pollArk(app, request_id)).status).toBe(502);
    expect(retrieve).not.toHaveBeenCalled();
  });
  it("refuses a newly blocked task model on poll", async () => {
    const { app, restart, retrieve } = setupArk();
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    const blocked = restart({
      auth: {
        resolve: async () =>
          ({ ...identity, caps: { blockedModels: [arkModel] } }) as MessagesIdentity,
      },
    });
    expect((await pollArk(blocked, request_id)).status).toBe(400);
    expect(retrieve).not.toHaveBeenCalled();
  });
  it("returns a safe error when durable lookup fails", async () => {
    const { app, restart, deps, retrieve } = setupArk();
    const { request_id } = (await (await post(app, arkBody())).json()) as ArkPublicTestBody;
    const unavailable = restart({
      registry: {
        ...deps.registry,
        get: async () => {
          throw new Error("secret backend connection");
        },
      },
    });
    const response = await pollArk(unavailable, request_id);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "registry_unavailable" } });
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("Ark lane permissions", () => {
  it.each([
    "ark/seedance-2.5",
    arkModel,
  ])("requires custom-model permission for direct %s", async (name) => {
    const { app, create } = setupArk({
      identity: { ...identity, caps: { allowCustomModel: false } } as MessagesIdentity,
    });
    expect((await post(app, arkBody(name))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects a lane outside allowedLanes, including an empty allowance", async () => {
    for (const allowedLanes of [[], ["balanced"]]) {
      const { app, create } = setupArk({
        identity: {
          ...identity,
          caps: { allowedLanes, allowCustomModel: false },
        } as MessagesIdentity,
      });
      expect((await post(app, arkBody())).status).toBe(403);
      expect(create).not.toHaveBeenCalled();
    }
  });
  it("allows an authorized lane without custom-model permission", async () => {
    const { app, create } = setupArk({
      identity: {
        ...identity,
        caps: { allowedLanes: ["seedance-video"], allowCustomModel: false },
      } as MessagesIdentity,
    });
    expect((await post(app, arkBody())).status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
  });
});
it("keeps the legacy invalid-model boundary when a non-native target is unavailable", async () => {
  const { app } = setup({
    auth: {
      resolve: async () => ({ accountId: "a", keyId: "k", caps: { allowCustomModel: true } }),
    },
    resolver: { create: async () => null, poll: async () => null },
  });
  const response = await post(app, { model: "static/video", prompt: "bird" });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
});
