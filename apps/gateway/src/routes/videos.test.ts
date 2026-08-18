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
      create: async () => ({
        providerAlias: "xai/grok-imagine-video",
        providerName: "xai",
        providerModel: "grok-imagine-video",
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

describe("registerVideosRoute", () => {
  it("rejects missing auth before reservation or create", async () => {
    const { app, create, putIfAbsent } = setup();

    const response = await app.request("/v1/videos/generations", {
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
        model_alias: "xai/grok-imagine-video",
        provider_model: "grok-imagine-video",
        status: "ok",
      },
      serving_account: { provider_id: "xai", account: "oauth-a" },
      cost_breakdown: { total_usd: null },
      provider_attempts: [
        expect.objectContaining({
          alias: "xai/grok-imagine-video",
          provider_name: "xai",
          provider_model: "grok-imagine-video",
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

  it("rejects unverified prompt-only Grok video options before reservation", async () => {
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

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(putIfAbsent).not.toHaveBeenCalled();
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
      caps: { blockedModels: ["xai/grok-imagine-video"] },
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
